/**
 * Minimal planning implementation.
 *
 * The planner prefers provider-backed planning when the active provider
 * advertises supportsPlanning=true. If that path fails or the provider does
 * not support planning, we fall back to a deterministic heuristic plan.
 */

import type { AppState } from "../context.js";
import type { ChatChunk, ChatRequest } from "../../providers/types.js";
import type { Plan, Planner, Task, TaskArtifactKind, VerificationContract, VerificationHint } from "./types.js";

const PLANNER_SYSTEM_PROMPT = `
You are a concise planning assistant for a terminal coding agent.
Convert the user's goal into a small executable plan.

Return ONLY JSON with this shape:
{"goal":"...","tasks":[{"id":"task-1","description":"...","dependsOn":["task-0"]}]}

Rules:
- Produce 1 to 5 tasks.
- Use short imperative task descriptions.
- Keep tasks concrete and actionable.
- Only include dependsOn entries for real task ids in this plan.
- Do not include markdown, prose, or code fences.
`.trim();

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeTaskDescription(text: string): string {
  return normalizeText(text)
    .replace(/^(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/^(?:task|step|goal)\s*[:\-]\s*/i, "")
    .replace(/^(?:please|then|next)\s+/i, "")
    .replace(/[.!?;:]+$/g, "")
    .trim();
}

function normalizeVerificationContract(value: unknown): VerificationContract | undefined {
  const contract = asString(value)?.toLowerCase();
  if (contract === "exit_code" || contract === "artifact" || contract === "assertion") {
    return contract;
  }

  return undefined;
}

function normalizeTaskArtifactKind(value: unknown): TaskArtifactKind | undefined {
  const kind = asString(value)?.toLowerCase();
  if (kind === "summary" || kind === "file" || kind === "path" || kind === "output" || kind === "verification") {
    return kind;
  }

  return undefined;
}

function normalizeVerificationHint(value: unknown): VerificationHint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const rec = value as Record<string, unknown>;
  const contract = normalizeVerificationContract(rec.contract);
  if (!contract) {
    return undefined;
  }

  const expectedExitCode = typeof rec.expectedExitCode === "number" && Number.isFinite(rec.expectedExitCode)
    ? rec.expectedExitCode
    : undefined;

  return {
    contract,
    expectedExitCode,
    artifactKind: normalizeTaskArtifactKind(rec.artifactKind),
    artifactLabel: asString(rec.artifactLabel) ?? undefined,
    assertionText: asString(rec.assertionText) ?? undefined,
    assertionPattern: asString(rec.assertionPattern) ?? undefined,
    assertionTarget:
      rec.assertionTarget === "result" || rec.assertionTarget === "summary" || rec.assertionTarget === "finalText"
        ? rec.assertionTarget
        : undefined,
  };
}

function inferArtifactLabel(description: string): string | undefined {
  const quoted = description.match(/[`'"]([^`'"]+)[`'"]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const pathLike = description.match(/\b(?:\.{0,2}\/)?[\w./-]+\.[a-zA-Z0-9]+\b/);
  if (pathLike?.[0]) {
    return pathLike[0].trim();
  }

  return undefined;
}

function inferVerificationHint(description: string): VerificationHint | undefined {
  const normalized = normalizeTaskDescription(description);
  if (!normalized) {
    return undefined;
  }

  if (/\b(?:run|execute|verify|check)\b.*\b(?:tests?|build|typecheck|lint)\b/i.test(normalized)) {
    return {
      contract: "exit_code",
      expectedExitCode: 0,
    };
  }

  if (/\b(?:ensure|confirm|verify|check)\b.*\b(?:file|path|artifact|directory)\b/i.test(normalized)) {
    const artifactLabel = inferArtifactLabel(normalized);
    return {
      contract: "artifact",
      artifactKind: artifactLabel?.includes(".") ? "file" : "path",
      artifactLabel,
    };
  }

  const assertionMatch = normalized.match(/\b(?:contains?|include|grep for|look for|assert)\b\s+[`'"]?([^`'"]+)[`'"]?/i);
  if (assertionMatch?.[1]) {
    return {
      contract: "assertion",
      assertionText: assertionMatch[1].trim(),
      assertionTarget: "result",
    };
  }

  return undefined;
}

async function collectProviderText(request: ChatRequest, provider: AppState["provider"]): Promise<string> {
  let output = "";

  for await (const chunk of provider.send(request)) {
    if (chunk.type === "text_delta") {
      output += chunk.text;
    }
  }

  return output;
}

function stripCodeFences(text: string): string {
  return text
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .replace(/~~~(?:json)?\s*/gi, "")
    .replace(/~~~/g, "")
    .trim();
}

function extractBalancedObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseJsonCandidate(text: string): unknown | null {
  const cleaned = stripCodeFences(text);
  const candidates = [cleaned, extractBalancedObject(cleaned)].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep trying other candidates.
    }
  }

  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeDependsOn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function makeUniqueTaskId(baseId: string, usedIds: Set<string>, fallbackIndex: number): string {
  const cleaned = normalizeText(baseId) || `task-${fallbackIndex}`;
  let candidate = cleaned;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${cleaned}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

function splitTaskTextIntoClauses(text: string): string[] {
  const normalized = normalizeTaskDescription(text);
  if (!normalized) {
    return [];
  }

  const byLineOrSemicolon = normalized
    .replace(/\r\n/g, "\n")
    .split(/(?:\n+|;)+/g)
    .map((part) => normalizeTaskDescription(part))
    .filter(Boolean);

  if (byLineOrSemicolon.length > 1) {
    return byLineOrSemicolon;
  }

  const byThen = normalized
    .split(/\b(?:and then|then|next)\b/gi)
    .map((part) => normalizeTaskDescription(part))
    .filter(Boolean);

  if (byThen.length > 1) {
    return byThen;
  }

  const byCommaAnd = normalized
    .split(/(?:,|\s+\band\b\s+)/gi)
    .map((part) => normalizeTaskDescription(part))
    .filter(Boolean);

  if (byCommaAnd.length > 1) {
    const wordCounts = byCommaAnd.map((part) => part.split(/\s+/).length);
    const allowSplit = byCommaAnd.length >= 3 ? true : wordCounts.every((count) => count >= 2);
    if (allowSplit) {
      return byCommaAnd;
    }
  }

  return [normalized];
}

function normalizePlanTasks(rawTasks: unknown): Task[] | null {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return null;
  }

  const seeds: Array<{ id: string; description: string; dependsOn: string[]; verificationHint?: VerificationHint }> = [];
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();
  let fallbackIndex = 1;

  rawTasks.forEach((entry, index) => {
    const fallbackId = `task-${index + 1}`;

    if (typeof entry === "string") {
      const description = normalizeTaskDescription(entry);
      if (!description) {
        return;
      }

      const id = makeUniqueTaskId(fallbackId, usedIds, fallbackIndex);
      fallbackIndex += 1;
      const clauses = rawTasks.length === 1 ? splitTaskTextIntoClauses(description) : [description];
      if (clauses.length > 1 && rawTasks.length === 1) {
        let previousId = id;
        clauses.forEach((clause, clauseIndex) => {
          const clauseId = clauseIndex === 0 ? id : makeUniqueTaskId(`${id}-${clauseIndex + 1}`, usedIds, fallbackIndex);
          if (clauseIndex > 0) {
            fallbackIndex += 1;
          }

          seeds.push({
            id: clauseId,
            description: clause,
            dependsOn: clauseIndex === 0 ? [] : [previousId],
            verificationHint: inferVerificationHint(clause),
          });
          previousId = clauseId;
        });
        idMap.set(fallbackId, previousId);
        return;
      }

      seeds.push({ id, description, dependsOn: [], verificationHint: inferVerificationHint(description) });
      return;
    }

    if (!entry || typeof entry !== "object") {
      return;
    }

    const rec = entry as Record<string, unknown>;
    const description = asString(rec.description ?? rec.task ?? rec.prompt ?? rec.title ?? rec.goal);
    if (!description) {
      return;
    }

    const rawId = asString(rec.id) ?? fallbackId;
    const id = makeUniqueTaskId(rawId, usedIds, fallbackIndex);
    fallbackIndex += 1;
    const normalizedDescription = normalizeTaskDescription(description);
    if (!normalizedDescription) {
      return;
    }
    const verificationHint = normalizeVerificationHint(rec.verificationHint) ?? inferVerificationHint(normalizedDescription);

    const clauses = rawTasks.length === 1 ? splitTaskTextIntoClauses(normalizedDescription) : [normalizedDescription];
    if (clauses.length > 1 && rawTasks.length === 1) {
      let previousId = id;
      clauses.forEach((clause, clauseIndex) => {
        const clauseId = clauseIndex === 0 ? id : makeUniqueTaskId(`${id}-${clauseIndex + 1}`, usedIds, fallbackIndex);
        if (clauseIndex > 0) {
          fallbackIndex += 1;
        }

        seeds.push({
          id: clauseId,
          description: clause,
          dependsOn: clauseIndex === 0 ? normalizeDependsOn(rec.dependsOn) : [previousId],
          verificationHint: clauseIndex === 0 ? verificationHint : inferVerificationHint(clause),
        });
        previousId = clauseId;
      });
      idMap.set(rawId, previousId);
      return;
    }

    seeds.push({
      id,
      description: normalizedDescription,
      dependsOn: normalizeDependsOn(rec.dependsOn),
      verificationHint,
    });
    idMap.set(rawId, id);
  });

  if (seeds.length === 0) {
    return null;
  }

  const knownIds = new Set(seeds.map((task) => task.id));
  const tasks = seeds
    .map((task) => {
      const dependsOn = task.dependsOn
        .map((dependencyId) => idMap.get(dependencyId) ?? dependencyId)
        .filter((dependencyId) => dependencyId !== task.id && knownIds.has(dependencyId));

      return {
        id: task.id,
        description: normalizeTaskDescription(task.description),
        dependsOn,
        status: "pending" as const,
        verificationHint: task.verificationHint,
      };
    })
    .filter((task) => task.description.length > 0);

  return tasks.length > 0 ? tasks.slice(0, 5) : null;
}

function normalizeGoal(goal: string): string {
  return normalizeText(goal) || "complete the user's request";
}

function splitGoalIntoClauses(goal: string): string[] {
  const normalized = normalizeGoal(goal);
  const byLineOrSemicolon = normalized
    .replace(/\r\n/g, "\n")
    .split(/(?:\n+|;)+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  if (byLineOrSemicolon.length > 1) {
    return byLineOrSemicolon;
  }

  const byThen = normalized
    .split(/\b(?:and then|then|next)\b/gi)
    .map((part) => part.trim())
    .filter(Boolean);

  if (byThen.length > 1) {
    return byThen;
  }

  const byCommaAnd = normalized
    .split(/(?:,|\s+\band\b\s+)/gi)
    .map((part) => normalizeTaskDescription(part))
    .filter(Boolean);

  if (byCommaAnd.length > 1) {
    const wordCounts = byCommaAnd.map((part) => part.split(/\s+/).length);
    const allowSplit = byCommaAnd.length >= 3 ? true : wordCounts.every((count) => count >= 2);
    if (allowSplit) {
      return byCommaAnd;
    }
  }

  return [normalized];
}

function buildSequentialPlan(goal: string, descriptions: string[]): Plan {
  const tasks: Task[] = descriptions.map((description, index) => ({
    id: `task-${index + 1}`,
    description: normalizeTaskDescription(description),
    dependsOn: index === 0 ? [] : [`task-${index}`],
    status: "pending",
    verificationHint: inferVerificationHint(description),
  }));

  return {
    goal: normalizeGoal(goal),
    tasks,
  };
}

function buildHeuristicPlan(goal: string): Plan {
  const normalizedGoal = normalizeGoal(goal);
  const clauses = splitGoalIntoClauses(normalizedGoal);

  if (clauses.length > 1) {
    return buildSequentialPlan(normalizedGoal, clauses);
  }

  if (/\b(review|inspect|analy[sz]e|test|debug|fix|trace|compare|summarize)\b/i.test(normalizedGoal)) {
    return buildSequentialPlan(normalizedGoal, [
      `Investigate the request: ${normalizedGoal}`,
      `Verify and summarize the result for: ${normalizedGoal}`,
    ]);
  }

  return {
    goal: normalizedGoal,
    tasks: [
      {
        id: "task-1",
        description: normalizedGoal,
        dependsOn: [],
        status: "pending",
        verificationHint: inferVerificationHint(normalizedGoal),
      },
    ],
  };
}

function extractTasksFromBulletList(text: string, goal: string): Plan | null {
  const lines = stripCodeFences(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rawDescriptions = lines
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0);

  if (rawDescriptions.length === 0 || rawDescriptions.length > 5) {
    return null;
  }

  const descriptions = rawDescriptions.length === 1 ? splitTaskTextIntoClauses(rawDescriptions[0]) : rawDescriptions;
  if (descriptions.length === 0 || descriptions.length > 5) {
    return null;
  }

  return buildSequentialPlan(goal, descriptions);
}

function parsePlanFromProviderText(text: string, goal: string): Plan | null {
  const parsed = parseJsonCandidate(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const rawTasks = normalizePlanTasks(rec.tasks);
    if (rawTasks) {
      return {
        goal: asString(rec.goal) ?? normalizeGoal(goal),
        tasks: rawTasks,
      };
    }
  }

  return extractTasksFromBulletList(text, goal);
}

async function tryProviderPlan(goal: string, context: AppState): Promise<Plan | null> {
  if (!context.provider.supportsPlanning) {
    return null;
  }

  const request: ChatRequest = {
    messages: [
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          `Workspace: ${context.cwd}`,
          "Return a compact executable plan as JSON only.",
        ].join("\n"),
      },
    ],
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    temperature: 0.2,
    maxTokens: 512,
  };

  try {
    const text = await collectProviderText(request, context.provider);
    const plan = parsePlanFromProviderText(text, goal);
    if (plan && plan.tasks.length > 0) {
      return plan;
    }
  } catch {
    // Fall back to deterministic planning.
  }

  return null;
}

export class BasicPlanner implements Planner {
  async plan(goal: string, context: AppState): Promise<Plan> {
    const providerPlan = await tryProviderPlan(goal, context);
    if (providerPlan) {
      return providerPlan;
    }

    return buildHeuristicPlan(goal);
  }
}

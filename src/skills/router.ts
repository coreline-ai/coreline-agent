import { listBuiltInSkills, assertBuiltInSkillId, getBuiltInSkill } from "./registry.js";
import {
  BUILT_IN_SKILL_POLICY,
  type BuiltInSkill,
  type BuiltInSkillId,
  type SkillRoutingMode,
  type SkillRoutingTextInput,
  type SkillSelection,
  type SkillSelectionContext,
  type SkillSelectionResult,
  type SkillRouterOptions,
} from "./types.js";
import { registerSkillSelection } from "../agent/self-improve/applied-skill-registry.js";

const DEFAULT_MODE: SkillRoutingMode = "chat";

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeExactBlocks(text: string, blocks: readonly string[] = []): string {
  let result = text;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    result = result.replace(new RegExp(escapeRegExp(trimmed), "g"), " ");
  }
  return result;
}

function stripMarkerBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const startsDropBlock = /^(?:tool result|tool_result|function result|transcript|replay|subagent notification|assistant to=functions|<tool_result|<tool-output|<subagent_notification|BEGIN TOOL RESULT|BEGIN REPLAY)/i.test(trimmed);
    const endsDropBlock = /^(?:END TOOL RESULT|END REPLAY|<\/tool_result>|<\/tool-output>|<\/subagent_notification>)/i.test(trimmed);

    if (startsDropBlock) {
      dropping = true;
      continue;
    }

    if (dropping) {
      if (trimmed === "" || endsDropBlock) dropping = false;
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

export function buildRoutingText(input: string | SkillRoutingTextInput): string {
  const source = typeof input === "string"
    ? input
    : (input.rawText ?? input.displayText ?? input.preparedText ?? "");

  const expandedFileBodies = typeof input === "string" ? [] : (input.expandedFileBodies ?? []);
  const toolResults = typeof input === "string" ? [] : (input.toolResults ?? []);
  const transcriptText = typeof input === "string" ? undefined : input.transcriptText;

  let text = source;
  text = removeExactBlocks(text, expandedFileBodies);
  text = removeExactBlocks(text, toolResults);
  if (transcriptText) text = removeExactBlocks(text, [transcriptText]);

  text = text.replace(/<coreline-attached-files>[\s\S]*?<\/coreline-attached-files>/gi, " ");
  text = text.replace(/<tool_result[\s\S]*?<\/tool_result>/gi, " ");
  text = text.replace(/<tool-results?>[\s\S]*?<\/tool-results?>/gi, " ");
  text = text.replace(/<replay[\s\S]*?<\/replay>/gi, " ");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " ");
  text = text.replace(/^\s*>.*$/gm, " ");
  text = text.replace(/“[^”\n]{1,240}”/g, " ");
  text = text.replace(/‘[^’\n]{1,240}’/g, " ");
  text = text.replace(/"[^"\n]{1,240}"/g, " ");
  text = text.replace(/'[^'\n]{1,240}'/g, " ");
  text = stripMarkerBlocks(text);

  return normalizeWhitespace(text);
}

function modeAllowsAuto(skill: BuiltInSkill, mode: SkillRoutingMode): boolean {
  return skill.autoEnabled && skill.modeConstraints.includes(mode);
}

function toExplicitSelections(ids: readonly (BuiltInSkillId | string)[]): SkillSelection[] {
  const selections: SkillSelection[] = [];
  const seen = new Set<BuiltInSkillId>();

  for (const rawId of ids) {
    const id = assertBuiltInSkillId(rawId);
    if (seen.has(id)) continue;
    seen.add(id);

    const skill = getBuiltInSkill(id)!;
    selections.push({
      skill,
      source: "explicit",
      reasonCode: "explicit",
      priority: skill.priority,
    });
  }

  return selections;
}

function scoreAutoSkills(routingText: string, mode: SkillRoutingMode): SkillSelection[] {
  if (!routingText) return [];

  const candidates: SkillSelection[] = [];

  for (const skill of listBuiltInSkills()) {
    if (!modeAllowsAuto(skill, mode)) continue;

    for (const trigger of skill.triggers) {
      if (trigger.patterns.some((pattern) => pattern.test(routingText))) {
        candidates.push({
          skill,
          source: "auto",
          reasonCode: trigger.reasonCode,
          priority: skill.priority,
        });
        break;
      }
    }
  }

  return candidates.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.skill.id.localeCompare(right.skill.id);
  });
}

function applySelectionLimits(selections: readonly SkillSelection[], options: SkillRouterOptions): SkillSelection[] {
  const maxSelectedSkills = options.maxSelectedSkills ?? BUILT_IN_SKILL_POLICY.maxSelectedSkills;
  const maxTotalPromptChars = options.maxTotalPromptChars ?? BUILT_IN_SKILL_POLICY.maxTotalPromptChars;
  const accepted: SkillSelection[] = [];
  let totalContentChars = 0;
  const seen = new Set<BuiltInSkillId>();

  for (const selection of selections) {
    if (accepted.length >= maxSelectedSkills) break;
    if (seen.has(selection.skill.id)) continue;

    const nextTotal = totalContentChars + selection.skill.content.length;
    if (nextTotal > maxTotalPromptChars) continue;

    accepted.push(selection);
    seen.add(selection.skill.id);
    totalContentChars = nextTotal;
  }

  return accepted;
}

function finalizeSelections(
  context: SkillSelectionContext,
  selections: readonly SkillSelection[],
  options: SkillRouterOptions,
): SkillSelection[] {
  const finalized = applySelectionLimits(selections, options);
  if (context.sessionId) {
    try {
      registerSkillSelection(context.sessionId, finalized);
    } catch {
      // Registry is best-effort; never break skill selection.
    }
  }
  return finalized;
}

export function selectBuiltInSkills(
  context: SkillSelectionContext,
  options: SkillRouterOptions = {},
): SkillSelectionResult {
  const mode = context.mode ?? DEFAULT_MODE;
  const autoSkillsEnabled = context.autoSkillsEnabled ?? true;
  const explicitSelections = toExplicitSelections(context.explicitSkillIds ?? []);
  const routingText = buildRoutingText(context);

  if (!autoSkillsEnabled || context.isRootAgent === false || mode === "sub-agent") {
    return {
      selections: finalizeSelections(context, explicitSelections, options),
      routingText,
      autoSkillsEnabled,
      mode,
    };
  }

  const maxAutoSkills = options.maxAutoSkills ?? BUILT_IN_SKILL_POLICY.defaultMaxAutoSkills;
  const autoSelections = scoreAutoSkills(routingText, mode).slice(0, maxAutoSkills);

  return {
    selections: finalizeSelections(context, [...explicitSelections, ...autoSelections], options),
    routingText,
    autoSkillsEnabled,
    mode,
  };
}

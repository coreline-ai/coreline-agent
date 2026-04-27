import { BUILT_IN_SKILL_CATALOG } from "./catalog.js";
import { BUILT_IN_SKILL_POLICY, type BuiltInSkill, type BuiltInSkillId, type SkillSelection } from "./types.js";

const SKILL_BY_ID = new Map<BuiltInSkillId, BuiltInSkill>(
  BUILT_IN_SKILL_CATALOG.map((skill) => [skill.id, skill]),
);

export function listBuiltInSkills(): readonly BuiltInSkill[] {
  return [...BUILT_IN_SKILL_CATALOG];
}

export function getBuiltInSkill(id: BuiltInSkillId | string): BuiltInSkill | undefined {
  return SKILL_BY_ID.get(id as BuiltInSkillId);
}

export function isBuiltInSkillId(id: string): id is BuiltInSkillId {
  return SKILL_BY_ID.has(id as BuiltInSkillId);
}

export function assertBuiltInSkillId(id: BuiltInSkillId | string): BuiltInSkillId {
  if (!isBuiltInSkillId(id)) {
    throw new Error(`Unknown built-in skill: ${id}`);
  }
  return id;
}

export function validateBuiltInSkillCatalog(skills: readonly BuiltInSkill[] = BUILT_IN_SKILL_CATALOG): void {
  const seen = new Set<string>();

  for (const skill of skills) {
    if (seen.has(skill.id)) throw new Error(`Duplicate built-in skill id: ${skill.id}`);
    seen.add(skill.id);

    if (!skill.title.trim()) throw new Error(`Built-in skill ${skill.id} has an empty title`);
    if (!skill.summary.trim()) throw new Error(`Built-in skill ${skill.id} has an empty summary`);
    if (!skill.content.trim()) throw new Error(`Built-in skill ${skill.id} has empty content`);
    if (skill.content.length > BUILT_IN_SKILL_POLICY.maxTotalPromptChars) {
      throw new Error(`Built-in skill ${skill.id} content exceeds prompt budget`);
    }
    if (skill.triggers.length === 0) throw new Error(`Built-in skill ${skill.id} has no triggers`);
    if (skill.modeConstraints.length === 0) throw new Error(`Built-in skill ${skill.id} has no mode constraints`);
  }
}

export function formatSkillForPrompt(selection: SkillSelection): string {
  return [
    `## ${selection.skill.id}: ${selection.skill.title}`,
    `Source: ${selection.source}`,
    `Reason: ${selection.reasonCode}`,
    selection.skill.content,
  ].join("\n");
}

export function formatSkillForDisplay(id: BuiltInSkillId | string): string {
  const skill = getBuiltInSkill(id);
  if (!skill) return `Unknown built-in skill: ${id}`;

  return [
    `${skill.id} — ${skill.title}`,
    skill.summary,
    `Auto: ${skill.autoEnabled ? "on" : "off"} · Priority: ${skill.priority}`,
  ].join("\n");
}

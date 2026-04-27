export const BUILT_IN_SKILL_POLICY = {
  advisoryOnly: true,
  rootOnlyAutoSelection: true,
  noOverride: true,
  defaultMaxAutoSkills: 1,
  maxSelectedSkills: 3,
  maxTotalPromptChars: 2000,
} as const;

export type BuiltInSkillId = "dev-plan" | "parallel-dev" | "investigate" | "code-review";

export type SkillRoutingMode = "chat" | "one-shot" | "plan" | "goal" | "autopilot" | "sub-agent";

export type SkillSelectionSource = "explicit" | "auto";

export type SkillSelectionReasonCode =
  | "explicit"
  | "kw_dev_plan"
  | "kw_parallel_dev"
  | "kw_investigate"
  | "kw_code_review";

export interface SkillTrigger {
  readonly reasonCode: Exclude<SkillSelectionReasonCode, "explicit">;
  readonly patterns: readonly RegExp[];
}

export interface BuiltInSkill {
  readonly id: BuiltInSkillId;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly triggers: readonly SkillTrigger[];
  readonly priority: number;
  readonly autoEnabled: boolean;
  readonly modeConstraints: readonly SkillRoutingMode[];
}

export interface SkillSelection {
  readonly skill: BuiltInSkill;
  readonly source: SkillSelectionSource;
  readonly reasonCode: SkillSelectionReasonCode;
  readonly priority: number;
}

export interface SkillRoutingTextInput {
  readonly rawText?: string;
  readonly displayText?: string;
  readonly preparedText?: string;
  readonly expandedFileBodies?: readonly string[];
  readonly toolResults?: readonly string[];
  readonly transcriptText?: string;
}

export interface SkillSelectionContext extends SkillRoutingTextInput {
  readonly explicitSkillIds?: readonly (BuiltInSkillId | string)[];
  readonly autoSkillsEnabled?: boolean;
  readonly mode?: SkillRoutingMode;
  readonly isRootAgent?: boolean;
  /** Session id used to register active skills for later evidence recording. */
  readonly sessionId?: string;
}

export interface SkillRouterOptions {
  readonly maxAutoSkills?: number;
  readonly maxSelectedSkills?: number;
  readonly maxTotalPromptChars?: number;
}

export interface SkillSelectionResult {
  readonly selections: readonly SkillSelection[];
  readonly routingText: string;
  readonly autoSkillsEnabled: boolean;
  readonly mode: SkillRoutingMode;
}

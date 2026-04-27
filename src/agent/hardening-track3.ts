/**
 * Hardening Track 3 placeholder contracts.
 *
 * Track 3 features are not implemented here. These exports only reserve stable
 * option names for future context compression, rate limiting, self evaluation,
 * and adaptive prompts so future plans do not collide with existing reliability
 * layer names.
 */

export type {
  HardeningTrack3AdaptivePromptOptions,
  HardeningTrack3ContextCompressionOptions,
  HardeningTrack3Options,
  HardeningTrack3RateLimitOptions,
  HardeningTrack3SelfEvaluationOptions,
} from "./hardening-types.js";

export const HARDENING_TRACK3_FEATURES = [
  "contextCompression",
  "rateLimit",
  "selfEvaluation",
  "adaptivePrompt",
] as const;

export type HardeningTrack3Feature = (typeof HARDENING_TRACK3_FEATURES)[number];

export const DEFAULT_HARDENING_TRACK3_OPTIONS = {
  contextCompression: { enabled: false },
  rateLimit: { enabled: false },
  selfEvaluation: { enabled: false },
  adaptivePrompt: { enabled: false },
} as const;

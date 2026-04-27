/**
 * Memory safety — detects sensitive content that should not be stored
 * in global or project memory entries.
 *
 * The high-confidence rules below are a compact, coreline-agent-shaped
 * subset of coreline-cli's team memory secret scanner. They intentionally
 * use distinctive provider prefixes and never return the matched secret
 * value to callers.
 */

type SecretRuleConfidence = "high" | "legacy";

interface SecretRule {
  /** Stable rule ID used by scanner consumers; never includes matched values. */
  id: string;
  /** Human-readable label safe to show in errors/logs. */
  label: string;
  /** Regex source with capture group #1 around the secret/value span. */
  source: string;
  /** Optional JS regex flags. */
  flags?: string;
  /** High-confidence rules are evaluated before legacy heuristic rules. */
  confidence: SecretRuleConfidence;
}

export interface SecretMatch {
  ruleId: string;
  label: string;
}

export interface SensitiveDetection {
  label: string;
  matched: boolean;
}

interface InternalRuleMatch {
  rule: SecretRule;
  span: [number, number];
}

interface CompiledSecretRule {
  rule: SecretRule;
  scanRe: RegExp;
  redactRe: RegExp;
}

// Assembled to mirror the upstream scanner's pattern style without making
// the prefix a separate reusable constant that callers might log.
const ANTHROPIC_API_KEY_PREFIX = ["sk", "ant", "api"].join("-");

const HIGH_CONFIDENCE_SECRET_RULES: SecretRule[] = [
  // Cloud providers
  {
    id: "aws-access-token",
    label: "AWS access key",
    source: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b",
    confidence: "high",
  },

  // AI APIs
  {
    id: "anthropic-api-key",
    label: "Anthropic API key",
    source: `\\b(${ANTHROPIC_API_KEY_PREFIX}03-[a-zA-Z0-9_-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,
    confidence: "high",
  },
  {
    id: "anthropic-admin-api-key",
    label: "Anthropic admin API key",
    source: "\\b(sk-ant-admin01-[a-zA-Z0-9_-]{93}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    confidence: "high",
  },
  {
    id: "openai-api-key",
    label: "OpenAI API key",
    source:
      "\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    confidence: "high",
  },

  // Version control
  {
    id: "github-pat",
    label: "GitHub personal access token",
    source: "\\b(ghp_[0-9a-zA-Z]{36})\\b",
    confidence: "high",
  },
  {
    id: "github-fine-grained-pat",
    label: "GitHub fine-grained personal access token",
    source: "\\b(github_pat_\\w{82})\\b",
    confidence: "high",
  },
  {
    id: "github-oauth",
    label: "GitHub OAuth token",
    source: "\\b(gho_[0-9a-zA-Z]{36})\\b",
    confidence: "high",
  },
  {
    id: "github-app-token",
    label: "GitHub app token",
    source: "\\b((?:ghu|ghs)_[0-9a-zA-Z]{36})\\b",
    confidence: "high",
  },
  {
    id: "github-refresh-token",
    label: "GitHub refresh token",
    source: "\\b(ghr_[0-9a-zA-Z]{36})\\b",
    confidence: "high",
  },
  {
    id: "gitlab-pat",
    label: "GitLab personal access token",
    source: "\\b(glpat-[\\w-]{20})\\b",
    confidence: "high",
  },
  {
    id: "gitlab-deploy-token",
    label: "GitLab deploy token",
    source: "\\b(gldt-[0-9a-zA-Z_-]{20})\\b",
    confidence: "high",
  },

  // Communication
  {
    id: "slack-bot-token",
    label: "Slack bot token",
    source: "\\b(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)\\b",
    confidence: "high",
  },
  {
    id: "slack-user-token",
    label: "Slack user token",
    source: "\\b(xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34})\\b",
    confidence: "high",
  },
  {
    id: "slack-app-token",
    label: "Slack app token",
    source: "\\b(xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+)\\b",
    flags: "i",
    confidence: "high",
  },

  // Dev tooling
  {
    id: "npm-access-token",
    label: "npm access token",
    source: "\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    confidence: "high",
  },

  // Private keys
  {
    id: "private-key",
    label: "Private key",
    source:
      "(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)",
    flags: "i",
    confidence: "high",
  },
];

// Legacy rules keep the previous memory guard behavior. They are evaluated
// only after high-confidence rules and are skipped when they overlap a
// high-confidence match, so provider-specific labels win.
const LEGACY_SENSITIVE_RULES: SecretRule[] = [
  {
    id: "legacy-anthropic-api-key",
    label: "Anthropic API key",
    source: "(sk-ant-[a-zA-Z0-9_-]{20,})",
    confidence: "legacy",
  },
  {
    id: "legacy-sk-api-key",
    label: "API key (sk-...)",
    source: "(sk-[a-zA-Z0-9_-]{20,})",
    confidence: "legacy",
  },
  {
    id: "legacy-github-pat",
    label: "GitHub personal access token",
    source: "(ghp_[a-zA-Z0-9]{36,})",
    confidence: "legacy",
  },
  {
    id: "legacy-github-oauth-token",
    label: "GitHub OAuth token",
    source: "(gho_[a-zA-Z0-9]{36,})",
    confidence: "legacy",
  },
  {
    id: "legacy-gitlab-pat",
    label: "GitLab personal access token",
    source: "(glpat-[a-zA-Z0-9_-]{20,})",
    confidence: "legacy",
  },
  {
    id: "legacy-slack-bot-token",
    label: "Slack bot token",
    source: "(xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+)",
    confidence: "legacy",
  },
  {
    id: "legacy-slack-user-token",
    label: "Slack user token",
    source: "(xoxp-[0-9]+-[0-9]+-[a-zA-Z0-9]+)",
    confidence: "legacy",
  },
  {
    id: "legacy-private-key-header",
    label: "Private key",
    source: "(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)",
    confidence: "legacy",
  },
  {
    id: "legacy-aws-access-key",
    label: "AWS access key",
    source: "(AKIA[0-9A-Z]{16})",
    confidence: "legacy",
  },
  {
    id: "legacy-jwt-token",
    label: "JWT token",
    source: "(eyJ[a-zA-Z0-9_-]{20,}\\.[a-zA-Z0-9_-]{20,}\\.[a-zA-Z0-9_-]*)",
    confidence: "legacy",
  },
  {
    id: "legacy-password-assignment",
    label: "Password assignment",
    source: "password\\s*[:=]\\s*(['\"][^'\"]{4,}['\"])",
    flags: "i",
    confidence: "legacy",
  },
  {
    id: "legacy-secret-assignment",
    label: "Secret assignment",
    source: "secret\\s*[:=]\\s*(['\"][^'\"]{4,}['\"])",
    flags: "i",
    confidence: "legacy",
  },
  {
    id: "legacy-token-assignment",
    label: "Token assignment",
    source: "token\\s*[:=]\\s*(['\"][^'\"]{8,}['\"])",
    flags: "i",
    confidence: "legacy",
  },
];

const SECRET_RULES = [...HIGH_CONFIDENCE_SECRET_RULES, ...LEGACY_SENSITIVE_RULES];

let compiledRules: CompiledSecretRule[] | null = null;

function buildFlags(flags: string | undefined, extra: string): string {
  const unique = new Set(`${flags ?? ""}${extra}`.split(""));
  return [...unique].join("");
}

function getCompiledRules(): CompiledSecretRule[] {
  compiledRules ??= SECRET_RULES.map((rule) => ({
    rule,
    scanRe: new RegExp(rule.source, buildFlags(rule.flags, "g")),
    redactRe: new RegExp(rule.source, buildFlags(rule.flags, "g")),
  }));
  return compiledRules;
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

function findRuleMatches(content: string, compiled: CompiledSecretRule): InternalRuleMatch[] {
  const matches: InternalRuleMatch[] = [];
  compiled.scanRe.lastIndex = 0;

  for (const match of content.matchAll(compiled.scanRe)) {
    const fullMatch = match[0];
    if (!fullMatch) continue;

    const capturedSecret = match[1] ?? fullMatch;
    const fullStart = match.index ?? 0;
    const offsetInFullMatch = fullMatch.indexOf(capturedSecret);
    const start = fullStart + Math.max(offsetInFullMatch, 0);
    const end = start + capturedSecret.length;

    matches.push({
      rule: compiled.rule,
      span: [start, end],
    });
  }

  return matches;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function ruleIdToLabel(ruleId: string): string {
  const knownRule = SECRET_RULES.find((rule) => rule.id === ruleId);
  if (knownRule) return knownRule.label;

  const specialCase: Record<string, string> = {
    aws: "AWS",
    gcp: "GCP",
    api: "API",
    pat: "PAT",
    ad: "AD",
    tf: "TF",
    oauth: "OAuth",
    npm: "npm",
    pypi: "PyPI",
    jwt: "JWT",
    github: "GitHub",
    gitlab: "GitLab",
    openai: "OpenAI",
    anthropic: "Anthropic",
    slack: "Slack",
  };

  return ruleId
    .split("-")
    .map((part) => specialCase[part] ?? capitalize(part))
    .join(" ");
}

/**
 * Scan a string for potential secrets.
 *
 * Returns one match per rule that fired (deduplicated by rule ID). The
 * actual matched text is intentionally NOT returned — callers receive only
 * stable rule IDs and human-readable labels.
 */
export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seenRuleIds = new Set<string>();
  const highConfidenceSpans: Array<[number, number]> = [];

  for (const compiled of getCompiledRules()) {
    const ruleMatches = findRuleMatches(content, compiled);
    if (ruleMatches.length === 0) continue;

    if (compiled.rule.confidence === "legacy") {
      const hasNonOverlappingLegacyMatch = ruleMatches.some((match) =>
        highConfidenceSpans.every((span) => !rangesOverlap(match.span, span)),
      );
      if (!hasNonOverlappingLegacyMatch) continue;
    } else {
      highConfidenceSpans.push(...ruleMatches.map((match) => match.span));
    }

    if (seenRuleIds.has(compiled.rule.id)) continue;
    seenRuleIds.add(compiled.rule.id);
    matches.push({
      ruleId: compiled.rule.id,
      label: compiled.rule.label,
    });
  }

  return matches;
}

/**
 * Get a human-readable label for a scanner rule ID.
 * Falls back to kebab-to-title conversion for unknown IDs.
 */
export function getSecretLabel(ruleId: string): string {
  return ruleIdToLabel(ruleId);
}

/**
 * Redact any matched secrets in-place with [REDACTED].
 * The surrounding text is preserved where a rule has boundary characters.
 */
export function redactSecrets(content: string): string {
  for (const compiled of getCompiledRules()) {
    compiled.redactRe.lastIndex = 0;
    content = content.replace(compiled.redactRe, (match: string, capturedSecret: string | undefined) => {
      if (typeof capturedSecret === "string" && capturedSecret.length > 0) {
        return match.replace(capturedSecret, "[REDACTED]");
      }
      return "[REDACTED]";
    });
  }
  return content;
}

/**
 * Detect if the given text contains sensitive content.
 * Returns the first match label, or null if safe.
 */
export function detectSensitiveContent(text: string): string | null {
  return scanForSecrets(text)[0]?.label ?? null;
}

/**
 * Check all fields of a memory entry for sensitive content.
 */
export function detectSensitiveMemoryContent(entry: {
  name?: string;
  description?: string;
  body?: string;
}): string | null {
  for (const field of [entry.body, entry.description, entry.name]) {
    if (field) {
      const detected = detectSensitiveContent(field);
      if (detected) return detected;
    }
  }
  return null;
}

/**
 * CostTracker — lightweight per-session model usage cost accounting.
 *
 * Prices are USD per 1M input/output tokens. Unknown models intentionally
 * resolve to zero cost so cost tracking is safe to enable before every custom
 * provider has a pricing entry.
 */

export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  budget?: number;
  budgetRemaining?: number;
  overBudget: boolean;
  hasUnknownPricing: boolean;
  unknownModels: string[];
  models: Record<string, ModelCostSnapshot>;
}

export interface ModelCostSnapshot {
  provider?: string;
  pricingKnown: boolean;
  pricingSource: PricingResolutionSource;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export type PricingResolutionSource =
  | "override-exact"
  | "override-partial"
  | "default-exact"
  | "default-rule"
  | "unknown";

export interface PricingResolution extends ModelPricing {
  known: boolean;
  source: PricingResolutionSource;
  matched?: string;
}

export type PricingOverrides = Record<string, Partial<ModelPricing> | ModelPricing>;

interface PricingRule extends ModelPricing {
  pattern: RegExp;
}

const MILLION = 1_000_000;

export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus": { inputPerMillion: 15, outputPerMillion: 75 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gemini-pro": { inputPerMillion: 1.25, outputPerMillion: 5 },
};

const DEFAULT_RULES: PricingRule[] = [
  { pattern: /claude.*sonnet|sonnet/i, ...DEFAULT_MODEL_PRICING["claude-sonnet"] },
  { pattern: /claude.*opus|opus/i, ...DEFAULT_MODEL_PRICING["claude-opus"] },
  { pattern: /gpt-4o(?!-mini)|\b4o\b/i, ...DEFAULT_MODEL_PRICING["gpt-4o"] },
  { pattern: /gemini(?:[-_\s.]*\d+(?:\.\d+)?)?[-_\s.]*pro|gemini-pro/i, ...DEFAULT_MODEL_PRICING["gemini-pro"] },
];

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeUsage(usage: TokenUsageLike): Required<Pick<TokenUsageLike, "inputTokens" | "outputTokens" | "totalTokens">> {
  const inputTokens = finiteNumber(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = finiteNumber(usage.outputTokens ?? usage.output_tokens);
  const reportedTotal = finiteNumber(usage.totalTokens ?? usage.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
  };
}

function normalizeModel(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase();
}

function normalizeModelKey(model: string | undefined): string {
  return (model ?? "").trim() || "(unknown model)";
}

function completePricing(value: Partial<ModelPricing> | undefined): ModelPricing | undefined {
  if (!value) return undefined;
  const inputPerMillion = finiteNumber(value.inputPerMillion);
  const outputPerMillion = finiteNumber(value.outputPerMillion);
  return { inputPerMillion, outputPerMillion };
}

function createEmptyModelSnapshot(
  pricing: PricingResolution,
  provider?: string,
): ModelCostSnapshot {
  return {
    provider,
    pricingKnown: pricing.known,
    pricingSource: pricing.source,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
  };
}

export function resolveModelPricingInfo(model: string, overrides: PricingOverrides = {}): PricingResolution {
  const normalized = normalizeModel(model);
  const exactOverride = completePricing(overrides[model] ?? overrides[normalized]);
  if (exactOverride) {
    return { ...exactOverride, known: true, source: "override-exact", matched: model };
  }

  for (const [key, override] of Object.entries(overrides)) {
    if (!key) continue;
    const normalizedKey = normalizeModel(key);
    if (normalized.includes(normalizedKey)) {
      const pricing = completePricing(override);
      if (pricing) {
        return { ...pricing, known: true, source: "override-partial", matched: key };
      }
    }
  }

  const defaultExact = DEFAULT_MODEL_PRICING[normalized];
  if (defaultExact) {
    return { ...defaultExact, known: true, source: "default-exact", matched: normalized };
  }

  const rule = DEFAULT_RULES.find((candidate) => candidate.pattern.test(model));
  if (rule) {
    return {
      inputPerMillion: rule.inputPerMillion,
      outputPerMillion: rule.outputPerMillion,
      known: true,
      source: "default-rule",
      matched: rule.pattern.source,
    };
  }

  return { inputPerMillion: 0, outputPerMillion: 0, known: false, source: "unknown" };
}

export function resolveModelPricing(model: string, overrides: PricingOverrides = {}): ModelPricing {
  const { inputPerMillion, outputPerMillion } = resolveModelPricingInfo(model, overrides);
  return { inputPerMillion, outputPerMillion };
}

export function calculateUsageCost(model: string, usage: TokenUsageLike, overrides: PricingOverrides = {}): Pick<ModelCostSnapshot, "inputCost" | "outputCost" | "totalCost"> {
  const normalizedUsage = normalizeUsage(usage);
  const pricing = resolveModelPricingInfo(model, overrides);
  const inputCost = (normalizedUsage.inputTokens / MILLION) * pricing.inputPerMillion;
  const outputCost = (normalizedUsage.outputTokens / MILLION) * pricing.outputPerMillion;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

export function formatCost(cost: number): string {
  const safeCost = finiteNumber(cost);
  if (safeCost > 0 && safeCost < 0.01) return `$${safeCost.toFixed(4)}`;
  return `$${safeCost.toFixed(2)}`;
}

export function formatCostStatus(snapshot: Pick<CostSnapshot, "totalCost" | "budget" | "hasUnknownPricing" | "overBudget">): string {
  const cost = formatCost(snapshot.totalCost);
  const budget = typeof snapshot.budget === "number" ? `/${formatCost(snapshot.budget)}` : "";
  const unknown = snapshot.hasUnknownPricing ? " est?" : "";
  const over = snapshot.overBudget ? " over" : "";
  return `${cost}${budget}${unknown}${over}`;
}

export class CostTracker {
  private budget?: number;
  private readonly modelSnapshots = new Map<string, ModelCostSnapshot>();

  constructor(private readonly pricingOverrides: PricingOverrides = {}) {}

  addUsage(model: string | undefined, usage: TokenUsageLike, metadata: { provider?: string } = {}): CostSnapshot {
    const normalizedModel = normalizeModelKey(model);
    const normalizedUsage = normalizeUsage(usage);
    const pricing = resolveModelPricingInfo(normalizedModel, this.pricingOverrides);
    const costs = calculateUsageCost(normalizedModel, normalizedUsage, this.pricingOverrides);
    const current = this.modelSnapshots.get(normalizedModel) ?? createEmptyModelSnapshot(pricing, metadata.provider);

    current.provider = current.provider ?? metadata.provider;
    if (!current.pricingKnown && pricing.known) {
      current.pricingKnown = true;
      current.pricingSource = pricing.source;
    }
    current.inputTokens += normalizedUsage.inputTokens;
    current.outputTokens += normalizedUsage.outputTokens;
    current.totalTokens += normalizedUsage.totalTokens;
    current.inputCost += costs.inputCost;
    current.outputCost += costs.outputCost;
    current.totalCost += costs.totalCost;

    this.modelSnapshots.set(normalizedModel, current);
    return this.getCost();
  }

  getCost(): CostSnapshot {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let inputCost = 0;
    let outputCost = 0;
    let totalCost = 0;
    const models: Record<string, ModelCostSnapshot> = {};
    const unknownModels: string[] = [];

    for (const [model, snapshot] of this.modelSnapshots.entries()) {
      inputTokens += snapshot.inputTokens;
      outputTokens += snapshot.outputTokens;
      totalTokens += snapshot.totalTokens;
      inputCost += snapshot.inputCost;
      outputCost += snapshot.outputCost;
      totalCost += snapshot.totalCost;
      models[model] = { ...snapshot };
      if (!snapshot.pricingKnown) unknownModels.push(model);
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      inputCost,
      outputCost,
      totalCost,
      budget: this.budget,
      budgetRemaining: typeof this.budget === "number" ? this.budget - totalCost : undefined,
      overBudget: this.isOverBudget(totalCost),
      hasUnknownPricing: unknownModels.length > 0,
      unknownModels,
      models,
    };
  }

  setBudget(budget?: number): void {
    const normalized = finiteNumber(budget);
    this.budget = normalized > 0 ? normalized : undefined;
  }

  isOverBudget(cost = this.getTotalCost()): boolean {
    return typeof this.budget === "number" && cost > this.budget;
  }

  formatCost(cost = this.getTotalCost()): string {
    return formatCost(cost);
  }

  private getTotalCost(): number {
    let total = 0;
    for (const snapshot of this.modelSnapshots.values()) {
      total += snapshot.totalCost;
    }
    return total;
  }
}

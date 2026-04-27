/**
 * StatusBar — displays current model, provider, token usage, permission mode.
 */

import React from "react";
import { Box, Text } from "ink";
import { formatAgentStatusLabel, type AgentStatusSnapshot } from "../agent/status.js";
import { formatCostStatus, type CostSnapshot } from "../agent/cost-tracker.js";
import {
  normalizeModelDisplayName,
  type ProviderQuotaMetadata,
  type ProviderRateLimitMetadata,
  type ProviderRuntimeMetadata,
  type ProviderType,
} from "../providers/types.js";

export interface ProxyStatus {
  url: string;
  providerCount: number;
  isListening: boolean;
}

export interface StatusBarProps {
  providerName: string;
  providerType?: ProviderType | string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  permissionMode: string;
  turnCount: number;
  isLoading: boolean;
  theme?: string;
  mcpStatus?: string;
  proxyStatus?: ProxyStatus;
  agentStatus?: Pick<AgentStatusSnapshot, "status" | "mode">;
  cost?: Pick<CostSnapshot, "totalCost" | "overBudget"> & Partial<Pick<CostSnapshot, "budget" | "hasUnknownPricing">>;
  runtimeTweaks?: string;
  providerMetadata?: ProviderRuntimeMetadata;
  reasoningEffort?: string;
  quota?: ProviderQuotaMetadata;
  rateLimit?: ProviderRateLimitMetadata;
}

export function formatProxyStatusLabel(proxyStatus?: ProxyStatus): string | null {
  if (!proxyStatus) return null;
  if (!proxyStatus.isListening) return "offline";
  return `${proxyStatus.url} (${proxyStatus.providerCount} providers)`;
}

export function formatReasoningEffortLabel(reasoningEffort?: string): string | null {
  const effort = reasoningEffort?.trim();
  return effort ? `r:${effort}` : null;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatQuotaStatusLabel(
  quota?: ProviderQuotaMetadata,
  rateLimit?: ProviderRateLimitMetadata,
): string | null {
  if (quota?.remaining !== undefined && quota.limit !== undefined) {
    return `quota:${formatCount(quota.remaining)}/${formatCount(quota.limit)}`;
  }
  if (quota?.remaining !== undefined) {
    return `quota:${formatCount(quota.remaining)}`;
  }
  if (rateLimit?.remainingRequests !== undefined && rateLimit.limitRequests !== undefined) {
    return `rl:${formatCount(rateLimit.remainingRequests)}/${formatCount(rateLimit.limitRequests)}r`;
  }
  if (rateLimit?.remainingRequests !== undefined) {
    return `rl:${formatCount(rateLimit.remainingRequests)}r`;
  }
  if (rateLimit?.remainingTokens !== undefined) {
    return `rl:${formatCount(rateLimit.remainingTokens)}tok`;
  }
  return null;
}

export function formatProviderModelLabel(input: {
  providerName: string;
  providerType?: ProviderType | string;
  model: string;
  providerMetadata?: ProviderRuntimeMetadata;
}): { provider: string; model: string } {
  const provider = input.providerName.trim() || "(unknown provider)";
  const metadata = input.providerMetadata;
  return {
    provider,
    model: metadata?.modelDisplayName ?? normalizeModelDisplayName(
      metadata?.providerType ?? input.providerType,
      metadata?.model ?? input.model,
    ),
  };
}

export function StatusBar({
  providerName,
  providerType,
  model,
  inputTokens,
  outputTokens,
  permissionMode,
  turnCount,
  isLoading,
  theme = "default",
  mcpStatus,
  proxyStatus,
  agentStatus,
  cost,
  runtimeTweaks,
  providerMetadata,
  reasoningEffort,
  quota,
  rateLimit,
}: StatusBarProps) {
  const totalTokens = inputTokens + outputTokens;
  const tokenStr = totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}k` : "0";
  const proxyLabel = formatProxyStatusLabel(proxyStatus);
  const agentStatusLabel = formatAgentStatusLabel(agentStatus);
  const costLabel = cost
    ? formatCostStatus({
      totalCost: cost.totalCost,
      budget: cost.budget,
      overBudget: cost.overBudget,
      hasUnknownPricing: cost.hasUnknownPricing ?? false,
    })
    : null;
  const { provider, model: displayModel } = formatProviderModelLabel({
    providerName,
    providerType,
    model,
    providerMetadata,
  });
  const reasoningLabel = formatReasoningEffortLabel(
    reasoningEffort ?? providerMetadata?.reasoningEffort ?? providerMetadata?.config?.reasoningEffort,
  );
  const quotaLabel = formatQuotaStatusLabel(
    quota ?? providerMetadata?.quota,
    rateLimit ?? providerMetadata?.rateLimit,
  );
  const quotaDisplay = quotaLabel
    ? {
      label: quotaLabel.startsWith("rl:") ? "rate:" : "quota:",
      value: quotaLabel.replace(/^quota:/, "").replace(/^rl:/, ""),
    }
    : null;

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
    >
      <Box gap={1}>
        <Text color="cyan" bold>{provider}</Text>
        <Text dimColor>|</Text>
        <Text color="yellow">{displayModel}</Text>
        {reasoningLabel && (
          <>
            <Text dimColor>|</Text>
            <Text color="yellow">{reasoningLabel}</Text>
          </>
        )}
      </Box>

      <Box gap={1}>
        {isLoading && <Text color="magenta">●</Text>}
        <Text dimColor>tokens:</Text>
        <Text color="green">{tokenStr}</Text>
        {costLabel && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>cost:</Text>
            <Text color={cost?.overBudget ? "red" : "green"}>{costLabel}</Text>
          </>
        )}
        {quotaDisplay && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>{quotaDisplay.label}</Text>
            <Text color="cyan">{quotaDisplay.value}</Text>
          </>
        )}
        <Text dimColor>|</Text>
        <Text dimColor>turns:</Text>
        <Text>{String(turnCount)}</Text>
        <Text dimColor>|</Text>
        <Text dimColor>mode:</Text>
        <Text color={permissionMode === "acceptAll" ? "red" : "white"}>
          {permissionMode}
        </Text>
        <Text dimColor>|</Text>
        <Text dimColor>theme:</Text>
        <Text color={theme === "dark" ? "magenta" : theme === "light" ? "yellow" : "white"}>
          {theme}
        </Text>
        {agentStatusLabel && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>agent:</Text>
            <Text color={agentStatus?.status === "blocked" || agentStatus?.status === "failed" ? "red" : agentStatus?.status === "needs_user" ? "yellow" : agentStatus?.status === "running" || agentStatus?.status === "planning" ? "magenta" : "green"}>
              {agentStatusLabel}
            </Text>
          </>
        )}
        {runtimeTweaks && runtimeTweaks !== "runtime tweaks: default" && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>tweaks:</Text>
            <Text color="yellow">{runtimeTweaks.replace(/^runtime tweaks:\s*/, "")}</Text>
          </>
        )}
        {proxyLabel && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>proxy:</Text>
            <Text color={proxyStatus?.isListening ? "cyan" : "red"}>
              {proxyLabel}
            </Text>
          </>
        )}
        {mcpStatus && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>mcp:</Text>
            <Text color={mcpStatus === "invalid" ? "red" : mcpStatus === "none" || mcpStatus === "disabled" ? "yellow" : "cyan"}>
              {mcpStatus}
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

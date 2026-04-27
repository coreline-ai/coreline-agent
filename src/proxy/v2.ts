/**
 * Proxy v2 contracts — capabilities document + batch envelope.
 *
 * Kept intentionally small so the server can expose a stable discovery
 * surface without coupling tests to the full proxy implementation.
 */

import { z } from "zod";
import type { ProviderRegistry } from "../providers/types.js";

export type ProxyEndpointCategory =
  | "health"
  | "providers"
  | "capabilities"
  | "batch"
  | "status"
  | "messages";

export interface ProxyEndpointCapability {
  method: string;
  path: string;
  category: ProxyEndpointCategory;
  streaming: boolean;
  description: string;
}

export interface ProxyProviderCapability {
  name: string;
  type: string;
  model: string;
  default: boolean;
  capabilities: {
    toolCalling: boolean;
    streaming: boolean;
    planning: boolean;
    batch: boolean;
  };
}

export interface ProxyCapabilitiesDocument {
  type: "proxy_capabilities";
  version: "v2";
  defaultProvider: string | null;
  proxy: {
    auth: {
      required: boolean;
    };
    requestTracing: boolean;
    batch: {
      supported: true;
      maxItems: number;
      maxConcurrency: number;
      timeoutMs: number;
      streaming: false;
    };
    capabilities: true;
    humanInputMode: {
      supported: boolean;
      policy: "return-or-forbid" | "not-supported";
    };
    status: {
      supported: boolean;
      path: string;
    };
  };
  endpoints: ProxyEndpointCapability[];
  providers: ProxyProviderCapability[];
}

export const PROXY_V2_ENDPOINTS: ProxyEndpointCapability[] = [
  {
    method: "GET",
    path: "/health",
    category: "health",
    streaming: false,
    description: "Liveness check and provider inventory",
  },
  {
    method: "GET",
    path: "/v1/providers",
    category: "providers",
    streaming: false,
    description: "Registered provider inventory",
  },
  {
    method: "GET",
    path: "/v2/capabilities",
    category: "capabilities",
    streaming: false,
    description: "Proxy capability discovery document",
  },
  {
    method: "GET",
    path: "/v1/capabilities",
    category: "capabilities",
    streaming: false,
    description: "Proxy capability discovery document alias",
  },

  {
    method: "GET",
    path: "/v2/status",
    category: "status",
    streaming: false,
    description: "Current agent status snapshot for local dashboards",
  },
  {
    method: "GET",
    path: "/v1/status",
    category: "status",
    streaming: false,
    description: "Current agent status snapshot alias",
  },
  {
    method: "POST",
    path: "/v2/batch",
    category: "batch",
    streaming: false,
    description: "Batch multiple proxy requests into one envelope",
  },
  {
    method: "POST",
    path: "/v1/batch",
    category: "batch",
    streaming: false,
    description: "Batch multiple proxy requests into one envelope alias",
  },
  {
    method: "POST",
    path: "/anthropic/v1/messages",
    category: "messages",
    streaming: true,
    description: "Anthropic Messages API compatibility",
  },
  {
    method: "POST",
    path: "/v1/messages",
    category: "messages",
    streaming: true,
    description: "Anthropic Messages API compatibility alias",
  },
  {
    method: "POST",
    path: "/openai/v1/chat/completions",
    category: "messages",
    streaming: true,
    description: "OpenAI Chat Completions compatibility",
  },
  {
    method: "POST",
    path: "/v1/chat/completions",
    category: "messages",
    streaming: true,
    description: "OpenAI Chat Completions compatibility alias",
  },
  {
    method: "POST",
    path: "/openai/v1/responses",
    category: "messages",
    streaming: true,
    description: "OpenAI Responses compatibility",
  },
  {
    method: "POST",
    path: "/v1/responses",
    category: "messages",
    streaming: true,
    description: "OpenAI Responses compatibility alias",
  },
];

export function buildProxyCapabilities(
  registry: Pick<ProviderRegistry, "listProviders" | "getProvider" | "getDefault">,
  options?: {
    authRequired?: boolean;
    requestTracing?: boolean;
    batchLimit?: number;
    batchConcurrency?: number;
    batchTimeoutMs?: number;
    status?: boolean;
  },
): ProxyCapabilitiesDocument {
  const defaultName = safeGetDefaultName(registry);
  const providers = registry.listProviders().map((name) => {
    const provider = registry.getProvider(name);
    return {
      name,
      type: provider.type,
      model: provider.model,
      default: name === defaultName,
      capabilities: {
        toolCalling: provider.supportsToolCalling,
        streaming: provider.supportsStreaming,
        planning: provider.supportsPlanning,
        batch: true,
      },
    };
  });

  return {
    type: "proxy_capabilities",
    version: "v2",
    defaultProvider: defaultName,
    proxy: {
      auth: {
        required: options?.authRequired ?? false,
      },
      requestTracing: options?.requestTracing ?? true,
      batch: {
        supported: true,
        maxItems: options?.batchLimit ?? 8,
        maxConcurrency: options?.batchConcurrency ?? 4,
        timeoutMs: options?.batchTimeoutMs ?? 30_000,
        streaming: false,
      },
      capabilities: true,
      humanInputMode: {
        supported: true,
        policy: "return-or-forbid",
      },
      status: {
        supported: options?.status ?? true,
        path: "/v2/status",
      },
    },
    endpoints: PROXY_V2_ENDPOINTS,
    providers,
  };
}

function safeGetDefaultName(
  registry: Pick<ProviderRegistry, "getDefault">,
): string | null {
  try {
    return registry.getDefault().name;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batch request/response contracts
// ---------------------------------------------------------------------------

const BatchRequestItemSchema = z.object({
  id: z.string().min(1).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  path: z.string().min(1).refine((value) => value.startsWith("/"), {
    message: "path must start with /",
  }),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

export const ProxyBatchRequestSchema = z.object({
  requests: z.array(BatchRequestItemSchema).min(1),
});

export type ProxyBatchRequest = z.infer<typeof ProxyBatchRequestSchema>;
export type ProxyBatchRequestItem = z.infer<typeof BatchRequestItemSchema>;

export interface ProxyBatchItemResult {
  id?: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  requestId?: string;
  body: unknown;
}

export interface ProxyBatchResponse {
  type: "batch_response";
  count: number;
  requestId?: string;
  results: ProxyBatchItemResult[];
}

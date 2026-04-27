import { commandHookDisabledResult, executeCommandHook } from "./executors/command.js";
import { executeFunctionHook } from "./executors/function.js";
import { executeHttpHook } from "./executors/http.js";
import { matchesHook } from "./matchers.js";
import type {
  CommandHookConfig,
  FunctionHookConfig,
  HookConfig,
  HookEventName,
  HookExecutionContext,
  HookInput,
  HookResult,
  HttpHookConfig,
} from "./types.js";

export interface HookEngineOptions {
  idPrefix?: string;
  /** Internal opt-in only. Command hooks remain disabled by default. */
  enableCommandHooks?: boolean;
}

export class HookEngine {
  private readonly hooks = new Map<string, HookConfig & { id: string }>();
  private nextId = 1;
  private readonly idPrefix: string;
  private readonly enableCommandHooks: boolean;

  constructor(options: HookEngineOptions = {}) {
    this.idPrefix = options.idPrefix ?? "hook";
    this.enableCommandHooks = options.enableCommandHooks ?? false;
  }

  register(config: HookConfig): string {
    const id = config.id ?? `${this.idPrefix}-${this.nextId++}`;
    this.hooks.set(id, { ...config, id } as HookConfig & { id: string });
    return id;
  }

  unregister(id: string): boolean {
    return this.hooks.delete(id);
  }

  getHooks(): HookConfig[] {
    return [...this.hooks.values()].map((hook) => ({ ...hook }));
  }

  async execute(
    event: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
    context?: HookExecutionContext,
  ): Promise<HookResult[]> {
    const normalizedInput = input.event === event ? input : { ...input, event } as HookInput;
    const matched = [...this.hooks.values()].filter((hook) => matchesHook(hook, normalizedInput));
    const results = await Promise.all(matched.map((hook) => this.executeOne(hook, normalizedInput, signal, context)));
    for (const hook of matched) {
      if (hook.once) this.hooks.delete(hook.id);
    }
    return results;
  }

  private async executeOne(
    hook: HookConfig & { id: string },
    input: HookInput,
    signal?: AbortSignal,
    context?: HookExecutionContext,
  ): Promise<HookResult> {
    if (hook.type === "function") {
      return executeFunctionHook(hook as FunctionHookConfig & { id: string }, input, signal);
    }
    if (hook.type === "http") {
      return executeHttpHook(hook as HttpHookConfig & { id: string }, input, signal);
    }
    if (hook.type === "command") {
      if (!this.enableCommandHooks) {
        return commandHookDisabledResult(hook as CommandHookConfig & { id: string });
      }
      return executeCommandHook(hook as CommandHookConfig & { id: string }, input, signal, context);
    }
    const unsupported = hook as HookConfig & { id: string };
    return {
      hookId: unsupported.id,
      hookName: unsupported.name,
      type: unsupported.type,
      blocking: false,
      durationMs: 0,
      error: `unsupported hook type: ${unsupported.type}`,
    };
  }
}

export function createHookEngine(options?: HookEngineOptions): HookEngine {
  return new HookEngine(options);
}

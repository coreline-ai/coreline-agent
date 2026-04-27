import { z } from "zod";
import { buildTool } from "../types.js";
import type { ToolResult, ToolUseContext } from "../types.js";

export const TodoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const TodoItemSchema = z.object({
  content: z.string().trim().min(1).max(500).describe("Concise todo item content"),
  status: TodoStatusSchema.describe("Current todo status"),
  activeForm: z.string().trim().min(1).max(500).describe("Present-tense form to show while this todo is active"),
});

export const TodoWriteInputSchema = z.object({
  todos: z
    .array(TodoItemSchema)
    .max(100)
    .describe("Complete replacement list for the current session todos"),
});

export type TodoStatus = z.infer<typeof TodoStatusSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

export interface TodoWriteStore {
  get(key: string): readonly TodoItem[] | undefined;
  set(key: string, todos: readonly TodoItem[]): void;
  clear(key: string): void;
}

interface TodoWriteContextExtension {
  /** Optional explicit todo state key supplied by the agent loop/session layer. */
  todoStateKey?: string;
  /** Optional session id used to isolate todo state when no explicit key is supplied. */
  sessionId?: string;
  /** Optional root/child agent id used to isolate todo state when no explicit key is supplied. */
  agentId?: string;
  /** Optional store owned by the agent loop/session layer. */
  todoStore?: TodoWriteStore;
}

export interface TodoWriteCounts {
  pending: number;
  in_progress: number;
  completed: number;
  total: number;
}

export type TodoWriteClearReason = "all_completed" | "empty_input";

export type TodoWriteOutput =
  | {
      status: "updated";
      stateKey: string;
      todos: TodoItem[];
      counts: TodoWriteCounts;
      previousCount: number;
    }
  | {
      status: "cleared";
      stateKey: string;
      todos: [];
      counts: TodoWriteCounts;
      previousCount: number;
      clearReason: TodoWriteClearReason;
    };

class InMemoryTodoWriteStore implements TodoWriteStore {
  private readonly map = new Map<string, TodoItem[]>();

  get(key: string): TodoItem[] | undefined {
    const todos = this.map.get(key);
    return todos ? cloneTodos(todos) : undefined;
  }

  set(key: string, todos: readonly TodoItem[]): void {
    this.map.set(key, cloneTodos(todos));
  }

  clear(key: string): void {
    this.map.delete(key);
  }

  clearAll(): void {
    this.map.clear();
  }
}

const fallbackTodoStore = new InMemoryTodoWriteStore();

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function asContextExtension(context: ToolUseContext): TodoWriteContextExtension {
  return context as ToolUseContext & TodoWriteContextExtension;
}

export function resetFallbackTodoWriteStore(): void {
  fallbackTodoStore.clearAll();
}

export function resolveTodoStateKey(context: ToolUseContext): string {
  const extended = asContextExtension(context);
  if (extended.todoStateKey?.trim()) {
    return extended.todoStateKey.trim();
  }

  const root = extended.sessionId?.trim()
    ? `session:${extended.sessionId.trim()}`
    : `cwd:${context.cwd}`;
  const agent = extended.agentId?.trim()
    ? `agent:${extended.agentId.trim()}`
    : `depth:${context.agentDepth ?? 0}`;

  return `${root}|${agent}`;
}

export function getTodoWriteStore(context: ToolUseContext): TodoWriteStore {
  return asContextExtension(context).todoStore ?? fallbackTodoStore;
}

export function readStoredTodosForContext(context: ToolUseContext): TodoItem[] {
  return cloneTodos(getTodoWriteStore(context).get(resolveTodoStateKey(context)) ?? []);
}

function countTodos(todos: readonly TodoItem[]): TodoWriteCounts {
  const counts: TodoWriteCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    total: todos.length,
  };

  for (const todo of todos) {
    counts[todo.status] += 1;
  }

  return counts;
}

function shouldClearTodos(todos: readonly TodoItem[]): TodoWriteClearReason | null {
  if (todos.length === 0) {
    return "empty_input";
  }
  return todos.every((todo) => todo.status === "completed") ? "all_completed" : null;
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case "pending": return "[ ]";
    case "in_progress": return "[~]";
    case "completed": return "[x]";
  }
}

function formatCounts(counts: TodoWriteCounts): string {
  return `total=${counts.total} pending=${counts.pending} in_progress=${counts.in_progress} completed=${counts.completed}`;
}

export const TodoWriteTool = buildTool<TodoWriteInput, TodoWriteOutput>({
  name: "TodoWrite",
  description:
    "Replace the current session todo checklist. Each todo has content, status, and activeForm. " +
    "When every submitted todo is completed, the active todo list is cleared.",
  maxResultSizeChars: 20_000,

  inputSchema: TodoWriteInputSchema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async call(input, context): Promise<ToolResult<TodoWriteOutput>> {
    const store = getTodoWriteStore(context);
    const stateKey = resolveTodoStateKey(context);
    const previousCount = store.get(stateKey)?.length ?? 0;
    const todos = cloneTodos(input.todos);
    const counts = countTodos(todos);
    const clearReason = shouldClearTodos(todos);

    if (clearReason) {
      store.clear(stateKey);
      return {
        data: {
          status: "cleared",
          stateKey,
          todos: [],
          counts,
          previousCount,
          clearReason,
        },
      };
    }

    store.set(stateKey, todos);
    return {
      data: {
        status: "updated",
        stateKey,
        todos,
        counts,
        previousCount,
      },
    };
  },

  formatResult(output): string {
    if (output.status === "cleared") {
      const summary = output.clearReason === "all_completed"
        ? "all submitted todos were completed; active todo list cleared"
        : "empty todo list submitted; active todo list cleared";
      return [
        "TODO_WRITE_RESULT",
        "status: cleared",
        `state_key: ${output.stateKey}`,
        `previous_count: ${output.previousCount}`,
        `submitted_counts: ${formatCounts(output.counts)}`,
        `summary: ${summary}`,
        "",
        "No active todos.",
      ].join("\n");
    }

    return [
      "TODO_WRITE_RESULT",
      "status: updated",
      `state_key: ${output.stateKey}`,
      `previous_count: ${output.previousCount}`,
      `counts: ${formatCounts(output.counts)}`,
      "",
      "TODOS_START",
      ...output.todos.map((todo, index) => (
        `${index + 1}. ${statusMarker(todo.status)} ${todo.content}\n` +
        `   status: ${todo.status}\n` +
        `   active_form: ${todo.activeForm}`
      )),
      "TODOS_END",
    ].join("\n");
  },
});

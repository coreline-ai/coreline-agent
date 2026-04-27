import { beforeEach, describe, expect, test } from "bun:test";
import {
  TodoWriteTool,
  readStoredTodosForContext,
  resetFallbackTodoWriteStore,
  resolveTodoStateKey,
  type TodoItem,
  type TodoWriteStore,
} from "../src/tools/todo-write/todo-write-tool.js";
import type { ToolUseContext } from "../src/tools/types.js";

class MapTodoStore implements TodoWriteStore {
  readonly map = new Map<string, TodoItem[]>();

  get(key: string): TodoItem[] | undefined {
    const todos = this.map.get(key);
    return todos?.map((todo) => ({ ...todo }));
  }

  set(key: string, todos: readonly TodoItem[]): void {
    this.map.set(key, todos.map((todo) => ({ ...todo })));
  }

  clear(key: string): void {
    this.map.delete(key);
  }
}

type TestTodoContext = ToolUseContext & {
  todoStore?: TodoWriteStore;
  todoStateKey?: string;
  sessionId?: string;
  agentId?: string;
};

function makeContext(extra: Partial<TestTodoContext> = {}): TestTodoContext {
  return {
    cwd: "/tmp/coreline-todo-test",
    abortSignal: new AbortController().signal,
    nonInteractive: true,
    agentDepth: 0,
    ...extra,
  };
}

beforeEach(() => {
  resetFallbackTodoWriteStore();
});

describe("TodoWriteTool schema", () => {
  test("accepts content/status/activeForm todo items", () => {
    const parsed = TodoWriteTool.inputSchema.safeParse({
      todos: [
        { content: "Implement tool", status: "in_progress", activeForm: "Implementing tool" },
        { content: "Run tests", status: "pending", activeForm: "Running tests" },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  test("rejects invalid statuses and missing activeForm", () => {
    const invalidStatus = TodoWriteTool.inputSchema.safeParse({
      todos: [{ content: "Investigate", status: "blocked", activeForm: "Investigating" }],
    });
    const missingActiveForm = TodoWriteTool.inputSchema.safeParse({
      todos: [{ content: "Investigate", status: "pending" }],
    });

    expect(invalidStatus.success).toBe(false);
    expect(missingActiveForm.success).toBe(false);
  });
});

describe("TodoWriteTool call and formatResult", () => {
  test("stores a replacement todo list in a context-provided store", async () => {
    const store = new MapTodoStore();
    const context = makeContext({ todoStore: store, todoStateKey: "session-a|root" });

    const result = await TodoWriteTool.call(
      {
        todos: [
          { content: "Implement TodoWrite", status: "in_progress", activeForm: "Implementing TodoWrite" },
          { content: "Verify TodoWrite", status: "pending", activeForm: "Verifying TodoWrite" },
        ],
      },
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(result.data.status).toBe("updated");
    expect(result.data.counts).toMatchObject({ total: 2, pending: 1, in_progress: 1, completed: 0 });
    expect(store.get("session-a|root")?.map((todo) => todo.content)).toEqual([
      "Implement TodoWrite",
      "Verify TodoWrite",
    ]);

    const formatted = TodoWriteTool.formatResult(result.data, "todo-1");
    expect(formatted).toContain("TODO_WRITE_RESULT");
    expect(formatted).toContain("status: updated");
    expect(formatted).toContain("Implement TodoWrite");
    expect(formatted).toContain("active_form: Implementing TodoWrite");
  });

  test("clears the stored list when all submitted todos are completed", async () => {
    const store = new MapTodoStore();
    const context = makeContext({ todoStore: store, todoStateKey: "session-a|root" });

    await TodoWriteTool.call(
      { todos: [{ content: "Ship", status: "pending", activeForm: "Shipping" }] },
      context,
    );
    expect(store.get("session-a|root")).toHaveLength(1);

    const result = await TodoWriteTool.call(
      { todos: [{ content: "Ship", status: "completed", activeForm: "Shipping" }] },
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(result.data.status).toBe("cleared");
    expect(result.data.previousCount).toBe(1);
    expect(store.get("session-a|root")).toBeUndefined();

    const formatted = TodoWriteTool.formatResult(result.data, "todo-2");
    expect(formatted).toContain("status: cleared");
    expect(formatted).toContain("all submitted todos were completed");
    expect(formatted).toContain("No active todos");
  });

  test("supports module-level fallback state when no context store is supplied", async () => {
    const context = makeContext({ sessionId: "fallback-session", agentDepth: 1 });

    const result = await TodoWriteTool.call(
      { todos: [{ content: "Use fallback", status: "pending", activeForm: "Using fallback" }] },
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(result.data.stateKey).toBe(resolveTodoStateKey(context));
    expect(readStoredTodosForContext(context)).toEqual([
      { content: "Use fallback", status: "pending", activeForm: "Using fallback" },
    ]);
  });

  test("empty todos input clears the active list", async () => {
    const store = new MapTodoStore();
    const context = makeContext({ todoStore: store, todoStateKey: "session-clear" });

    await TodoWriteTool.call(
      { todos: [{ content: "Temporary", status: "pending", activeForm: "Working" }] },
      context,
    );

    const result = await TodoWriteTool.call({ todos: [] }, context);

    expect(result.data.status).toBe("cleared");
    expect(result.data.clearReason).toBe("empty_input");
    expect(store.get("session-clear")).toBeUndefined();
  });
});

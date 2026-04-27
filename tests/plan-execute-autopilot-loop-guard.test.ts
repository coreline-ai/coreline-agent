import { describe, expect, test } from "bun:test";
import { createAutopilotLoopGuard } from "../src/agent/plan-execute/autopilot-loop-guard.js";

describe("autopilot loop guard", () => {
  test("detects repeated failures for the same active task", () => {
    const guard = createAutopilotLoopGuard({ repeatedFailureLimit: 2, repeatedTailLimit: 10, noProgressLimit: 10 });

    expect(guard.check({
      cycle: 1,
      summary: { completed: 0, failed: 1, ambiguous: 0 },
      status: "failed",
      activeTaskId: "task-1",
      failureReason: "timeout",
      tailTaskIds: ["task-1"],
    }).triggered).toBe(false);

    const decision = guard.check({
      cycle: 2,
      summary: { completed: 0, failed: 1, ambiguous: 0 },
      status: "failed",
      activeTaskId: "task-1",
      failureReason: "timeout",
      tailTaskIds: ["task-1"],
    });

    expect(decision.triggered).toBe(true);
    expect(decision.kind).toBe("repeated_failure");
    expect(decision.suggestedStatus).toBe("blocked");
  });

  test("detects repeated remaining task tails", () => {
    const guard = createAutopilotLoopGuard({ repeatedFailureLimit: 10, repeatedTailLimit: 2, noProgressLimit: 10 });

    expect(guard.check({
      cycle: 1,
      summary: { completed: 1, failed: 0, ambiguous: 1 },
      status: "running",
      activeTaskId: "task-2",
      tailTaskIds: ["task-2", "task-3"],
    }).triggered).toBe(false);

    const decision = guard.check({
      cycle: 2,
      summary: { completed: 1, failed: 0, ambiguous: 1 },
      status: "running",
      activeTaskId: "task-2",
      tailTaskIds: ["task-2", "task-3"],
    });

    expect(decision.triggered).toBe(true);
    expect(decision.kind).toBe("repeated_tail");
  });

  test("does not fire when progress changes between cycles", () => {
    const guard = createAutopilotLoopGuard({ repeatedFailureLimit: 10, repeatedTailLimit: 10, noProgressLimit: 2 });

    expect(guard.check({
      cycle: 1,
      summary: { completed: 0, failed: 0, ambiguous: 1 },
      status: "running",
      activeTaskId: "task-1",
      tailTaskIds: ["task-1", "task-2"],
    }).triggered).toBe(false);

    const decision = guard.check({
      cycle: 2,
      summary: { completed: 1, failed: 0, ambiguous: 0 },
      status: "running",
      activeTaskId: "task-2",
      tailTaskIds: ["task-2"],
    });

    expect(decision.triggered).toBe(false);
  });
});

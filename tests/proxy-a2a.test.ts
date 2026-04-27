import { describe, expect, test } from "bun:test";
import { handleA2ARequest, handleA2ATaskSendRequest } from "../src/proxy/a2a.js";
import { validateAgentCard, validateA2ATaskResponse } from "../src/proxy/platform-types.js";

describe("A2A gateway pure handlers", () => {
  test("GET /.well-known/agent.json returns a valid agent card", async () => {
    const response = await handleA2ARequest(new Request("http://proxy.local/.well-known/agent.json"));

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.json();
    expect(validateAgentCard(body)).toBe(true);
    expect(body.endpoints.some((entry: any) => entry.path === "/a2a/tasks/send")).toBe(true);
    expect(body.capabilities.taskExecution).toBe("adapter-only");
  });

  test("POST /a2a/tasks/send defaults to disabled adapter boundary", async () => {
    const response = await handleA2ARequest(
      new Request("http://proxy.local/a2a/tasks/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "task-1", input: "review this" }),
      }),
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(validateA2ATaskResponse(body)).toBe(true);
    expect(body.status).toBe("disabled");
    expect(body.taskId).toBe("task-1");
    expect(body.reason).toBe("execution_disabled");
  });

  test("POST /a2a/tasks/send supports accepted and rejected adapter results", async () => {
    const accepted = await handleA2ATaskSendRequest(
      new Request("http://proxy.local/a2a/tasks/send", {
        method: "POST",
        body: JSON.stringify({ id: "task-2", input: [{ role: "user", content: "hello" }] }),
      }),
      {
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        taskAdapter: () => ({ status: "accepted", metadata: { queue: "local" } }),
      },
    );
    const acceptedBody = await accepted.json();
    expect(accepted.status).toBe(202);
    expect(acceptedBody.status).toBe("accepted");
    expect(acceptedBody.acceptedAt).toBe("2026-04-19T00:00:00.000Z");
    expect(acceptedBody.metadata.queue).toBe("local");

    const rejected = await handleA2ATaskSendRequest(
      new Request("http://proxy.local/a2a/tasks/send", {
        method: "POST",
        body: JSON.stringify({ taskId: "task-3", input: "no" }),
      }),
      { taskAdapter: () => ({ status: "rejected", reason: "policy" }) },
    );
    const rejectedBody = await rejected.json();
    expect(rejected.status).toBe(400);
    expect(rejectedBody.status).toBe("rejected");
    expect(rejectedBody.reason).toBe("policy");
  });

  test("invalid task payload is rejected without executing adapter", async () => {
    let called = false;
    const response = await handleA2ATaskSendRequest(
      new Request("http://proxy.local/a2a/tasks/send", {
        method: "POST",
        body: JSON.stringify({ taskId: "bad", input: [] }),
      }),
      { taskAdapter: () => { called = true; return { status: "accepted" }; } },
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    const body = await response.json();
    expect(body.status).toBe("rejected");
    expect(body.reason).toBe("schema_validation_failed");
  });
});

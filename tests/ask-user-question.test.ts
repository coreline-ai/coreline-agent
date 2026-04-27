import { describe, expect, test } from "bun:test";
import {
  AskUserQuestionTool,
  normalizeAskUserQuestionAnswers,
  type AskUserQuestionHandler,
} from "../src/tools/ask-user-question/ask-user-question-tool.js";
import { buildAskUserQuestionResponse } from "../src/tui/ask-user-question-prompt.js";
import type { ToolUseContext } from "../src/tools/types.js";

type TestAskContext = ToolUseContext & {
  askUserQuestion?: AskUserQuestionHandler;
};

function makeContext(extra: Partial<TestAskContext> = {}): TestAskContext {
  return {
    cwd: "/tmp/coreline-ask-test",
    abortSignal: new AbortController().signal,
    nonInteractive: false,
    ...extra,
  };
}

const validInput = {
  questions: [
    {
      question: "Which implementation path should Worker D use?",
      options: [
        { label: "Minimal", description: "Only owned paths" },
        { label: "Integrated", description: "Also wire the loop" },
      ],
    },
    {
      question: "Run typecheck after tests?",
      options: [
        { label: "Yes" },
        { label: "No" },
      ],
    },
  ],
};

describe("AskUserQuestionTool schema", () => {
  test("accepts one to three questions with two to four unique options", () => {
    const parsed = AskUserQuestionTool.inputSchema.safeParse(validInput);

    expect(parsed.success).toBe(true);
  });

  test("rejects more than three questions", () => {
    const parsed = AskUserQuestionTool.inputSchema.safeParse({
      questions: [
        { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
        { question: "Q2", options: [{ label: "A" }, { label: "B" }] },
        { question: "Q3", options: [{ label: "A" }, { label: "B" }] },
        { question: "Q4", options: [{ label: "A" }, { label: "B" }] },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  test("rejects duplicate question text and duplicate option labels", () => {
    const duplicateQuestion = AskUserQuestionTool.inputSchema.safeParse({
      questions: [
        { question: "Same?", options: [{ label: "Yes" }, { label: "No" }] },
        { question: " same? ", options: [{ label: "A" }, { label: "B" }] },
      ],
    });
    const duplicateOption = AskUserQuestionTool.inputSchema.safeParse({
      questions: [
        { question: "Pick one", options: [{ label: "Yes" }, { label: " yes " }] },
      ],
    });

    expect(duplicateQuestion.success).toBe(false);
    expect(duplicateOption.success).toBe(false);
  });

  test("rejects questions with fewer than two options", () => {
    const parsed = AskUserQuestionTool.inputSchema.safeParse({
      questions: [{ question: "Pick one", options: [{ label: "Only" }] }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("AskUserQuestionTool call and formatResult", () => {
  test("is read-only and marked concurrency-safe", () => {
    expect(AskUserQuestionTool.isReadOnly(validInput)).toBe(true);
    expect(AskUserQuestionTool.isConcurrencySafe(validInput)).toBe(true);
  });

  test("fails safely in non-interactive mode", async () => {
    const result = await AskUserQuestionTool.call(
      validInput,
      makeContext({ nonInteractive: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.data.status).toBe("error");
    if (result.data.status === "error") {
      expect(result.data.reason).toBe("non_interactive");
    }

    const formatted = AskUserQuestionTool.formatResult(result.data, "ask-1");
    expect(formatted).toContain("ASK_USER_QUESTION_RESULT");
    expect(formatted).toContain("reason: non_interactive");
  });

  test("fails safely when no interactive handler is wired", async () => {
    const result = await AskUserQuestionTool.call(validInput, makeContext());

    expect(result.isError).toBe(true);
    expect(result.data.status).toBe("error");
    if (result.data.status === "error") {
      expect(result.data.reason).toBe("handler_unavailable");
    }
  });

  test("calls the interactive handler and formats selected answers", async () => {
    const seenQuestions: string[] = [];
    const context = makeContext({
      askUserQuestion: async (request) => {
        seenQuestions.push(...request.questions.map((question) => question.question));
        return {
          answers: [
            { questionIndex: 0, selectedLabel: "Minimal" },
            { questionIndex: 1, optionIndex: 0 },
          ],
        };
      },
    });

    const result = await AskUserQuestionTool.call(validInput, context);

    expect(result.isError).toBeUndefined();
    expect(result.data.status).toBe("answered");
    if (result.data.status === "answered") {
      expect(result.data.answers.map((answer) => answer.selectedLabel)).toEqual(["Minimal", "Yes"]);
    }
    expect(seenQuestions).toEqual(validInput.questions.map((question) => question.question));

    const formatted = AskUserQuestionTool.formatResult(result.data, "ask-2");
    expect(formatted).toContain("status: answered");
    expect(formatted).toContain("Which implementation path should Worker D use?");
    expect(formatted).toContain("answer: Minimal");
    expect(formatted).toContain("answer: Yes");
  });

  test("returns an invalid_response error for bad handler answers", async () => {
    const result = await AskUserQuestionTool.call(
      validInput,
      makeContext({
        askUserQuestion: () => ({
          answers: [{ questionIndex: 0, selectedLabel: "Missing option" }],
        }),
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.data.status).toBe("error");
    if (result.data.status === "error") {
      expect(result.data.reason).toBe("invalid_response");
    }
  });

  test("normalizes TUI helper responses", () => {
    const response = buildAskUserQuestionResponse(validInput.questions, [1, 0]);
    const normalized = normalizeAskUserQuestionAnswers(validInput.questions, response.answers);

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.answers.map((answer) => answer.selectedLabel)).toEqual(["Integrated", "Yes"]);
    }
  });
});

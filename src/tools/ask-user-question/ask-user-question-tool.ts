import { z } from "zod";
import { buildTool } from "../types.js";
import type { ToolResult, ToolUseContext } from "../types.js";

const NORMALIZED_LABEL_COLLATOR_OPTIONS: Intl.CollatorOptions = {
  sensitivity: "accent",
  usage: "search",
};

export const AskUserQuestionOptionSchema = z.object({
  label: z.string().trim().min(1).max(80).describe("Unique option label for this question"),
  description: z.string().trim().min(1).max(240).optional().describe("Optional short explanation of the option"),
});

export const AskUserQuestionQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500).describe("Question to ask the user"),
  options: z
    .array(AskUserQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe("Two to four mutually exclusive options"),
}).superRefine((question, ctx) => {
  const seen = new Set<string>();
  for (const [index, option] of question.options.entries()) {
    const normalized = normalizeQuestionLabel(option.label);
    if (seen.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", index, "label"],
        message: "Option labels must be unique within each question.",
      });
    }
    seen.add(normalized);
  }
});

export const AskUserQuestionInputSchema = z.object({
  questions: z
    .array(AskUserQuestionQuestionSchema)
    .min(1)
    .max(3)
    .describe("One to three multiple-choice questions"),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  for (const [index, question] of input.questions.entries()) {
    const normalized = normalizeQuestionLabel(question.question);
    if (seen.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions", index, "question"],
        message: "Question text must be unique within a request.",
      });
    }
    seen.add(normalized);
  }
});

export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOptionSchema>;
export type AskUserQuestionQuestion = z.infer<typeof AskUserQuestionQuestionSchema>;
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

export interface AskUserQuestionAnswerInput {
  questionIndex: number;
  selectedLabel?: string;
  optionIndex?: number;
}

export interface AskUserQuestionAnswer {
  questionIndex: number;
  question: string;
  optionIndex: number;
  selectedLabel: string;
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestionQuestion[];
}

export interface AskUserQuestionResponse {
  answers: AskUserQuestionAnswerInput[];
  cancelled?: boolean;
}

export type AskUserQuestionHandler = (
  request: AskUserQuestionRequest,
) => Promise<AskUserQuestionResponse> | AskUserQuestionResponse;

interface AskUserQuestionContextExtension {
  askUserQuestion?: AskUserQuestionHandler;
}

export type AskUserQuestionErrorReason =
  | "non_interactive"
  | "handler_unavailable"
  | "cancelled"
  | "invalid_response"
  | "handler_error";

export type AskUserQuestionOutput =
  | {
      status: "answered";
      questions: AskUserQuestionQuestion[];
      answers: AskUserQuestionAnswer[];
    }
  | {
      status: "error";
      reason: AskUserQuestionErrorReason;
      message: string;
      questions: AskUserQuestionQuestion[];
    };

export type NormalizeAskUserQuestionAnswersResult =
  | { ok: true; answers: AskUserQuestionAnswer[] }
  | { ok: false; message: string };

function normalizeQuestionLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function labelsEqual(a: string, b: string): boolean {
  return normalizeQuestionLabel(a).localeCompare(
    normalizeQuestionLabel(b),
    undefined,
    NORMALIZED_LABEL_COLLATOR_OPTIONS,
  ) === 0;
}

function contextHandler(context: ToolUseContext): AskUserQuestionHandler | undefined {
  return (context as ToolUseContext & AskUserQuestionContextExtension).askUserQuestion;
}

function errorOutput(
  reason: AskUserQuestionErrorReason,
  message: string,
  questions: AskUserQuestionQuestion[],
): ToolResult<AskUserQuestionOutput> {
  return {
    data: {
      status: "error",
      reason,
      message,
      questions,
    },
    isError: true,
  };
}

export function normalizeAskUserQuestionAnswers(
  questions: readonly AskUserQuestionQuestion[],
  answers: readonly AskUserQuestionAnswerInput[],
): NormalizeAskUserQuestionAnswersResult {
  if (answers.length !== questions.length) {
    return {
      ok: false,
      message: `Expected ${questions.length} answer(s), received ${answers.length}.`,
    };
  }

  const seenQuestionIndexes = new Set<number>();
  const normalized: AskUserQuestionAnswer[] = [];

  for (const answer of answers) {
    if (!Number.isInteger(answer.questionIndex) || answer.questionIndex < 0 || answer.questionIndex >= questions.length) {
      return { ok: false, message: `Invalid questionIndex: ${answer.questionIndex}.` };
    }

    if (seenQuestionIndexes.has(answer.questionIndex)) {
      return { ok: false, message: `Duplicate answer for questionIndex ${answer.questionIndex}.` };
    }
    seenQuestionIndexes.add(answer.questionIndex);

    const question = questions[answer.questionIndex];
    if (!question) {
      return { ok: false, message: `Question not found for index ${answer.questionIndex}.` };
    }

    let optionIndex = answer.optionIndex;
    if (optionIndex !== undefined && (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length)) {
      return { ok: false, message: `Invalid optionIndex ${optionIndex} for questionIndex ${answer.questionIndex}.` };
    }

    if (answer.selectedLabel !== undefined) {
      const labelIndex = question.options.findIndex((option) => labelsEqual(option.label, answer.selectedLabel ?? ""));
      if (labelIndex === -1) {
        return {
          ok: false,
          message: `Selected label "${answer.selectedLabel}" is not an option for questionIndex ${answer.questionIndex}.`,
        };
      }
      if (optionIndex !== undefined && optionIndex !== labelIndex) {
        return {
          ok: false,
          message: `selectedLabel and optionIndex disagree for questionIndex ${answer.questionIndex}.`,
        };
      }
      optionIndex = labelIndex;
    }

    if (optionIndex === undefined) {
      return { ok: false, message: `Missing selectedLabel or optionIndex for questionIndex ${answer.questionIndex}.` };
    }

    const option = question.options[optionIndex];
    if (!option) {
      return { ok: false, message: `Option not found for questionIndex ${answer.questionIndex}.` };
    }

    normalized.push({
      questionIndex: answer.questionIndex,
      question: question.question,
      optionIndex,
      selectedLabel: option.label,
    });
  }

  normalized.sort((a, b) => a.questionIndex - b.questionIndex);
  return { ok: true, answers: normalized };
}

export const AskUserQuestionTool = buildTool<AskUserQuestionInput, AskUserQuestionOutput>({
  name: "AskUserQuestion",
  description:
    "Ask the user one to three structured multiple-choice questions. " +
    "Each question must have two to four unique option labels. Fails safely in non-interactive sessions.",
  maxResultSizeChars: 12_000,

  inputSchema: AskUserQuestionInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, context): Promise<ToolResult<AskUserQuestionOutput>> {
    if (context.nonInteractive) {
      return errorOutput(
        "non_interactive",
        "AskUserQuestion requires an interactive TUI/user-input handler, but this session is non-interactive.",
        input.questions,
      );
    }

    const handler = contextHandler(context);
    if (!handler) {
      return errorOutput(
        "handler_unavailable",
        "AskUserQuestion is not wired to an interactive user-input handler in this session.",
        input.questions,
      );
    }

    let response: AskUserQuestionResponse;
    try {
      response = await handler({ questions: input.questions.map((question) => ({
        question: question.question,
        options: question.options.map((option) => ({ ...option })),
      })) });
    } catch (error) {
      return errorOutput(
        "handler_error",
        `AskUserQuestion handler failed: ${(error as Error).message}`,
        input.questions,
      );
    }

    if (response.cancelled) {
      return errorOutput("cancelled", "User cancelled the structured question prompt.", input.questions);
    }

    const normalized = normalizeAskUserQuestionAnswers(input.questions, response.answers);
    if (!normalized.ok) {
      return errorOutput("invalid_response", normalized.message, input.questions);
    }

    return {
      data: {
        status: "answered",
        questions: input.questions,
        answers: normalized.answers,
      },
    };
  },

  formatResult(output): string {
    if (output.status === "error") {
      return [
        "ASK_USER_QUESTION_RESULT",
        "status: error",
        `reason: ${output.reason}`,
        `message: ${output.message}`,
      ].join("\n");
    }

    return [
      "ASK_USER_QUESTION_RESULT",
      "status: answered",
      `answer_count: ${output.answers.length}`,
      "",
      "ANSWERS_START",
      ...output.answers.map((answer) => [
        `${answer.questionIndex + 1}. ${answer.question}`,
        `   answer: ${answer.selectedLabel}`,
        `   option_index: ${answer.optionIndex}`,
      ].join("\n")),
      "ANSWERS_END",
    ].join("\n");
  },
});

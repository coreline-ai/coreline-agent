/**
 * AskUserQuestionPrompt — Ink prompt for structured multiple-choice questions.
 *
 * Integration note: this component is intentionally standalone. The agent loop
 * should route an AskUserQuestion request to this prompt and resolve the tool's
 * askUserQuestion context handler with the selected answers.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  AskUserQuestionAnswer,
  AskUserQuestionQuestion,
  AskUserQuestionResponse,
} from "../tools/ask-user-question/ask-user-question-tool.js";

export interface AskUserQuestionPromptProps {
  questions: AskUserQuestionQuestion[];
  onResolve: (answers: AskUserQuestionAnswer[]) => void;
  onCancel?: () => void;
}

export function buildAskUserQuestionAnswers(
  questions: readonly AskUserQuestionQuestion[],
  selectedOptionIndexes: readonly number[],
): AskUserQuestionAnswer[] {
  return questions.map((question, questionIndex) => {
    const optionIndex = selectedOptionIndexes[questionIndex];
    if (optionIndex === undefined || optionIndex < 0 || optionIndex >= question.options.length) {
      throw new Error(`Missing selected option for question ${questionIndex + 1}.`);
    }
    const option = question.options[optionIndex];
    if (!option) {
      throw new Error(`Invalid selected option for question ${questionIndex + 1}.`);
    }
    return {
      questionIndex,
      question: question.question,
      optionIndex,
      selectedLabel: option.label,
    };
  });
}

export function buildAskUserQuestionResponse(
  questions: readonly AskUserQuestionQuestion[],
  selectedOptionIndexes: readonly number[],
): AskUserQuestionResponse {
  return {
    answers: buildAskUserQuestionAnswers(questions, selectedOptionIndexes),
  };
}

export function formatAskUserQuestionPromptSummary(questions: readonly AskUserQuestionQuestion[]): string {
  return `${questions.length} question${questions.length === 1 ? "" : "s"}; use ↑/↓ or 1-4, Enter to choose, Esc to cancel`;
}

function clampOptionIndex(index: number, optionCount: number): number {
  return Math.max(0, Math.min(optionCount - 1, index));
}

export function AskUserQuestionPrompt({
  questions,
  onResolve,
  onCancel,
}: AskUserQuestionPromptProps) {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [cursorOptionIndex, setCursorOptionIndex] = useState(0);
  const [selectedOptionIndexes, setSelectedOptionIndexes] = useState<number[]>(() =>
    questions.map(() => -1),
  );
  const [resolved, setResolved] = useState(false);

  const currentQuestion = questions[currentQuestionIndex];

  const resolveSelection = (optionIndex: number) => {
    if (resolved || !currentQuestion) return;

    const nextSelected = [...selectedOptionIndexes];
    nextSelected[currentQuestionIndex] = optionIndex;
    setSelectedOptionIndexes(nextSelected);

    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((prev) => prev + 1);
      const nextQuestion = questions[currentQuestionIndex + 1];
      setCursorOptionIndex(clampOptionIndex(nextSelected[currentQuestionIndex + 1] ?? 0, nextQuestion?.options.length ?? 1));
      return;
    }

    setResolved(true);
    onResolve(buildAskUserQuestionAnswers(questions, nextSelected));
  };

  useInput((input, key) => {
    if (resolved || !currentQuestion) return;

    if (key.escape) {
      setResolved(true);
      onCancel?.();
      return;
    }

    if (key.upArrow) {
      setCursorOptionIndex((prev) => clampOptionIndex(prev - 1, currentQuestion.options.length));
      return;
    }

    if (key.downArrow) {
      setCursorOptionIndex((prev) => clampOptionIndex(prev + 1, currentQuestion.options.length));
      return;
    }

    if (key.return) {
      resolveSelection(cursorOptionIndex);
      return;
    }

    if (/^[1-4]$/u.test(input)) {
      const optionIndex = Number.parseInt(input, 10) - 1;
      if (optionIndex < currentQuestion.options.length) {
        setCursorOptionIndex(optionIndex);
        resolveSelection(optionIndex);
      }
    }
  });

  if (!currentQuestion) {
    return null;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box gap={1}>
        <Text color="cyan" bold>Question</Text>
        <Text dimColor>{formatAskUserQuestionPromptSummary(questions)}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {questions.map((question, questionIndex) => {
          const isCurrent = questionIndex === currentQuestionIndex;
          const selected = selectedOptionIndexes[questionIndex];
          return (
            <Box key={question.question} flexDirection="column" marginBottom={1}>
              <Text color={isCurrent ? "cyan" : "white"} bold={isCurrent}>
                {questionIndex + 1}. {question.question}
              </Text>
              {question.options.map((option, optionIndex) => {
                const isCursor = isCurrent && optionIndex === cursorOptionIndex;
                const isSelected = selected === optionIndex;
                return (
                  <Box key={option.label} paddingLeft={2} gap={1}>
                    <Text color={isCursor ? "cyan" : isSelected ? "green" : "white"}>
                      {isCursor ? "▸" : isSelected ? "✓" : " "}
                    </Text>
                    <Text color={isCursor ? "cyan" : isSelected ? "green" : "white"} bold={isCursor}>
                      [{optionIndex + 1}] {option.label}
                    </Text>
                    {option.description && <Text dimColor>{option.description}</Text>}
                  </Box>
                );
              })}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        {resolved ? (
          <Text dimColor>(resolved)</Text>
        ) : (
          <Text>
            <Text color="cyan" bold>Enter</Text><Text> select</Text>
            <Text dimColor> · </Text>
            <Text color="cyan" bold>Esc</Text><Text> cancel</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * PromptInput — multiline text input with history.
 */

import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./theme/context.js";

export interface PromptInputProps {
  onSubmit: (text: string) => void;
  isDisabled?: boolean;
  placeholder?: string;
  history?: string[];
  insertText?: string;
  insertKey?: number;
}

export function isPromptSubmitKey(key: { return?: boolean; shift?: boolean }): boolean {
  return Boolean(key.return) && !key.shift;
}

export function formatPromptDisplayText(value: string, placeholder: string): string {
  return `${value || placeholder}▊`;
}

export function PromptInput({
  onSubmit,
  isDisabled = false,
  placeholder = "Message...",
  history = [],
  insertText,
  insertKey,
}: PromptInputProps) {
  const [value, setValue] = useState("");
  const [historyIdx, setHistoryIdx] = useState(-1);

  useEffect(() => {
    if (insertText !== undefined) {
      setValue(insertText);
      setHistoryIdx(-1);
    }
  }, [insertText, insertKey]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
    setHistoryIdx(-1);
  }, [value, onSubmit]);

  useInput(
    (input, key) => {
      if (isDisabled) return;

      // Shift+Enter → newline, Enter → submit
      if (key.return) {
        if (key.shift) {
          setValue((prev) => `${prev}\n`);
          return;
        }
        handleSubmit();
        return;
      }

      // Up arrow → history
      if (key.upArrow && history.length > 0) {
        const nextIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(nextIdx);
        setValue(history[nextIdx] ?? "");
        return;
      }

      // Down arrow → forward history
      if (key.downArrow) {
        if (historyIdx <= 0) {
          setHistoryIdx(-1);
          setValue("");
        } else {
          const nextIdx = historyIdx - 1;
          setHistoryIdx(nextIdx);
          setValue(history[nextIdx] ?? "");
        }
        return;
      }

      // Backspace
      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        return;
      }

      // Regular character
      if (input && !key.ctrl && !key.meta) {
        setValue((prev) => prev + input);
      }
    },
    { isActive: !isDisabled },
  );

  const t = useTheme();
  const displayText = formatPromptDisplayText(value, placeholder);

  return (
    <Box paddingX={1}>
      <Text color={t.user} bold>{"❯ "}</Text>
      {value ? <Text>{displayText}</Text> : <Text dimColor>{displayText}</Text>}
    </Box>
  );
}

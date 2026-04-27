/**
 * ReasoningOutput — displays model reasoning/thinking in a distinct style.
 */

import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme/context.js";

export interface ReasoningOutputProps {
  text: string;
  isActive: boolean;
  show: boolean;
}

const MAX_LINES = 10; // limit display height during streaming

export function ReasoningOutput({ text, isActive, show }: ReasoningOutputProps) {
  const t = useTheme();
  if (!show || !text) return null;

  const lines = text.split("\n");
  const displayed = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
  const truncated = lines.length > MAX_LINES;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor={t.border}
      marginY={0}
    >
      <Box>
        <Text color={t.muted} dimColor>{"💭 Reasoning"}</Text>
        {isActive && <Text color={t.warning}> ●</Text>}
      </Box>
      <Box flexDirection="column">
        {truncated && <Text dimColor italic>... ({lines.length - MAX_LINES} more lines above)</Text>}
        {displayed.map((line, i) => (
          <Text key={i} dimColor italic>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}

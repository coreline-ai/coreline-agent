/**
 * ReasoningOutput — displays model reasoning/thinking in a distinct style.
 */

import React from "react";
import { Box, Text } from "ink";

export interface ReasoningOutputProps {
  text: string;
  isActive: boolean;
  show: boolean;
}

const MAX_LINES = 10; // limit display height during streaming

export function ReasoningOutput({ text, isActive, show }: ReasoningOutputProps) {
  if (!show || !text) return null;

  const lines = text.split("\n");
  const displayed = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
  const truncated = lines.length > MAX_LINES;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor="gray"
      marginY={0}
    >
      <Box>
        <Text color="gray" dimColor>{"💭 Reasoning"}</Text>
        {isActive && <Text color="yellow"> ●</Text>}
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

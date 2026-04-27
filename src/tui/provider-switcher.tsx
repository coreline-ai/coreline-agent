/**
 * ProviderSwitcher — overlay for selecting a provider (Ctrl+P).
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface ProviderSwitcherProps {
  providers: string[];
  currentProvider: string;
  onSelect: (name: string) => void;
  onClose: () => void;
}

export function ProviderSwitcher({
  providers,
  currentProvider,
  onSelect,
  onClose,
}: ProviderSwitcherProps) {
  const [selectedIdx, setSelectedIdx] = useState(
    Math.max(0, providers.indexOf(currentProvider)),
  );

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      const selected = providers[selectedIdx];
      if (selected) {
        onSelect(selected);
      }
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIdx((prev) => Math.min(providers.length - 1, prev + 1));
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">Switch Provider (Esc to cancel)</Text>
      <Box flexDirection="column" marginTop={1}>
        {providers.map((name, idx) => {
          const isSelected = idx === selectedIdx;
          const isCurrent = name === currentProvider;
          return (
            <Box key={name} gap={1}>
              <Text color={isSelected ? "cyan" : "white"}>
                {isSelected ? "▸" : " "}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? "cyan" : "white"}
              >
                {name}
              </Text>
              {isCurrent && <Text dimColor>(current)</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

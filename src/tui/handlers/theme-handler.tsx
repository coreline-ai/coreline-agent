/**
 * Theme picker handler — interactive ↑/↓ theme selector rendered in REPL.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { THEMES } from "../theme/registry.js";
import { useTheme } from "../theme/context.js";

export interface ThemePickerProps {
  onSelect: (themeId: string) => void;
  onCancel: () => void;
}

export function ThemePicker({ onSelect, onCancel }: ThemePickerProps) {
  const t = useTheme();
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((prev) => (prev <= 0 ? THEMES.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((prev) => (prev >= THEMES.length - 1 ? 0 : prev + 1));
      return;
    }
    if (key.return) {
      const selected = THEMES[cursor];
      if (selected) onSelect(selected.id);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text color={t.primary} bold>Select Theme</Text>
        <Text dimColor>  ↑/↓ navigate · Enter select · Esc cancel</Text>
      </Box>
      {THEMES.map((theme, i) => (
        <Box key={theme.id} gap={2}>
          <Text color={i === cursor ? t.primary : t.muted}>
            {i === cursor ? "▶ " : "  "}
            {theme.id.padEnd(22)}
          </Text>
          <Text dimColor>{theme.name}</Text>
        </Box>
      ))}
    </Box>
  );
}

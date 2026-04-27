/**
 * TUI theme system tests — registry, runtime singleton, slash command parser.
 * TC-1 through TC-12 per implement_20260427_090000.md.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { THEMES, getTheme, DEFAULT_THEME_ID } from "../src/tui/theme/registry.js";
import { themeRuntime } from "../src/tui/theme/runtime.js";
import { handleThemeCommand } from "../src/tui/commands/theme.js";
import { handleSlashCommand } from "../src/tui/slash-commands.js";

// ---------------------------------------------------------------------------
// TC-1: Registry contains 10 themes with required fields
// ---------------------------------------------------------------------------
describe("Theme registry", () => {
  test("TC-1: exports 10 themes with required fields", () => {
    expect(THEMES).toHaveLength(10);
    for (const theme of THEMES) {
      expect(typeof theme.id).toBe("string");
      expect(theme.id.length).toBeGreaterThan(0);
      expect(typeof theme.name).toBe("string");
      expect(typeof theme.isDark).toBe("boolean");
      expect(typeof theme.palette.primaryAccent).toBe("string");
      expect(typeof theme.palette.background).toBe("string");
      expect(typeof theme.palette.foreground).toBe("string");
      expect(typeof theme.palette.secondaryAccent).toBe("string");
      expect(typeof theme.palette.alert).toBe("string");
      expect(typeof theme.palette.success).toBe("string");
    }
  });

  test("TC-2: DEFAULT_THEME_ID is 'default' and is in registry", () => {
    expect(DEFAULT_THEME_ID).toBe("default");
    const def = getTheme(DEFAULT_THEME_ID);
    expect(def.id).toBe("default");
  });

  test("TC-3: getTheme falls back to first theme for unknown id", () => {
    const def = getTheme("nonexistent-theme-xyz");
    expect(def).toBeDefined();
    expect(def.id).toBe(THEMES[0]!.id);
  });

  test("TC-4: all theme ids are unique", () => {
    const ids = THEMES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(THEMES.length);
  });

  test("TC-5: catppuccin-latte is a light theme, others are dark", () => {
    const latte = THEMES.find((t) => t.id === "catppuccin-latte");
    expect(latte).toBeDefined();
    expect(latte!.isDark).toBe(false);
    const darks = THEMES.filter((t) => t.id !== "catppuccin-latte");
    for (const dark of darks) {
      expect(dark.isDark).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TC-6: Runtime setTheme / getStyles
// ---------------------------------------------------------------------------
describe("Theme runtime", () => {
  beforeEach(() => {
    themeRuntime.setTheme(DEFAULT_THEME_ID);
  });

  test("TC-6: setTheme returns true for valid id, false for unknown", () => {
    expect(themeRuntime.setTheme("dracula")).toBe(true);
    expect(themeRuntime.setTheme("not-a-real-theme")).toBe(false);
  });

  test("TC-7: getStyles returns 13 semantic tokens after switch", () => {
    themeRuntime.setTheme("dracula");
    const styles = themeRuntime.getStyles();
    const keys: Array<keyof typeof styles> = [
      "info", "error", "success", "warning", "tool", "toolDetail",
      "response", "reasoning", "user", "primary", "secondary", "muted", "border",
    ];
    expect(keys).toHaveLength(13);
    for (const key of keys) {
      expect(typeof styles[key]).toBe("string");
      expect(styles[key].length).toBeGreaterThan(0);
    }
  });

  test("TC-8: getActiveId reflects current theme", () => {
    themeRuntime.setTheme("gruvbox");
    expect(themeRuntime.getActiveId()).toBe("gruvbox");
    themeRuntime.setTheme("default");
    expect(themeRuntime.getActiveId()).toBe("default");
  });

  test("TC-9: styles change after theme switch", () => {
    themeRuntime.setTheme("default");
    const defaultPrimary = themeRuntime.getStyles().primary;
    themeRuntime.setTheme("dracula");
    const draculaPrimary = themeRuntime.getStyles().primary;
    expect(defaultPrimary).not.toBe(draculaPrimary);
  });

  test("TC-10: catppuccin-latte border is light (#cccccc)", () => {
    themeRuntime.setTheme("catppuccin-latte");
    const styles = themeRuntime.getStyles();
    expect(styles.border).toBe("#cccccc");
  });

  test("TC-11: dark themes have dark border (#444444)", () => {
    themeRuntime.setTheme("dracula");
    expect(themeRuntime.getStyles().border).toBe("#444444");
    themeRuntime.setTheme("gruvbox");
    expect(themeRuntime.getStyles().border).toBe("#444444");
  });
});

// ---------------------------------------------------------------------------
// TC-12: /theme slash command parser
// ---------------------------------------------------------------------------
describe("/theme slash command", () => {
  test("TC-12a: /theme list returns theme list text", () => {
    const result = handleThemeCommand(["list"]);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("default");
    expect(result.output).toContain("dracula");
    expect(result.output).toContain("gruvbox");
  });

  test("TC-12b: /theme with no args returns list", () => {
    const result = handleThemeCommand([]);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("Available themes");
  });

  test("TC-12c: /theme <valid-id> returns theme_switch action", () => {
    const result = handleThemeCommand(["dracula"]);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("theme_switch");
    expect((result.data as { themeId: string }).themeId).toBe("dracula");
  });

  test("TC-12d: /theme <unknown> returns error output", () => {
    const result = handleThemeCommand(["nonexistent"]);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("Unknown theme");
    expect(result.action).toBeUndefined();
  });

  test("TC-12e: /theme routed via handleSlashCommand", () => {
    const result = handleSlashCommand("/theme catppuccin-mocha");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("theme_switch");
    expect((result.data as { themeId: string }).themeId).toBe("catppuccin-mocha");
  });
});

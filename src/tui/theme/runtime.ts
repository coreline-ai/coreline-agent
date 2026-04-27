/** Theme runtime — global active theme singleton (VTCode runtime.rs port). */

import { DEFAULT_THEME_ID, THEMES, getTheme } from "./registry.js";
import type { ThemeDefinition, ThemePalette, ThemeStyles } from "./types.js";

/** Compile a palette into semantic style tokens. */
function buildStyles(palette: ThemePalette): ThemeStyles {
  const mutedColor = "#666666";

  return {
    info:       palette.secondaryAccent,
    error:      palette.alert,
    success:    palette.success,
    warning:    palette.secondaryAccent,
    tool:       palette.primaryAccent,
    toolDetail: palette.foreground,
    response:   palette.foreground,
    reasoning:  mutedColor,
    user:       palette.success,
    primary:    palette.primaryAccent,
    secondary:  palette.secondaryAccent,
    muted:      mutedColor,
    border:     "#444444",
  };
}

// Attach isDark to buildStyles call site
function buildStylesFromDef(def: ThemeDefinition): ThemeStyles {
  const base = buildStyles(def.palette);
  const borderColor = def.isDark ? "#444444" : "#cccccc";
  return { ...base, border: borderColor };
}

let _activeId: string = DEFAULT_THEME_ID;
let _activeDef: ThemeDefinition = getTheme(DEFAULT_THEME_ID);
let _activeStyles: ThemeStyles = buildStylesFromDef(_activeDef);

export const themeRuntime = {
  /** Switch active theme. Returns false if id is unknown. */
  setTheme(id: string): boolean {
    const def = THEMES.find((t) => t.id === id);
    if (!def) return false;
    _activeId = id;
    _activeDef = def;
    _activeStyles = buildStylesFromDef(def);
    return true;
  },

  getStyles(): ThemeStyles {
    return _activeStyles;
  },

  getActiveId(): string {
    return _activeId;
  },

  getActiveDef(): ThemeDefinition {
    return _activeDef;
  },

  listThemes(): ThemeDefinition[] {
    return THEMES;
  },
};

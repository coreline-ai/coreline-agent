/** Theme type definitions — palette → semantic styles pipeline (VTCode vtcode-theme port). */

export interface ThemePalette {
  primaryAccent: string;
  background: string;
  foreground: string;
  secondaryAccent: string;
  alert: string;
  success: string;
}

/** Semantic style tokens consumed by TUI components. */
export interface ThemeStyles {
  info: string;
  error: string;
  success: string;
  warning: string;
  tool: string;
  toolDetail: string;
  response: string;
  reasoning: string;
  user: string;
  primary: string;
  secondary: string;
  muted: string;
  border: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  isDark: boolean;
  palette: ThemePalette;
}

/** Theme registry — 10 built-in themes ported from VTCode vtcode-theme/registry.rs palettes. */

import type { ThemeDefinition } from "./types.js";

export const THEMES: ThemeDefinition[] = [
  {
    id: "default",
    name: "Default",
    description: "coreline-agent 기본 색상",
    isDark: true,
    palette: {
      primaryAccent:  "#00afaf",
      background:     "#1a1a1a",
      foreground:     "#d4d4d4",
      secondaryAccent:"#afaf00",
      alert:          "#d75f5f",
      success:        "#5faf5f",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "퍼플 계열 인기 다크 테마",
    isDark: true,
    palette: {
      primaryAccent:  "#bd93f9",
      background:     "#282a36",
      foreground:     "#f8f8f2",
      secondaryAccent:"#8be9fd",
      alert:          "#ff5555",
      success:        "#50fa7b",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    description: "트렌디한 다크 테마",
    isDark: true,
    palette: {
      primaryAccent:  "#cba6f7",
      background:     "#1e1e2e",
      foreground:     "#cdd6f4",
      secondaryAccent:"#89dceb",
      alert:          "#f38ba8",
      success:        "#a6e3a1",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    description: "부드러운 라이트 테마",
    isDark: false,
    palette: {
      primaryAccent:  "#7287fd",
      background:     "#eff1f5",
      foreground:     "#4c4f69",
      secondaryAccent:"#04a5e5",
      alert:          "#d20f39",
      success:        "#40a02b",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox Dark",
    description: "따뜻한 레트로 다크 테마",
    isDark: true,
    palette: {
      primaryAccent:  "#fabd2f",
      background:     "#282828",
      foreground:     "#ebdbb2",
      secondaryAccent:"#83a598",
      alert:          "#fb4934",
      success:        "#b8bb26",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "클래식 저대비 다크 테마",
    isDark: true,
    palette: {
      primaryAccent:  "#268bd2",
      background:     "#002b36",
      foreground:     "#839496",
      secondaryAccent:"#2aa198",
      alert:          "#dc322f",
      success:        "#859900",
    },
  },
  {
    id: "vitesse-dark",
    name: "Vitesse Dark",
    description: "미니멀 엘레강트 다크",
    isDark: true,
    palette: {
      primaryAccent:  "#4d9375",
      background:     "#121212",
      foreground:     "#dbd7ca",
      secondaryAccent:"#6394bf",
      alert:          "#cb7676",
      success:        "#80a665",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    description: "GitHub 다크 테마",
    isDark: true,
    palette: {
      primaryAccent:  "#79c0ff",
      background:     "#0d1117",
      foreground:     "#c9d1d9",
      secondaryAccent:"#56d364",
      alert:          "#f85149",
      success:        "#3fb950",
    },
  },
  {
    id: "atom-one-dark",
    name: "Atom One Dark",
    description: "Atom 에디터 다크 테마",
    isDark: true,
    palette: {
      primaryAccent:  "#61afef",
      background:     "#282c34",
      foreground:     "#abb2bf",
      secondaryAccent:"#98c379",
      alert:          "#e06c75",
      success:        "#98c379",
    },
  },
  {
    id: "tomorrow-night",
    name: "Tomorrow Night",
    description: "Tomorrow 다크 시리즈",
    isDark: true,
    palette: {
      primaryAccent:  "#81a2be",
      background:     "#1d1f21",
      foreground:     "#c5c8c6",
      secondaryAccent:"#8abeb7",
      alert:          "#cc6666",
      success:        "#b5bd68",
    },
  },
];

export const DEFAULT_THEME_ID = "default";

export function getTheme(id: string): ThemeDefinition {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

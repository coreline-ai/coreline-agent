/**
 * Theme slash sub-router — handles /theme [list|<id>].
 */
import type { SlashCommandResult } from "../slash-commands.js";
import { THEMES } from "../theme/registry.js";

export function handleThemeCommand(args: string[]): SlashCommandResult {
  const [sub] = args;

  if (!sub || sub === "list") {
    const list = THEMES.map((t) => `  ${t.id.padEnd(20)} ${t.name}`).join("\n");
    return { handled: true, output: `Available themes:\n${list}\n\nUsage: /theme <id>` };
  }

  const found = THEMES.find((t) => t.id === sub);
  if (!found) {
    const ids = THEMES.map((t) => t.id).join(", ");
    return { handled: true, output: `Unknown theme "${sub}". Available: ${ids}` };
  }

  return { handled: true, action: "theme_switch", data: { themeId: found.id } };
}

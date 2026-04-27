/**
 * Theme slash sub-router — handles /theme [list|<id>].
 *
 * /theme          → interactive picker (theme_pick action)
 * /theme list     → text list of available themes
 * /theme <id>     → instant switch (theme_switch action)
 */
import type { SlashCommandResult } from "../slash-commands.js";
import { THEMES } from "../theme/registry.js";

export function handleThemeCommand(args: string[]): SlashCommandResult {
  const [sub] = args;

  if (!sub) {
    return { handled: true, action: "theme_pick" };
  }

  if (sub === "list") {
    const list = THEMES.map((t) => `  ${t.id.padEnd(22)} ${t.name}`).join("\n");
    return { handled: true, output: `Available themes:\n${list}\n\nUsage: /theme <id>  or  /theme (interactive)` };
  }

  const found = THEMES.find((t) => t.id === sub);
  if (!found) {
    const ids = THEMES.map((t) => t.id).join(", ");
    return { handled: true, output: `Unknown theme "${sub}". Available: ${ids}` };
  }

  return { handled: true, action: "theme_switch", data: { themeId: found.id } };
}

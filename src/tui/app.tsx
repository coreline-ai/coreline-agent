/**
 * TUI App root — Ink 5 render entry.
 */

import React, { useState } from "react";
import { render } from "ink";
import { REPL } from "./repl.js";
import { ThemeProvider } from "./theme/context.js";
import { loadSettings } from "../config/loader.js";
import type { AppState } from "../agent/context.js";
import type { ProviderRegistry } from "../providers/types.js";
import type { SessionManager } from "../session/history.js";
import type { ProxyStatus } from "./status-bar.js";
import type { StatusTracker } from "../agent/status.js";
import type { Role } from "../config/roles.js";
import type { BuiltInSkillId } from "../skills/types.js";

export interface AppProps {
  state: AppState;
  providerRegistry?: ProviderRegistry;
  systemPrompt: string;
  maxTurns: number;
  session?: SessionManager;
  showReasoning?: boolean;
  mcpStatus?: string;
  proxyStatus?: ProxyStatus;
  statusTracker?: StatusTracker;
  activeRole?: Role;
  initialExplicitSkillIds?: BuiltInSkillId[];
  initialAutoSkillsEnabled?: boolean;
  /** Active theme id — defaults to settings.theme when omitted. */
  themeId?: string;
  onThemeChange?: (themeId: string) => void;
}

/** Stateless App — wraps REPL in ThemeProvider. Testable as a plain function call. */
export function App({
  state,
  providerRegistry,
  systemPrompt,
  maxTurns,
  session,
  showReasoning,
  mcpStatus,
  proxyStatus,
  statusTracker,
  activeRole,
  initialExplicitSkillIds,
  initialAutoSkillsEnabled,
  themeId = "default",
  onThemeChange,
}: AppProps) {
  return (
    <ThemeProvider themeId={themeId}>
      <REPL
        state={state}
        providerRegistry={providerRegistry}
        systemPrompt={systemPrompt}
        maxTurns={maxTurns}
        session={session}
        showReasoning={showReasoning}
        mcpStatus={mcpStatus}
        proxyStatus={proxyStatus}
        statusTracker={statusTracker}
        initialRole={activeRole}
        initialExplicitSkillIds={initialExplicitSkillIds}
        initialAutoSkillsEnabled={initialAutoSkillsEnabled}
        onThemeChange={onThemeChange}
      />
    </ThemeProvider>
  );
}

/** Stateful launcher — holds theme state so /theme switches trigger re-renders. */
function ThemedApp(props: Omit<AppProps, "themeId" | "onThemeChange">) {
  const [themeId, setThemeId] = useState<string>(() => loadSettings().theme);
  return <App {...props} themeId={themeId} onThemeChange={setThemeId} />;
}

export function launchTUI(props: AppProps): void {
  const instance = render(<ThemedApp {...props} />);

  // Graceful shutdown
  const cleanup = () => {
    props.state.abortController.abort();
    instance.unmount();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

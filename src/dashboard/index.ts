import type { AgentStatusSnapshot } from "../agent/status.js";
import { renderDashboardHtml } from "./index.html.js";

export interface DashboardRequestOptions {
  status?: AgentStatusSnapshot | null;
  statusPath?: string;
  streamPath?: string;
}

export function handleDashboardRequest(options: DashboardRequestOptions = {}): Response {
  return new Response(renderDashboardHtml(options), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export { renderDashboardHtml } from "./index.html.js";

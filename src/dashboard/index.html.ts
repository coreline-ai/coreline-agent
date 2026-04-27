import type { AgentStatusSnapshot } from "../agent/status.js";

export interface DashboardRenderOptions {
  title?: string;
  status?: AgentStatusSnapshot | null;
  statusPath?: string;
  streamPath?: string;
}

export function renderDashboardHtml(options: DashboardRenderOptions = {}): string {
  const title = escapeHtml(options.title ?? "coreline-agent dashboard");
  const statusPath = escapeAttr(options.statusPath ?? "/v2/status");
  const streamPath = escapeAttr(options.streamPath ?? "/v2/status/stream");
  const snapshotJson = escapeScriptJson(JSON.stringify(options.status ?? null));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 24px; background: #0b1020; color: #e5e7eb; }
    main { max-width: 920px; margin: 0 auto; }
    .card { border: 1px solid #263149; border-radius: 16px; padding: 20px; background: #111827; box-shadow: 0 16px 40px rgb(0 0 0 / 0.24); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
    .metric { border: 1px solid #263149; border-radius: 12px; padding: 12px; background: #0f172a; }
    .label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 6px; font-size: 18px; font-weight: 700; word-break: break-word; }
    pre { overflow: auto; border-radius: 12px; padding: 12px; background: #020617; border: 1px solid #1e293b; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <main>
    <section class="card" aria-label="Coreline agent status dashboard">
      <h1>${title}</h1>
      <p>Read-only status shell. No write actions are exposed.</p>
      <div class="grid" id="metrics"></div>
      <h2>Raw snapshot</h2>
      <pre id="raw">Loading…</pre>
      <p><small>Status endpoint: <code>${statusPath}</code> · Stream endpoint: <code>${streamPath}</code></small></p>
    </section>
  </main>
  <script type="application/json" id="initial-status">${snapshotJson}</script>
  <script>
    const statusPath = ${JSON.stringify(options.statusPath ?? "/v2/status")};
    const streamPath = ${JSON.stringify(options.streamPath ?? "/v2/status/stream")};
    const raw = document.getElementById('raw');
    const metrics = document.getElementById('metrics');
    function render(snapshot) {
      const status = snapshot && snapshot.status ? snapshot.status : snapshot;
      raw.textContent = JSON.stringify(status, null, 2);
      const items = [
        ['status', status && status.status],
        ['mode', status && status.mode],
        ['session', status && status.sessionId],
        ['provider', status && status.provider],
        ['model', status && status.model],
        ['updated', status && status.lastActivity],
      ];
      metrics.innerHTML = items.map(([label, value]) => '<div class="metric"><div class="label">' + label + '</div><div class="value">' + (value || '—') + '</div></div>').join('');
    }
    try { render(JSON.parse(document.getElementById('initial-status').textContent)); } catch { render(null); }
    fetch(statusPath).then((r) => r.ok ? r.json() : null).then((body) => body && render(body)).catch(() => {});
    if ('EventSource' in window) {
      const source = new EventSource(streamPath);
      source.addEventListener('snapshot', (event) => render(JSON.parse(event.data)));
      source.addEventListener('status', (event) => render(JSON.parse(event.data)));
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function escapeScriptJson(value: string): string {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

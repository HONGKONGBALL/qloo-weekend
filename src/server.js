import http from "node:http";
import { pathToFileURL } from "node:url";
import { runAgent } from "./agent.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT) || 4173;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sourceBanner(plan) {
  if (plan.source === "qloo-live") {
    return { className: "note", text: "Live Qloo data" };
  }
  if (plan.source === "mock") {
    return {
      className: "warn",
      text: "Offline demo data: self-written examples, not Qloo results",
    };
  }
  return { className: "warn", text: "Local catalog" };
}

function publicApiPlan(plan) {
  // Do not return raw Qloo JSON. Only fields the UI/API need.
  if (!plan.ok) {
    return {
      ok: false,
      status: plan.status || 400,
      source: plan.source,
      keyUsed: plan.keyUsed === true,
      requestSent: plan.requestSent === true,
      city: plan.city,
      day: plan.day,
      error: plan.error,
      moods: plan.moods,
      fallback: true,
      fallbackReason: plan.fallbackReason || "BAD_INPUT",
      trace: plan.trace || [],
    };
  }
  return {
    ok: true,
    status: 200,
    source: plan.source,
    keyUsed: plan.keyUsed === true,
    requestSent: plan.requestSent === true,
    city: plan.city,
    day: plan.day,
    catalogNote: plan.catalogNote,
    mood: plan.mood,
    moods: plan.moods,
    intent: plan.intent,
    error: null,
    fallback: plan.fallback === true,
    fallbackReason: plan.fallbackReason,
    stops: (plan.stops || []).map((stop) => ({
      day: stop.day,
      time: stop.time,
      kind: stop.kind,
      filledFromCatalog: stop.filledFromCatalog === true,
      reason: stop.reason,
      place: {
        id: stop.place.id,
        name: stop.place.name,
        kind: stop.place.kind,
        area: stop.place.area,
        note: stop.place.note,
        affinity: stop.place.affinity,
        address: stop.place.address,
        signals: stop.place.signals || [],
      },
    })),
    trace: plan.trace || [],
  };
}

function render(plan) {
  const banner = sourceBanner(plan);
  const moods = plan.moods || [];
  const intent = plan.intent || {};
  const qValue = intent.raw || "";

  const chips = moods
    .map((item) => {
      const current = plan.mood && item.id === plan.mood.id;
      return `<a class="choice${current ? " current" : ""}" href="/?mood=${encodeURIComponent(item.id)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`;
    })
    .join("");

  const stops = (plan.stops || [])
    .map((stop, index) => {
      const place = stop.place;
      const affinity =
        typeof place.affinity === "number" && place.affinity > 0
          ? `<p class="meta">Affinity ${escapeHtml(place.affinity.toFixed(2))}</p>`
          : "";
      const fill = stop.filledFromCatalog
        ? `<p class="interest">Filled from local catalog</p>`
        : "";
      return `<article>
        <p class="when">${index + 1}. ${escapeHtml(stop.day)} · ${escapeHtml(stop.time)}</p>
        <h2>${escapeHtml(place.name)}</h2>
        <p class="meta">${escapeHtml(place.area || "")} · ${escapeHtml(place.kind || "")}</p>
        ${affinity}
        <p><strong>Why:</strong> ${escapeHtml(stop.reason)}</p>
        ${fill}
      </article>`;
    })
    .join("");

  const traceRows = (plan.trace || [])
    .map((step) => {
      const params = escapeHtml(JSON.stringify(step.params || {}));
      return `<tr>
        <td>${escapeHtml(step.tool)}</td>
        <td>${escapeHtml(step.path || "—")}</td>
        <td><code>${params}</code></td>
        <td>${escapeHtml(String(step.status))}</td>
        <td>${escapeHtml(step.ms == null ? "—" : String(step.ms))}</td>
        <td>${step.cached ? "yes" : "no"}</td>
        <td>${escapeHtml(step.decision || "")}</td>
      </tr>`;
    })
    .join("");

  const lead = plan.mood
    ? escapeHtml(plan.mood.blurb)
    : intent.interests && intent.interests.length
      ? `A Saturday plan grounded in: ${escapeHtml(intent.interests.join(", "))}.`
      : "Tell the agent what you like, or pick a mood.";

  const jsonHref =
    intent.raw
      ? `/api/agent?q=${encodeURIComponent(intent.raw)}`
      : plan.mood
        ? `/api/agent?mood=${encodeURIComponent(plan.mood.id)}`
        : `/api/agent`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Saturday in Hong Kong</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", Palatino, Georgia, serif;
      background: #f4f0e6;
      color: #1c1915;
    }
    main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    header p { margin: 0.4rem 0; }
    .badge {
      display: inline-block;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 0.75rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      border: 1px solid #1c1915;
      padding: 0.2rem 0.45rem;
    }
    h1 { font-weight: 500; font-size: 2.2rem; margin: 0.8rem 0 0.4rem; }
    .lead, article p { font-size: 1.05rem; line-height: 1.45; }
    form.taste {
      display: flex; flex-wrap: wrap; gap: 0.45rem;
      margin: 1rem 0 0.6rem;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    form.taste input[type=text] {
      flex: 1 1 14rem;
      font: inherit;
      padding: 0.45rem 0.6rem;
      border: 1px solid #1c1915;
      background: #fffdf8;
    }
    form.taste button {
      font: inherit;
      border: 1px solid #1c1915;
      background: #1c1915;
      color: #f4f0e6;
      padding: 0.45rem 0.8rem;
      cursor: pointer;
    }
    nav { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0.6rem 0 1rem; }
    a.choice {
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 0.9rem;
      color: inherit;
      text-decoration: none;
      border: 1px solid #1c1915;
      padding: 0.35rem 0.6rem;
      background: transparent;
    }
    a.choice.current { background: #1c1915; color: #f4f0e6; }
    .warn, .note {
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 0.9rem;
      background: #fff;
      border-left: 3px solid #8a5a2a;
      padding: 0.75rem 0.9rem;
    }
    .note { border-left-color: #3d5c4a; }
    code { font-size: 0.78rem; word-break: break-all; }
    section { display: grid; gap: 0.8rem; margin-top: 1.4rem; }
    article {
      background: #fffdf8;
      padding: 0.9rem 1rem 1rem;
      border-top: 1px solid #d9d1c3;
    }
    h2 { font-size: 1.35rem; font-weight: 500; margin: 0.15rem 0; }
    .when, .meta, .interest {
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 0.85rem;
      margin: 0.2rem 0;
    }
    .meta, .interest { color: #5c5348; }
    details {
      margin-top: 1.4rem;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 0.85rem;
      background: #fff;
      padding: 0.6rem 0.8rem;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { text-align: left; vertical-align: top; padding: 0.25rem 0.3rem; border-top: 1px solid #e5dfd3; }
    footer { margin-top: 1.5rem; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <span class="badge">${escapeHtml(banner.text)}</span>
      <h1>Saturday in ${escapeHtml(plan.city || "Hong Kong")}</h1>
      <p class="lead">${lead}</p>
    </header>
    <form class="taste" method="get" action="/" role="search">
      <label class="visually-hidden" for="q" style="position:absolute;left:-9999px">What do you like?</label>
      <input id="q" name="q" type="text" maxlength="200" placeholder="e.g. In the Mood for Love, jazz" value="${escapeHtml(qValue)}">
      <button type="submit">Plan my Saturday</button>
    </form>
    <nav aria-label="Mood">${chips}</nav>
    <p class="${banner.className}">${escapeHtml(banner.text)}${plan.fallbackReason ? ` · ${escapeHtml(plan.fallbackReason)}` : ""}</p>
    <section>${stops}</section>
    <details>
      <summary>Agent steps (${(plan.trace || []).length})</summary>
      <table>
        <thead><tr><th>Tool</th><th>Path</th><th>Params</th><th>Status</th><th>ms</th><th>Cached</th><th>Decision</th></tr></thead>
        <tbody>${traceRows || "<tr><td colspan=7>No steps</td></tr>"}</tbody>
      </table>
    </details>
    <footer>
      <p>The free host may spin down after idle traffic. The first request can take about a minute to wake it.</p>
      <p>JSON for this plan: <a href="${escapeHtml(jsonHref)}">${escapeHtml(jsonHref)}</a></p>
      <p>${escapeHtml(plan.catalogNote || "")}</p>
    </footer>
  </main>
</body>
</html>`;
}

function planHeaders(plan, contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Plan-Source": plan.source || "local-catalog",
    "X-Key-Used": plan.keyUsed ? "yes" : "no",
  };
}

async function handleAgent(url) {
  const q = url.searchParams.get("q");
  const mood = url.searchParams.get("mood");
  const plan = await runAgent({ q, mood });
  return publicApiPlan(plan);
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/agent" || url.pathname === "/api/plan") {
      const plan = await handleAgent(url);
      const body = JSON.stringify(plan, null, 2);
      res.writeHead(plan.ok ? 200 : 400, planHeaders(plan, "application/json; charset=utf-8"));
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const q = url.searchParams.get("q");
    const mood = url.searchParams.get("mood");
    const plan = publicApiPlan(await runAgent({ q, mood }));
    if (!plan.ok) {
      // Do not echo the raw user input back.
      res.writeHead(400, planHeaders(plan, "text/plain; charset=utf-8"));
      res.end(plan.error || "Bad request");
      return;
    }
    const html = render(plan);
    res.writeHead(200, planHeaders(plan, "text/html; charset=utf-8"));
    res.end(req.method === "HEAD" ? undefined : html);
  } catch (err) {
    console.error("request failed:", err && err.stack ? err.stack : err);
    if (res.headersSent) {
      res.end();
      return;
    }
    const wantsJson = String(req.url || "").startsWith("/api/");
    if (wantsJson) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "internal_error" }));
    } else {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "Internal server error");
    }
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(port, host, () => {
    console.log(`weekend planner listening on http://${host}:${port}`);
  });
}

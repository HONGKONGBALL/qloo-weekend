#!/usr/bin/env node
/**
 * Smoke-check a deployed or local base URL.
 * Usage: npm run smoke -- <BASE_URL> [--expect-source qloo-live|mock|local-catalog]
 * Optional: SMOKE_FORBIDDEN=<secret> — assert no response contains it (never printed).
 */

const args = process.argv.slice(2);
const base = (args[0] || "").replace(/\/$/, "");
const expectIdx = args.indexOf("--expect-source");
const expectSource = expectIdx >= 0 ? args[expectIdx + 1] : null;

if (!base) {
  console.error("usage: npm run smoke -- <BASE_URL> [--expect-source qloo-live]");
  process.exit(2);
}

try {
  const u = new URL(base);
  const blocked = new Set([8787, 8797, 5173, 18799, 8790, 4199, 4173]);
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
    const p = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (blocked.has(p)) {
      console.error(`refusing blocked port ${p}`);
      process.exit(2);
    }
  }
} catch {
  console.error("invalid BASE_URL");
  process.exit(2);
}

const forbidden = process.env.SMOKE_FORBIDDEN || "";

async function check(path) {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  const text = await res.text();
  return { res, text, headers: res.headers };
}

const failures = [];
function ok(cond, msg) {
  if (!cond) failures.push(msg);
}

const health = await check("/healthz");
ok(health.res.status === 200, `/healthz status ${health.res.status}`);
ok(health.text.includes('"ok":true') || health.text.includes('"ok": true'), "/healthz body");

const home = await check("/");
ok(home.res.status === 200, `/ status ${home.res.status}`);
ok(/Saturday/i.test(home.text), "/ missing Saturday");

const agent = await check("/api/agent?q=jazz");
ok(agent.res.status === 200, `/api/agent status ${agent.res.status}`);
const source = agent.headers.get("x-plan-source");
ok(Boolean(source), "missing X-Plan-Source");
if (expectSource) ok(source === expectSource, `expected source ${expectSource}, got ${source}`);
let body;
try {
  body = JSON.parse(agent.text);
  ok(Array.isArray(body.stops) && body.stops.length === 3, "expected 3 stops");
  ok(Array.isArray(body.trace) && body.trace.length >= 1, "expected trace steps");
} catch {
  ok(false, "/api/agent not JSON");
}

if (forbidden) {
  const blob = health.text + home.text + agent.text + JSON.stringify([...agent.headers.entries()]);
  ok(!blob.includes(forbidden), "forbidden secret found in responses");
}

if (failures.length) {
  for (const f of failures) console.error("FAIL:", f);
  process.exit(1);
}
console.log(`smoke ok source=${source} stops=${body.stops.length} trace=${body.trace.length}`);

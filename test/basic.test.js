import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Fake key so the real .env is never read; fetch is mocked so nothing leaves the machine.
process.env.QLOO_DOTENV = "off";
process.env.QLOO_API_KEY = "test-key-not-real";
process.env.QLOO_MODE = "live";
const calls = [];
let failNext = false;
let fetchOverride = null;
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  if (fetchOverride) return fetchOverride(String(url), init);
  if (failNext) {
    failNext = false;
    return {
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("boom at /secret/internal/path.js:1:1");
      },
    };
  }
  return new Response(JSON.stringify({ success: true, results: { entities: [], tags: [] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const qloo = await import("../src/qloo.js");
const { server } = await import("../src/server.js");

let base;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

function fetchReal(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || "GET" }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          json: async () => JSON.parse(data),
          text: async () => data,
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function withConfig(overrides) {
  const saved = { ...qloo.qlooConfig };
  Object.assign(qloo.qlooConfig, overrides);
  qloo.clearQlooCache();
  return () => {
    Object.assign(qloo.qlooConfig, saved);
    qloo.clearQlooCache();
    fetchOverride = null;
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("buildUrl targets the hackathon host", () => {
  const u = new URL(qloo.buildUrl("insights", { filterType: "urn:entity:place" }));
  assert.equal(u.origin, qloo.BASE_URL);
  assert.equal(u.pathname, "/v2/insights");
  assert.equal(u.searchParams.get("filter.type"), "urn:entity:place");
});

test("search and tags URLs use their paths", () => {
  assert.equal(new URL(qloo.buildSearchUrl({ query: "x" })).pathname, "/search");
  assert.equal(new URL(qloo.buildTagsUrl({})).pathname, "/v2/tags");
});

test("headers carry the API key", () => {
  const h = qloo.buildHeaders();
  assert.equal(h.ok, true);
  assert.equal(h.headers["X-Api-Key"], "test-key-not-real");
});

test("missingKeyResult reports not sent", () => {
  const r = qloo.missingKeyResult("https://example.test");
  assert.equal(r.ok, false);
  assert.equal(r.sent, false);
  assert.equal(r.code, "QLOO_API_KEY_MISSING");
});

test("GET /healthz returns ok", async () => {
  const res = await fetchReal(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("unknown path is 404, POST is 405", async () => {
  assert.equal((await fetchReal(`${base}/nope`)).status, 404);
  assert.equal((await fetchReal(`${base}/`, { method: "POST" })).status, 405);
});

test("/api/agent with a mood returns 200, 3 stops, and a trace", async () => {
  // Empty live → agent falls to mock
  qloo.clearQlooCache();
  const res = await fetchReal(`${base}/api/agent?mood=outdoors`);
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-plan-source"], "mock");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.city, "Hong Kong");
  assert.equal(body.stops.length, 3);
  assert.ok(Array.isArray(body.trace));
  assert.ok(body.trace.length >= 1);
  assert.equal("qloo" in body, false, "must not return raw qloo body");
  for (const stop of body.stops) {
    assert.equal(stop.day, "Saturday");
    assert.equal(typeof stop.place.name, "string");
    assert.equal(typeof stop.reason, "string");
  }
});

test("/api/plan is a mood alias of /api/agent", async () => {
  qloo.clearQlooCache();
  const res = await fetchReal(`${base}/api/plan?mood=culture`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stops.length, 3);
  assert.ok(body.trace.length >= 1);
});

test("/api/agent with unknown mood returns 400 without echoing junk paths", async () => {
  const res = await fetchReal(`${base}/api/agent?mood=nope`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Unknown mood/);
  assert.equal(body.stops, undefined);
});

test("home page escapes script tags in q", async () => {
  const res = await fetchReal(`${base}/?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;") || !html.includes("<script>"));
});

test("internal error returns generic 500 without stack or paths", async () => {
  const origError = console.error;
  const origParse = JSON.parse;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  qloo.clearQlooCache();
  // Inject a throw that escapes runAgent: data/moods.json is parsed before the
  // agent's try/catch, so make that parse fail.
  JSON.parse = function (text, ...rest) {
    if (typeof text === "string" && /"moods"\s*:/.test(text)) {
      throw new Error("boom at /secret/internal/path.js:1:1");
    }
    return origParse.call(this, text, ...rest);
  };
  try {
    for (const [path, json] of [
      ["/api/agent?mood=outdoors", true],
      ["/?mood=outdoors", false],
    ]) {
      const res = await fetchReal(`${base}${path}`);
      assert.equal(res.status, 500, path);
      const text = await res.text();
      if (json) assert.equal(text, JSON.stringify({ error: "internal_error" }));
      else assert.equal(text, "Internal server error");
      assert.ok(!/boom|secret|\.js|\bat\s|\/src\/|\/workspace\//.test(text), text);
    }
    assert.ok(logged.some((l) => /boom/.test(l)), "stack goes to stderr only");
  } finally {
    JSON.parse = origParse;
    console.error = origError;
  }
});

test("cache hit does not call fetch again (direct qlooGet)", async () => {
  const restore = withConfig({});
  fetchOverride = () =>
    jsonResponse({ results: { tags: [{ id: "T1", name: "park", type: "urn:tag:genre:place" }] } });
  try {
    await qloo.qlooGet("tags", { query: "museum" });
    const n = calls.length;
    const second = await qloo.qlooGet("tags", { query: "museum" });
    assert.equal(calls.length, n);
    assert.equal(second.cached, true);
  } finally {
    restore();
  }
});

test("cache entries expire after the TTL (fake clock)", async () => {
  let clock = 1_000_000;
  const restore = withConfig({ cacheTtlMs: 1000, now: () => clock });
  fetchOverride = () => jsonResponse({ results: { tags: [] } });
  try {
    await qloo.qlooGet("tags", { query: "museum" });
    const n = calls.length;
    await qloo.qlooGet("tags", { query: "museum" });
    assert.equal(calls.length, n, "hit inside TTL");
    clock += 1001;
    await qloo.qlooGet("tags", { query: "museum" });
    assert.equal(calls.length, n + 1, "miss after TTL");
  } finally {
    restore();
  }
});

test("cache keeps at most cacheMax entries", async () => {
  const restore = withConfig({ cacheMax: 2 });
  fetchOverride = () => jsonResponse({ results: { tags: [] } });
  try {
    await qloo.qlooGet("tags", { query: "a" });
    await qloo.qlooGet("tags", { query: "b" });
    await qloo.qlooGet("tags", { query: "c" });
    assert.equal(qloo.qlooCacheSize(), 2);
  } finally {
    restore();
  }
});

test("failed responses are not cached", async () => {
  const restore = withConfig({});
  fetchOverride = () => new Response("nope", { status: 503 });
  try {
    const r = await qloo.qlooGet("tags", { query: "z" });
    assert.equal(r.ok, false);
    assert.equal(qloo.qlooCacheSize(), 0);
  } finally {
    restore();
  }
});

test("per-call timer is unref'd and cleared when the outer signal aborts", async () => {
  const restore = withConfig({ callTimeoutMs: 60_000 });
  fetchOverride = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  try {
    const baseline = timers();
    const outer = new AbortController();
    const pending = qloo.qlooGet("tags", { query: "unref-check" }, { signal: outer.signal });
    await new Promise((r) => setImmediate(r));
    assert.equal(timers(), baseline, "the 60 s per-call timer does not hold the event loop");
    outer.abort();
    const result = await pending;
    assert.equal(result.code, "QLOO_TIMEOUT");
    assert.equal(timers(), baseline);
  } finally {
    restore();
  }
});

test("X-Plan-Source and X-Key-Used headers on /api/agent", async () => {
  process.env.QLOO_MODE = "mock";
  delete process.env.QLOO_API_KEY;
  try {
    const res = await fetchReal(`${base}/api/agent?q=jazz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-plan-source"], "mock");
    assert.equal(res.headers["x-key-used"], "no");
  } finally {
    process.env.QLOO_API_KEY = "test-key-not-real";
    process.env.QLOO_MODE = "live";
  }
});

test("response never contains the configured key", async () => {
  const FAKE = "test-key-not-real";
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = FAKE;
  fetchOverride = () =>
    jsonResponse({ errors: [{ message: `denied ${FAKE}` }] }, 401);
  qloo.clearQlooCache();
  try {
    const res = await fetchReal(`${base}/api/agent?q=jazz`);
    const text = await res.text();
    assert.ok(!text.includes(FAKE));
    assert.equal(res.status, 200);
  } finally {
    fetchOverride = null;
  }
});

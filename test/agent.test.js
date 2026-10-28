import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.QLOO_DOTENV = "off";
process.env.QLOO_MODE = "mock";
delete process.env.QLOO_API_KEY;

const qloo = await import("../src/qloo.js");
const { runAgent, pickTag, assembleStops, openOnSaturdaySlot } = await import("../src/agent.js");
const { parseIntent } = await import("../src/intent.js");

let fetchOverride = null;
const calls = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  if (fetchOverride) return fetchOverride(String(url), init);
  return new Response(JSON.stringify({ success: true, results: { entities: [], tags: [] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

after(() => {
  globalThis.fetch = origFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function withConfig(overrides) {
  const saved = { ...qloo.qlooConfig };
  Object.assign(qloo.qlooConfig, overrides);
  qloo.clearQlooCache();
  calls.length = 0;
  return () => {
    Object.assign(qloo.qlooConfig, saved);
    qloo.clearQlooCache();
    fetchOverride = null;
    calls.length = 0;
  };
}

test("parseIntent: free text capped at 200 chars and 3 interests", () => {
  const long = "a".repeat(250);
  const r = parseIntent({ q: long });
  assert.equal(r.ok, true);
  assert.equal(r.raw.length, 200);
  const multi = parseIntent({ q: "jazz, film, parks, ignored-fourth" });
  assert.deepEqual(multi.interests, ["jazz", "film", "parks"]);
});

test("parseIntent: unknown mood is rejected", () => {
  const r = parseIntent({ mood: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown mood/);
});

test("pickTag prefers typed exact matches", () => {
  const tags = [
    { id: "MOCK-KW", name: "museum shop", type: "urn:tag:keyword:qloo" },
    { id: "MOCK-GENRE", name: "museum", type: "urn:tag:genre:place" },
  ];
  const hit = pickTag(tags, "museum", ["urn:tag:genre:place"]);
  assert.equal(hit.id, "MOCK-GENRE");
});

test("openOnSaturdaySlot filters closed hours", () => {
  const middayOnly = {
    properties: { hours: { saturday: { open: "12:00", close: "18:00" } } },
  };
  const closed = {
    properties: { hours: { saturday: { closed: true } } },
  };
  assert.equal(openOnSaturdaySlot(middayOnly, "Midday"), true);
  assert.equal(openOnSaturdaySlot(middayOnly, "Morning"), false); // 08-11 vs 12-18: no overlap
  assert.equal(openOnSaturdaySlot(closed, "Afternoon"), false);
  assert.equal(openOnSaturdaySlot({}, "Morning"), true);
});

test("openOnSaturdaySlot: live Qloo hours array shape (made-up values)", () => {
  const sat = (arr) => ({ properties: { hours: { saturday: arr } } });
  const noonToSix = sat([{ opens: "T12:00:00", closes: "T18:00:00", closed: false }]);
  assert.equal(openOnSaturdaySlot(noonToSix, "Midday"), true, "inside opening hours");
  assert.equal(openOnSaturdaySlot(noonToSix, "Morning"), false, "outside opening hours");
  const closed = sat([{ opens: "T09:00:00", closes: "T17:00:00", closed: true }]);
  for (const slot of ["Morning", "Midday", "Afternoon"]) {
    assert.equal(openOnSaturdaySlot(closed, slot), false, `closed:true in ${slot}`);
  }
  const overnight = sat([{ opens: "T18:00:00", closes: "T02:00:00", closed: false }]);
  assert.equal(openOnSaturdaySlot(overnight, "Afternoon"), true, "overnight: 18:00 overlaps 15-20");
  assert.equal(openOnSaturdaySlot(overnight, "Morning"), false, "overnight: shut 08-11");
  const allDay = sat([{ opens: "T00:00:00", closes: "T00:00:00", closed: false }]);
  for (const slot of ["Morning", "Midday", "Afternoon"]) {
    assert.equal(openOnSaturdaySlot(allDay, slot), true, `all day in ${slot}`);
  }
  const split = sat([
    { opens: "T07:00:00", closes: "T10:00:00", closed: false },
    { opens: "T16:00:00", closes: "T19:00:00", closed: false },
  ]);
  assert.equal(openOnSaturdaySlot(split, "Morning"), true);
  assert.equal(openOnSaturdaySlot(split, "Midday"), false);
  assert.equal(openOnSaturdaySlot(split, "Afternoon"), true);
});

test("mock mode happy path: 3 stops, trace, MOCK ids", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "mock";
  try {
    const plan = await runAgent({ q: "In the Mood for Love" });
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "mock");
    assert.equal(plan.stops.length, 3);
    assert.ok(plan.trace.length >= 3, `trace steps: ${plan.trace.length}`);
    const times = plan.stops.map((s) => s.time);
    assert.deepEqual(times, ["Morning", "Midday", "Afternoon"]);
    const kinds = new Set(plan.stops.map((s) => s.kind));
    assert.ok(kinds.size >= 2, "kinds should vary");
    for (const step of plan.trace) {
      assert.equal(typeof step.tool, "string");
      assert.ok("params" in step);
      assert.ok(!JSON.stringify(step).includes("QLOO_API_KEY"));
    }
    for (const s of plan.stops) {
      assert.ok(!/Qloo/.test(s.reason), `mock reason must not mention Qloo: ${s.reason}`);
    }
    assert.equal(calls.length, 0, "mock mode must not call fetch");
  } finally {
    restore();
  }
});

test("mood chip path works in mock mode", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "mock";
  try {
    const plan = await runAgent({ mood: "culture" });
    assert.equal(plan.ok, true);
    for (const s of plan.stops) assert.ok(!/Qloo/.test(s.reason), s.reason);
    assert.equal(plan.source, "mock");
    assert.equal(plan.stops.length, 3);
    assert.equal(plan.mood.id, "culture");
  } finally {
    restore();
  }
});

test("live mode without key falls to mock with fallbackReason", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "live";
  delete process.env.QLOO_API_KEY;
  try {
    const plan = await runAgent({ q: "jazz" });
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "mock");
    assert.equal(plan.fallbackReason, "QLOO_API_KEY_MISSING");
    assert.equal(plan.requestSent, false);
    assert.equal(plan.stops.length, 3);
  } finally {
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

test("401 with key echoing body: key never appears in plan or console", async () => {
  const restore = withConfig({});
  const FAKE = "e2e-fake-key-must-not-leak-agent";
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = FAKE;
  const logged = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => logged.push(a.join(" "));
  console.log = (...a) => logged.push(a.join(" "));
  fetchOverride = async () =>
    jsonResponse({ errors: [{ message: `bad key ${FAKE}` }] }, 401);
  try {
    const plan = await runAgent({ q: "jazz" });
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "mock");
    assert.ok(
      plan.fallbackReason === "QLOO_HTTP_401" || plan.fallbackReason === "QLOO_HTTP_ERROR",
      plan.fallbackReason
    );
    const blob = JSON.stringify(plan) + logged.join("\n");
    assert.ok(!blob.includes(FAKE), "key leaked");
    assert.equal(plan.stops.length, 3);
    assert.ok(plan.trace.some((t) => t.status === "fallback" || t.tool === "mode.fallback"));
  } finally {
    console.error = origErr;
    console.log = origLog;
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

test("call timeout falls to mock", async () => {
  const restore = withConfig({ requestBudgetMs: 80, callTimeoutMs: 40 });
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = "budget-test-key";
  // Hang until abort so the event loop can drain after the budget fires.
  fetchOverride = (url, init) =>
    new Promise((_, reject) => {
      if (init.signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  try {
    const started = Date.now();
    const plan = await runAgent({ mood: "outdoors" });
    const elapsed = Date.now() - started;
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "mock");
    assert.equal(plan.fallbackReason, "QLOO_TIMEOUT");
    assert.equal(plan.stops.length, 3);
    assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  } finally {
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

function hangUntilAbort(url, init) {
  return new Promise((_, reject) => {
    if (init.signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    init.signal.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

test("request budget falls to mock", async () => {
  // Per-call timeout is far longer than the budget, so only the budget can fire.
  const restore = withConfig({ requestBudgetMs: 80, callTimeoutMs: 60_000 });
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = "budget-test-key";
  fetchOverride = hangUntilAbort;
  try {
    const started = Date.now();
    const plan = await runAgent({ mood: "outdoors" });
    const elapsed = Date.now() - started;
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "mock");
    assert.equal(plan.fallbackReason, "QLOO_BUDGET_EXCEEDED");
    assert.equal(plan.stops.length, 3);
    assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  } finally {
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

test("six-call cap falls to mock", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = "cap-test-key";
  fetchOverride = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/search") {
      return jsonResponse({ results: [{ entity_id: `E-${u.searchParams.get("query")}`, name: "Entity" }] });
    }
    if (u.pathname === "/v2/tags") {
      return jsonResponse({ results: { tags: [{ id: "urn:tag:genre:place:park", name: "park", type: "urn:tag:genre:place" }] } });
    }
    if (u.pathname === "/v2/insights") return jsonResponse({ results: { entities: [] } });
    return jsonResponse({ results: [] });
  };
  try {
    const plan = await runAgent({ q: "alpha, beta, gamma" });
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "mock");
    assert.equal(calls.length, 6);
    assert.ok(plan.trace.some((t) => t.status === "limit"));
    assert.equal(plan.fallbackReason, "QLOO_BUDGET_EXCEEDED");
  } finally {
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

test("empty live results relax then mock", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = "empty-test-key";
  fetchOverride = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/search") {
      return jsonResponse({ results: [{ entity_id: "E-LIVE", name: "Live Entity" }] });
    }
    if (u.pathname === "/v2/tags") {
      return jsonResponse({
        results: { tags: [{ id: "urn:tag:genre:place:park", name: "park", type: "urn:tag:genre:place" }] },
      });
    }
    // insights always empty
    return jsonResponse({ success: true, results: { entities: [] } });
  };
  try {
    const plan = await runAgent({ q: "Hong Kong Park" });
    assert.equal(plan.ok, true);
    assert.equal(plan.stops.length, 3);
    // Should have fallen to mock after empty live insights
    assert.ok(plan.source === "mock" || plan.stops.some((s) => String(s.place.id).startsWith("MOCK-") || s.filledFromCatalog));
  } finally {
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

test("400 self-heal drops named path and retries", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = "heal-test-key";
  let insightsCalls = 0;
  fetchOverride = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/search") {
      return jsonResponse({ results: [{ entity_id: "E1", name: "Film" }] });
    }
    if (u.pathname === "/v2/tags") {
      return jsonResponse({
        results: { tags: [{ id: "urn:tag:genre:place:museum", name: "museum", type: "urn:tag:genre:place" }] },
      });
    }
    if (u.pathname === "/v2/insights") {
      insightsCalls += 1;
      if (insightsCalls === 1) {
        return jsonResponse(
          { errors: [{ message: "bad", path: "signal.interests.tags" }] },
          400
        );
      }
      return jsonResponse({
        results: {
          entities: [
            {
              entity_id: "P-PARK",
              name: "Victoria Park",
              subtype: "urn:entity:place:park",
              query: { affinity: 0.9 },
              properties: { address: "Causeway Bay", hours: { saturday: { open: "06:00", close: "23:00" } } },
              tags: [{ name: "park" }],
            },
            {
              entity_id: "P-MUS",
              name: "M+",
              subtype: "urn:entity:place:museum",
              query: { affinity: 0.85 },
              properties: { address: "West Kowloon", hours: { saturday: { open: "10:00", close: "18:00" } } },
              tags: [{ name: "museum" }],
            },
            {
              entity_id: "P-CAFE",
              name: "NOC Coffee",
              subtype: "urn:entity:place:cafe",
              query: { affinity: 0.8 },
              properties: { address: "Sheung Wan", hours: { saturday: { open: "08:00", close: "18:00" } } },
              tags: [{ name: "cafe" }],
            },
          ],
        },
      });
    }
    return jsonResponse({ results: [] });
  };
  try {
    const plan = await runAgent({ q: "jazz", mood: "culture" });
    assert.equal(plan.ok, true);
    assert.ok(insightsCalls >= 2, `insightsCalls=${insightsCalls}`);
    assert.ok(plan.trace.some((t) => /400/.test(t.decision) || /drop params/.test(t.decision)));
    assert.equal(plan.stops.length, 3);
    // Live success path — source may be qloo-live
    assert.ok(["qloo-live", "mock"].includes(plan.source), plan.source);
  } finally {
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

test("assembleStops fills from catalog when short", () => {
  const catalog = {
    places: [
      { id: "victoria-park", name: "Victoria Park", kind: "park", area: "CB", note: "n" },
      { id: "hk-museum-of-art", name: "HKMOA", kind: "museum", area: "TST", note: "n" },
      { id: "noc-coffee", name: "NOC", kind: "cafe", area: "SW", note: "n" },
    ],
  };
  const stops = assembleStops(
    [
      {
        entity_id: "ONLY-PARK",
        name: "Only Park",
        subtype: "urn:entity:place:park",
        query: { affinity: 0.9 },
        tags: [{ name: "park" }],
      },
    ],
    catalog,
    ["test"]
  );
  assert.equal(stops.length, 3);
  assert.ok(stops.some((s) => s.filledFromCatalog));
});

test("insufficient distinct types get catalog fill marked", () => {
  const catalog = {
    places: [
      { id: "victoria-park", name: "Victoria Park", kind: "park", area: "CB", note: "n" },
      { id: "hk-museum-of-art", name: "HKMOA", kind: "museum", area: "TST", note: "n" },
      { id: "noc-coffee", name: "NOC", kind: "cafe", area: "SW", note: "n" },
    ],
  };
  const cafe = (n, a) => ({
    entity_id: `CAFE-${n}`,
    name: `Cafe ${n}`,
    subtype: "urn:entity:place:cafe",
    query: { affinity: a },
    tags: [{ name: "cafe" }],
  });
  const stops = assembleStops([cafe(1, 0.9), cafe(2, 0.8), cafe(3, 0.7)], catalog, ["coffee"], "qloo-live");
  assert.equal(stops.length, 3);
  const kinds = stops.map((s) => s.kind);
  assert.notDeepEqual(kinds, ["cafe", "cafe", "cafe"]);
  assert.equal(new Set(kinds).size, 3, `kinds must be distinct: ${kinds}`);
  assert.equal(stops.filter((s) => !s.filledFromCatalog && s.kind === "cafe").length, 1);
  const filled = stops.filter((s) => s.filledFromCatalog);
  assert.equal(filled.length, 2, "two slots come from catalog.fill");
  for (const s of filled) assert.deepEqual(s.place.signals, ["catalog.fill"]);
  const mockStops = assembleStops([cafe(1, 0.9), cafe(2, 0.8)], catalog, ["coffee"], "mock");
  for (const s of mockStops) assert.ok(!/Qloo/.test(s.reason), s.reason);
});

test("Why text says Qloo affinity only for qloo-live", () => {
  const ent = {
    entity_id: "P1",
    name: "Park",
    subtype: "urn:entity:place:park",
    query: { affinity: 0.77 },
    tags: [{ name: "park" }],
  };
  const live = assembleStops([ent], { places: [] }, ["x"], "qloo-live");
  assert.match(live[0].reason, /Qloo affinity 0\.77/);
  const mock = assembleStops([ent], { places: [] }, ["x"], "mock");
  assert.match(mock[0].reason, /Demo affinity 0\.77/);
  assert.ok(!/Qloo/.test(mock[0].reason));
});

const liveTrio = [
  { entity_id: "L-PARK", name: "Park L", subtype: "urn:entity:place:park", query: { affinity: 0.9 }, tags: [{ name: "park" }] },
  { entity_id: "L-MUS", name: "Museum L", subtype: "urn:entity:place:museum", query: { affinity: 0.8 }, tags: [{ name: "museum" }] },
  { entity_id: "L-CAFE", name: "Cafe L", subtype: "urn:entity:place:cafe", query: { affinity: 0.7 }, tags: [{ name: "cafe" }] },
];

test("relax chain: entity signals empty, tag-only insights succeeds on live path", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = "relax-test-key";
  const insightUrls = [];
  fetchOverride = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/search") {
      return jsonResponse({ results: [{ entity_id: "E-A", name: "A" }] });
    }
    if (u.pathname === "/v2/tags") {
      return jsonResponse({ results: { tags: [{ id: "urn:tag:genre:place:park", name: "park", type: "urn:tag:genre:place" }] } });
    }
    if (u.pathname === "/v2/insights") {
      insightUrls.push(u);
      const hasEntities = u.searchParams.has("signal.interests.entities");
      return jsonResponse({ results: { entities: hasEntities ? [] : liveTrio } });
    }
    return jsonResponse({ results: [] });
  };
  try {
    // One interest: 1 search + 1 tags + 3 insights stays inside the 6-call cap.
    const plan = await runAgent({ q: "park" });
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "qloo-live");
    assert.equal(plan.fallbackReason, null);
    const tagOnly = insightUrls.filter(
      (u) => u.searchParams.has("signal.interests.tags") && !u.searchParams.has("signal.interests.entities")
    );
    assert.equal(tagOnly.length, 1, "one tag-only insights request");
    assert.ok(plan.trace.some((t) => t.decision === "empty results; tag only"));
    assert.ok(plan.stops.every((s) => !String(s.place.id).startsWith("MOCK-")));
    assert.ok(plan.stops.every((s) => /Qloo affinity/.test(s.reason)));
  } finally {
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

test("400 naming filter.location.query drops location on retry", async () => {
  const restore = withConfig({});
  process.env.QLOO_MODE = "live";
  process.env.QLOO_API_KEY = "loc-test-key";
  const insightUrls = [];
  fetchOverride = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/search") return jsonResponse({ results: [{ entity_id: "E1", name: "Film" }] });
    if (u.pathname === "/v2/tags") {
      return jsonResponse({ results: { tags: [{ id: "urn:tag:genre:place:jazz", name: "jazz", type: "urn:tag:genre:place" }] } });
    }
    if (u.pathname === "/v2/insights") {
      insightUrls.push(u);
      if (insightUrls.length === 1) {
        return jsonResponse({ errors: [{ message: "bad", path: "filter.location.query" }] }, 400);
      }
      return jsonResponse({ results: { entities: liveTrio } });
    }
    return jsonResponse({ results: [] });
  };
  try {
    const plan = await runAgent({ q: "jazz" });
    assert.equal(insightUrls.length, 2);
    assert.ok(insightUrls[0].searchParams.has("filter.location.query"));
    assert.equal(insightUrls[1].searchParams.has("filter.location.query"), false);
    assert.ok(insightUrls[1].searchParams.has("signal.interests.entities"));
    assert.ok(insightUrls[1].searchParams.has("signal.interests.tags"));
    assert.equal(plan.source, "qloo-live");
  } finally {
    delete process.env.QLOO_API_KEY;
    process.env.QLOO_MODE = "mock";
    restore();
  }
});

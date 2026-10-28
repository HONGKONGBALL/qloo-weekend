/**
 * Rule-based agent (no LLM). Uses Qloo search/tags/insights, then mock, then
 * the local catalog. Emits a trace of every tool step. The API key never
 * enters params, trace, responses, or logs.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  qlooGet,
  qlooConfig,
  resolveMode,
  hasApiKey,
  clearQlooCache,
} from "./qloo.js";
import { mockQlooGet } from "./mock-qloo.js";
import { parseIntent, MOOD_LOOKUP, DEFAULT_MOOD, MOOD_IDS } from "./intent.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAX_QLOO_CALLS = 6;
const CITY = "Hong Kong";
const SLOT_TIMES = ["Morning", "Midday", "Afternoon"];

const SLOT_KINDS = {
  Morning: ["park", "outdoors"],
  Midday: ["museum", "gallery", "exhibit"],
  Afternoon: ["cafe", "cinema", "movie theater", "bookstore", "book"],
};

async function loadJson(name) {
  const file = path.join(root, "data", name);
  return JSON.parse(await readFile(file, "utf8"));
}

function entitiesFrom(body) {
  const results = body && body.results;
  if (Array.isArray(results)) return results;
  if (results && Array.isArray(results.entities)) return results.entities;
  return [];
}

function tagsFrom(body) {
  const tags = body && body.results && body.results.tags;
  return Array.isArray(tags) ? tags : [];
}

export function pickTag(tags, query, preferTypes = []) {
  const wanted = String(query || "").trim().toLowerCase();
  const usable = tags.filter((tag) => tag && tag.id);
  const exact = usable.filter((tag) => String(tag.name || "").trim().toLowerCase() === wanted);
  for (const type of preferTypes) {
    const hit = exact.find((tag) => tag.type === type);
    if (hit) return hit;
  }
  const partial = usable.filter((tag) => String(tag.name || "").toLowerCase().includes(wanted));
  for (const type of preferTypes) {
    const hit = partial.find((tag) => tag.type === type);
    if (hit) return hit;
  }
  return exact[0] || partial[0] || null;
}

function paramsFromUrl(url) {
  if (!url) return {};
  try {
    const u = new URL(url);
    const out = { path: u.pathname };
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function affinityOf(entity) {
  const q = entity && entity.query;
  if (q && typeof q.affinity === "number") return q.affinity;
  if (typeof entity.affinity === "number") return entity.affinity;
  return 0;
}

function kindOf(entity) {
  const subtype = String(entity.subtype || "").toLowerCase();
  const tags = Array.isArray(entity.tags) ? entity.tags : [];
  const tagNames = tags.map((t) => String(t.name || t || "").toLowerCase());
  const blob = [subtype, ...tagNames, String(entity.name || "").toLowerCase()].join(" ");
  if (/park|outdoor/.test(blob)) return "park";
  if (/museum|galler|exhibit/.test(blob)) return "museum";
  if (/cinema|movie\s*theater|film/.test(blob)) return "cinema";
  if (/cafe|coffee|tea\s*house/.test(blob)) return "cafe";
  if (/book/.test(blob)) return "bookstore";
  if (subtype.includes("place:")) return subtype.split(":").pop() || "place";
  return "place";
}

function addressOf(entity) {
  const props = entity && entity.properties;
  if (!props) return null;
  if (typeof props.address === "string") return props.address;
  if (props.location && typeof props.location.address === "string") return props.location.address;
  return null;
}

/**
 * Slot windows on Saturday (local clock, HH:MM 24h).
 * Morning 08–11, Midday 11–15, Afternoon 15–20.
 */
const SLOT_WINDOWS = {
  Morning: { start: 8 * 60, end: 11 * 60 },
  Midday: { start: 11 * 60, end: 15 * 60 },
  Afternoon: { start: 15 * 60, end: 20 * 60 },
};

function parseHm(value) {
  // Accepts "HH:MM", "HH:MM:SS", and the live Qloo form "THH:MM:SS".
  const m = String(value == null ? "" : value)
    .trim()
    .match(/^T?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * One opening interval vs a slot window. opens == closes → open all day;
 * closes < opens → crosses midnight (split into [opens, 24h) and [0, closes)).
 * Returns true/false, or null when the interval is unreadable.
 */
function intervalCoversSlot(interval, window) {
  if (!interval || typeof interval !== "object") return null;
  if (interval.closed === true) return false;
  const open = parseHm(interval.opens != null ? interval.opens : interval.open);
  const close = parseHm(interval.closes != null ? interval.closes : interval.close);
  if (open == null || close == null) return null;
  if (open === close) return true;
  if (close > open) return overlaps(open, close, window.start, window.end);
  return (
    overlaps(open, 24 * 60, window.start, window.end) || overlaps(0, close, window.start, window.end)
  );
}

/**
 * Saturday hours check. Supports the live Qloo shape
 * `properties.hours.saturday = [{ opens: "T10:00:00", closes: "T18:00:00", closed }]`
 * and the fixture shape `{ open: "10:00", close: "18:00" }` / `{ closed: true }`.
 * Missing or unreadable hours keep the place.
 */
export function openOnSaturdaySlot(entity, slot) {
  const hours = entity && entity.properties && entity.properties.hours;
  if (!hours || typeof hours !== "object") return true; // no hours → keep
  const sat = hours.saturday || hours.Saturday || hours.sat;
  const window = SLOT_WINDOWS[slot];
  if (!sat || !window) return true;
  const intervals = Array.isArray(sat) ? sat : [sat];
  if (intervals.length === 0) return true;
  let readable = false;
  for (const interval of intervals) {
    const r = intervalCoversSlot(interval, window);
    if (r === true) return true;
    if (r === false) readable = true;
  }
  return !readable; // only unreadable entries → keep
}

function fitsSlot(entity, slot) {
  const kind = kindOf(entity);
  const wanted = SLOT_KINDS[slot] || [];
  return wanted.some((w) => kind.includes(w) || w.includes(kind));
}

function summarizeMoods(moodFile) {
  return moodFile.moods.map((m) => ({ id: m.id, label: m.label, blurb: m.blurb }));
}

/**
 * Create a client that routes to live or mock, tracks call budget, and
 * records trace steps. On 401 / timeout / budget → marks fallback and can
 * switch to mock.
 */
function createClient(initialSource) {
  let source = initialSource; // "qloo-live" | "mock"
  let qlooCalls = 0;
  let fallbackReason = null;
  const trace = [];
  let keyUsed = false;
  let requestSent = false;

  const controller = new AbortController();
  let budgetTimer = null;
  let budgetExceeded = false;

  function startBudget() {
    // Keep this timer ref'd so a live call whose fetch only waits on AbortSignal
    // cannot let the process drain before the budget fires.
    budgetTimer = setTimeout(() => {
      budgetExceeded = true;
      controller.abort();
    }, qlooConfig.requestBudgetMs);
  }

  function stopBudget() {
    if (budgetTimer) clearTimeout(budgetTimer);
    budgetTimer = null;
  }

  function pushTrace(step) {
    // Structural guarantee: never put the key into trace.
    const safe = {
      tool: step.tool,
      path: step.path || null,
      params: step.params || {},
      status: step.status,
      ms: step.ms ?? null,
      cached: step.cached === true,
      decision: step.decision || "",
    };
    trace.push(safe);
  }

  async function call(kind, params, decision) {
    const started = Date.now();
    if (budgetExceeded || controller.signal.aborted) {
      fallbackReason = fallbackReason || "QLOO_BUDGET_EXCEEDED";
      pushTrace({
        tool: `qloo.${kind}`,
        path: null,
        params: {},
        status: "budget",
        ms: 0,
        cached: false,
        decision: decision || "budget already exceeded; skip call",
      });
      return { ok: false, code: "QLOO_BUDGET_EXCEEDED", sent: false };
    }

    if (source === "qloo-live" && qlooCalls >= MAX_QLOO_CALLS) {
      fallbackReason = fallbackReason || "QLOO_BUDGET_EXCEEDED";
      source = "mock";
      pushTrace({
        tool: `qloo.${kind}`,
        path: null,
        params: {},
        status: "limit",
        ms: 0,
        cached: false,
        decision: "max Qloo calls reached; switching to mock",
      });
    }

    const useMock = source === "mock";
    let result;
    if (useMock) {
      result = await mockQlooGet(kind, params);
    } else {
      qlooCalls += 1;
      const onSend = (url) => {
        requestSent = true;
        keyUsed = true;
      };
      // Race against abort: a fetch that ignores the signal must not hang the agent.
      result = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const onAbort = () => {
          finish({
            ok: false,
            sent: requestSent,
            code: budgetExceeded ? "QLOO_BUDGET_EXCEEDED" : "QLOO_TIMEOUT",
            error: budgetExceeded
              ? "The request time budget ran out."
              : "Qloo request timed out before a response arrived.",
            url: null,
          });
        };
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
        qlooGet(kind, params, { signal: controller.signal, onSend }).then(
          (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            finish(value);
          },
          (err) => {
            controller.signal.removeEventListener("abort", onAbort);
            finish({
              ok: false,
              sent: true,
              code: "QLOO_NETWORK_ERROR",
              error: "Qloo request failed before a response arrived.",
              url: null,
            });
          }
        );
      });
    }

    const ms = result.ms != null ? result.ms : Date.now() - started;
    const urlParams = paramsFromUrl(result.url);
    const pathName = urlParams.path || null;
    delete urlParams.path;

    let status = "ok";
    if (!result.ok) {
      if (result.code === "QLOO_TIMEOUT" || result.code === "QLOO_BUDGET_EXCEEDED") status = "timeout";
      else if (result.status === 401) status = 401;
      else if (result.status) status = result.status;
      else status = result.code || "error";
    } else if (result.cached) {
      status = "cache";
    } else if (useMock) {
      status = "mock";
    }

    pushTrace({
      tool: useMock ? `mock.${kind}` : `qloo.${kind}`,
      path: pathName,
      params: urlParams,
      status,
      ms,
      cached: result.cached === true,
      decision: decision || "",
    });

    // Fallback triggers for live → mock
    if (!useMock && !result.ok) {
      const is401 = result.status === 401;
      const isTimeout =
        result.code === "QLOO_TIMEOUT" ||
        result.code === "QLOO_BUDGET_EXCEEDED" ||
        budgetExceeded;
      const isMissing = result.code === "QLOO_API_KEY_MISSING";
      if (is401 || isTimeout || isMissing) {
        fallbackReason =
          fallbackReason ||
          (is401 ? "QLOO_HTTP_401" : isMissing ? "QLOO_API_KEY_MISSING" : result.code || "QLOO_TIMEOUT");
        source = "mock";
        pushTrace({
          tool: "mode.fallback",
          path: null,
          params: {},
          status: "fallback",
          ms: 0,
          cached: false,
          decision: `live failed (${fallbackReason}); switching to mock`,
        });
        // Retry once via mock
        const retry = await mockQlooGet(kind, params);
        const retryParams = paramsFromUrl(retry.url);
        const retryPath = retryParams.path || null;
        delete retryParams.path;
        pushTrace({
          tool: `mock.${kind}`,
          path: retryPath,
          params: retryParams,
          status: retry.ok ? "mock" : retry.code || "error",
          ms: retry.ms ?? 0,
          cached: false,
          decision: "retry after live failure",
        });
        return { ...retry, source: "mock" };
      }
    }

    return { ...result, source: useMock ? "mock" : "qloo-live" };
  }

  return {
    call,
    startBudget,
    stopBudget,
    getTrace: () => trace,
    getSource: () => source,
    getFallbackReason: () => fallbackReason,
    setFallbackReason: (r) => {
      if (!fallbackReason) fallbackReason = r;
    },
    setSource: (s) => {
      source = s;
    },
    wasKeyUsed: () => keyUsed,
    wasRequestSent: () => requestSent,
    signal: controller.signal,
  };
}

function normalizeEntity(entity) {
  return {
    id: entity.entity_id || entity.id,
    name: entity.name || "Unknown place",
    kind: kindOf(entity),
    affinity: affinityOf(entity),
    address: addressOf(entity),
    raw: entity,
  };
}

/**
 * Assign up to three stops (Morning/Midday/Afternoon), unique kinds,
 * preferring slot fit and affinity. Filter by Saturday hours when present.
 */
export function assembleStops(candidates, catalog, signals = [], source = "mock") {
  const usable = [];
  for (const entity of candidates) {
    if (!entity || !(entity.entity_id || entity.id)) continue;
    usable.push(normalizeEntity(entity));
  }
  usable.sort((a, b) => b.affinity - a.affinity);

  const usedIds = new Set();
  const usedKinds = new Set();
  const stops = [];
  const signalText = signals.filter(Boolean).join(", ") || "taste signals";

  for (const time of SLOT_TIMES) {
    let pick = usable.find(
      (e) =>
        !usedIds.has(e.id) &&
        !usedKinds.has(e.kind) &&
        fitsSlot(e.raw, time) &&
        openOnSaturdaySlot(e.raw, time)
    );
    if (!pick) {
      pick = usable.find(
        (e) => !usedIds.has(e.id) && !usedKinds.has(e.kind) && openOnSaturdaySlot(e.raw, time)
      );
    }
    if (!pick) continue;
    usedIds.add(pick.id);
    usedKinds.add(pick.kind);
    const affinityStr =
      typeof pick.affinity === "number" && pick.affinity > 0
        ? ` ${source === "qloo-live" ? "Qloo" : "Demo"} affinity ${pick.affinity.toFixed(2)}.`
        : "";
    const addr = pick.address ? ` Address: ${pick.address}.` : "";
    stops.push({
      day: "Saturday",
      time,
      kind: pick.kind,
      filledFromCatalog: false,
      reason: `Matched ${signalText}.${affinityStr}${addr}`.trim(),
      place: {
        id: pick.id,
        name: pick.name,
        kind: pick.kind,
        area: pick.address || CITY,
        note: pick.address || "",
        affinity: pick.affinity,
        address: pick.address,
        signals: signals.slice(),
      },
    });
  }

  // Fill from local catalog if fewer than 3
  if (stops.length < 3 && catalog && Array.isArray(catalog.places)) {
    const byKind = {
      Morning: ["park"],
      Midday: ["museum"],
      Afternoon: ["cafe", "cinema"],
    };
    for (const time of SLOT_TIMES) {
      if (stops.some((s) => s.time === time)) continue;
      const wanted = byKind[time] || [];
      const place = catalog.places.find(
        (p) => wanted.includes(p.kind) && !usedIds.has(p.id) && !usedKinds.has(p.kind)
      ) ||
        catalog.places.find((p) => !usedIds.has(p.id) && !usedKinds.has(p.kind)) ||
        catalog.places.find((p) => !usedIds.has(p.id));
      if (!place) continue;
      usedIds.add(place.id);
      usedKinds.add(place.kind);
      stops.push({
        day: "Saturday",
        time,
        kind: place.kind,
        filledFromCatalog: true,
        reason: `Local catalog fill for ${time}: ${source === "qloo-live" ? "Qloo" : "demo data"} did not yield enough distinct place types.`,
        place: {
          id: place.id,
          name: place.name,
          kind: place.kind,
          area: place.area,
          note: place.note,
          affinity: null,
          address: null,
          signals: ["catalog.fill"],
        },
      });
    }
    stops.sort((a, b) => SLOT_TIMES.indexOf(a.time) - SLOT_TIMES.indexOf(b.time));
  }

  return stops.slice(0, 3);
}

async function catalogFillPlan(moodId, reason) {
  const [moodFile, catalog] = await Promise.all([loadJson("moods.json"), loadJson("catalog.json")]);
  const moods = summarizeMoods(moodFile);
  const requested = moodId && MOOD_IDS.includes(moodId) ? moodId : DEFAULT_MOOD;
  const mood = moodFile.moods.find((m) => m.id === requested);
  const byId = new Map(catalog.places.map((p) => [p.id, p]));
  const stops = mood.stops.map((pick) => {
    const place = byId.get(pick.placeId);
    return {
      day: "Saturday",
      time: pick.time,
      kind: place.kind,
      filledFromCatalog: true,
      reason: pick.reason,
      place: {
        id: place.id,
        name: place.name,
        kind: place.kind,
        area: place.area,
        note: place.note,
        affinity: null,
        address: null,
        signals: ["catalog.fill"],
      },
    };
  });
  return {
    ok: true,
    status: 200,
    source: "local-catalog",
    keyUsed: false,
    requestSent: false,
    city: catalog.city,
    day: "Saturday",
    catalogNote: catalog.note,
    mood: mood ? { id: mood.id, label: mood.label, blurb: mood.blurb } : null,
    moods,
    intent: { interests: [], mood: requested, raw: "" },
    error: null,
    code: null,
    fallback: true,
    fallbackReason: reason || "LOCAL_CATALOG",
    stops,
    trace: [
      {
        tool: "catalog.fill",
        path: null,
        params: { mood: requested },
        status: "ok",
        ms: 0,
        cached: false,
        decision: reason || "local catalog only",
      },
    ],
  };
}

/**
 * Run the agent for one request.
 * @param {{ q?: string, mood?: string }} input
 */
export async function runAgent(input = {}) {
  const intent = parseIntent(input);
  const [moodFile, catalog] = await Promise.all([loadJson("moods.json"), loadJson("catalog.json")]);
  const moods = summarizeMoods(moodFile);

  if (!intent.ok) {
    return {
      ok: false,
      status: 400,
      source: "local-catalog",
      keyUsed: false,
      requestSent: false,
      city: catalog.city,
      day: "Saturday",
      error: intent.error,
      moods,
      stops: undefined,
      trace: [],
      fallback: true,
      fallbackReason: "BAD_INPUT",
    };
  }

  const mode = resolveMode();
  let initialSource = mode === "live" ? "qloo-live" : "mock";
  // live mode without a key → treat as missing key, fall to mock immediately
  if (mode === "live" && !hasApiKey()) {
    initialSource = "mock";
  }
  const client = createClient(initialSource);
  if (mode === "live" && !hasApiKey()) {
    client.setFallbackReason("QLOO_API_KEY_MISSING");
    client.getTrace().push({
      tool: "mode.fallback",
      path: null,
      params: {},
      status: "fallback",
      ms: 0,
      cached: false,
      decision: "live mode but no key; using mock",
    });
  }

  client.startBudget();
  const signals = [];
  let candidates = [];

  try {
    const moodKey = intent.mood || DEFAULT_MOOD;
    const lookup = MOOD_LOOKUP[moodKey] || MOOD_LOOKUP[DEFAULT_MOOD];

    // Parallel search for each interest
    const searchResults = await Promise.all(
      intent.interests.map((interest, i) =>
        client.call(
          "search",
          { query: interest, take: 5 },
          `resolve interest ${i + 1}: ${interest}`
        )
      )
    );

    const entityIds = [];
    for (let i = 0; i < searchResults.length; i++) {
      const r = searchResults[i];
      if (!r.ok) continue;
      const entities = entitiesFrom(r.body);
      const hit = entities.find((e) => e && (e.entity_id || e.id));
      if (hit) {
        const id = hit.entity_id || hit.id;
        entityIds.push(id);
        signals.push(hit.name || intent.interests[i]);
      }
    }

    // Mood / atmosphere tag
    const tagQuery = intent.mood ? lookup.tagQuery : intent.interests[0] || lookup.tagQuery;
    const tagsResult = await client.call(
      "tags",
      { query: tagQuery, take: 20 },
      `resolve tag for "${tagQuery}"`
    );
    let tag = null;
    if (tagsResult.ok) {
      tag = pickTag(tagsFrom(tagsResult.body), tagQuery, lookup.preferTypes || []);
      if (tag) signals.push(tag.name || tagQuery);
    }

    // Insights: prefer entities+tags, then relax
    async function insightsWith(params, decision) {
      return client.call(
        "insights",
        {
          filterType: "urn:entity:place",
          locationQuery: CITY,
          take: 10,
          ...params,
        },
        decision
      );
    }

    // Relaxation chain (README): entities + tag → drop tag → strongest entity
    // → tag only → mood tag. Stops at the first non-empty result or error.
    const isEmpty = (r) => r && r.ok && entitiesFrom(r.body).length === 0;
    let insights = null;
    let lastParams = null;
    async function attempt(params, decision) {
      lastParams = params;
      insights = await insightsWith(params, decision);
      return insights;
    }

    if (entityIds.length && tag) {
      await attempt({ entities: entityIds.join(","), tags: tag.id }, "insights with entities + tag");
      if (isEmpty(insights)) {
        await attempt({ entities: entityIds.join(",") }, "empty results; drop tag, keep entities");
      }
      if (isEmpty(insights) && entityIds.length > 1) {
        await attempt({ entities: entityIds[0] }, "empty results; keep strongest entity only");
      }
      if (isEmpty(insights)) {
        await attempt({ tags: tag.id }, "empty results; tag only");
      }
    } else if (entityIds.length) {
      await attempt({ entities: entityIds.join(",") }, "insights with entities");
      if (isEmpty(insights) && entityIds.length > 1) {
        await attempt({ entities: entityIds[0] }, "empty results; keep strongest entity only");
      }
    } else if (tag) {
      await attempt({ tags: tag.id }, "insights with tag only");
    } else {
      // No interest hits and no tag: try the mood entity first
      const moodSearch = await client.call(
        "search",
        { query: lookup.entityQuery, types: lookup.entityTypes, take: 5 },
        "no interest hits; search mood entity"
      );
      if (moodSearch.ok) {
        const ent = entitiesFrom(moodSearch.body).find((e) => e && (e.entity_id || e.id));
        if (ent) {
          const id = ent.entity_id || ent.id;
          signals.push(ent.name || lookup.entityQuery);
          await attempt({ entities: id }, "insights from mood entity");
        }
      }
    }

    // Last relaxation step: mood tag (skip if it is the same tag already tried)
    if (!insights || isEmpty(insights)) {
      {
        const moodTags = await client.call(
          "tags",
          { query: lookup.tagQuery, take: 20 },
          "fallback mood tag"
        );
        const moodTag = moodTags.ok
          ? pickTag(tagsFrom(moodTags.body), lookup.tagQuery, lookup.preferTypes || [])
          : null;
        if (moodTag && !(tag && moodTag.id === tag.id)) {
          await attempt({ tags: moodTag.id }, "empty/missing; use mood tag");
        }
      }
    }

    // 400 self-heal: drop the signals named in errors[].path and retry once
    if (insights && !insights.ok && insights.status === 400 && insights.body && lastParams) {
      const errors = Array.isArray(insights.body.errors) ? insights.body.errors : [];
      const badPaths = errors.map((e) => e && e.path).filter(Boolean).map(String);
      if (badPaths.length) {
        const retry = { ...lastParams };
        const named = (re) => badPaths.some((p) => re.test(p));
        if (named(/entities/)) delete retry.entities;
        if (named(/tags/)) delete retry.tags;
        const dropLocation = named(/location/);
        const hasSignal = Boolean(retry.entities || retry.tags);
        if (hasSignal) {
          const params = {
            filterType: "urn:entity:place",
            take: 10,
            ...retry,
          };
          if (!dropLocation) params.locationQuery = CITY;
          lastParams = retry;
          insights = await client.call(
            "insights",
            params,
            `HTTP 400; drop params ${badPaths.join(",")} and retry`
          );
        }
      }
    }

    if (insights && insights.ok) {
      candidates = entitiesFrom(insights.body);
    }

    // If still empty after live path, force mock insights once
    if (candidates.length === 0 && client.getSource() === "qloo-live") {
      client.setFallbackReason(client.getFallbackReason() || "EMPTY_RESULTS");
      client.setSource("mock");
      const mockInsight = await client.call(
        "insights",
        {
          filterType: "urn:entity:place",
          locationQuery: CITY,
          take: 10,
          tags: tag ? tag.id : undefined,
          entities: entityIds[0],
        },
        "live empty; mock insights"
      );
      if (mockInsight.ok) candidates = entitiesFrom(mockInsight.body);
    }

    if (candidates.length === 0 && client.getSource() !== "mock") {
      client.setSource("mock");
      const mockInsight = await client.call(
        "insights",
        { filterType: "urn:entity:place", locationQuery: CITY, take: 10 },
        "no candidates; mock default insights"
      );
      if (mockInsight.ok) candidates = entitiesFrom(mockInsight.body);
    }
  } finally {
    client.stopBudget();
  }

  let source = client.getSource();
  let fallbackReason = client.getFallbackReason();

  let stops = assembleStops(candidates, catalog, signals, source);

  if (stops.length < 3) {
    // catalog.fill already attempted inside assembleStops; if still short, full catalog plan
    if (stops.length === 0) {
      const local = await catalogFillPlan(intent.mood || DEFAULT_MOOD, fallbackReason || "LOCAL_CATALOG");
      local.trace = [...client.getTrace(), ...local.trace];
      local.keyUsed = client.wasKeyUsed();
      local.requestSent = client.wasRequestSent();
      local.intent = intent;
      return local;
    }
    client.getTrace().push({
      tool: "catalog.fill",
      path: null,
      params: {},
      status: "ok",
      ms: 0,
      cached: false,
      decision: `filled ${stops.filter((s) => s.filledFromCatalog).length} stop(s) from local catalog`,
    });
    if (stops.some((s) => s.filledFromCatalog) && source !== "local-catalog") {
      // keep mock/live source but note partial fill via fallbackReason if needed
      if (!fallbackReason) fallbackReason = "PARTIAL_CATALOG_FILL";
    }
  }

  // Map source to response header values
  const sourceHeader =
    source === "qloo-live" ? "qloo-live" : source === "mock" ? "mock" : "local-catalog";

  const moodMeta = intent.mood
    ? moods.find((m) => m.id === intent.mood) || null
    : null;

  return {
    ok: true,
    status: 200,
    source: sourceHeader,
    keyUsed: client.wasKeyUsed(),
    requestSent: client.wasRequestSent(),
    city: CITY,
    day: "Saturday",
    catalogNote: catalog.note,
    mood: moodMeta,
    moods,
    intent: {
      interests: intent.interests,
      mood: intent.mood,
      raw: intent.raw,
    },
    error: null,
    code: null,
    fallback: sourceHeader !== "qloo-live",
    fallbackReason: sourceHeader === "qloo-live" ? null : fallbackReason,
    stops,
    trace: client.getTrace(),
  };
}

export { clearQlooCache, loadJson };

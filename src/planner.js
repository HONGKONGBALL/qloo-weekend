/**
 * Local-catalog fallback and thin mood alias.
 * The agent owns the decision loop; this module keeps the catalog-only path
 * and re-exports runAgent for callers that still import planWeekend.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { DEFAULT_MOOD, MOOD_IDS } from "./intent.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { DEFAULT_MOOD };

export async function loadJson(name) {
  const file = path.join(root, "data", name);
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Mood-only entry used by /api/plan. Delegates to the agent.
 */
export async function planWeekend(moodId) {
  const mood = moodId && String(moodId).trim() ? String(moodId).trim() : DEFAULT_MOOD;
  return runAgent({ mood });
}

/**
 * Pure local catalog plan (no Qloo, no mock). Used when even mock fails.
 */
export async function planFromCatalog(moodId, reason = "LOCAL_CATALOG") {
  const [moodFile, catalog] = await Promise.all([
    loadJson("moods.json"),
    loadJson("catalog.json"),
  ]);
  const moods = moodFile.moods.map((m) => ({ id: m.id, label: m.label, blurb: m.blurb }));
  const requested = moodId && MOOD_IDS.includes(moodId) ? moodId : DEFAULT_MOOD;
  const mood = moodFile.moods.find((m) => m.id === requested);
  if (!mood) {
    return {
      ok: false,
      status: 400,
      source: "local-catalog",
      keyUsed: false,
      requestSent: false,
      city: catalog.city,
      day: "Saturday",
      error: `Unknown mood "${requested}". Choose one of: ${MOOD_IDS.join(", ")}.`,
      moods,
      stops: undefined,
      trace: [],
      fallback: true,
      fallbackReason: "BAD_INPUT",
    };
  }
  const byId = new Map(catalog.places.map((p) => [p.id, p]));
  const stops = mood.stops.map((pick) => {
    const place = byId.get(pick.placeId);
    if (!place) throw new Error(`Catalog is missing place ${pick.placeId}`);
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
    mood: { id: mood.id, label: mood.label, blurb: mood.blurb },
    moods,
    intent: { interests: [], mood: requested, raw: "" },
    error: null,
    code: null,
    fallback: true,
    fallbackReason: reason,
    stops,
    trace: [
      {
        tool: "catalog.fill",
        path: null,
        params: { mood: requested },
        status: "ok",
        ms: 0,
        cached: false,
        decision: reason,
      },
    ],
  };
}

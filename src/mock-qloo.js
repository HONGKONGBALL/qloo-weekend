/**
 * Self-written mock adapter. Returns the same envelope as live qlooGet
 * ({ ok, status, body: { results } }); fixture hours use a simplified
 * { open, close } form, which the agent accepts alongside the live
 * [{ opens, closes, closed }] array.
 * IDs are MOCK-* prefixes. Not a Qloo response.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUrl } from "./qloo.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fixture = null;

export function loadMockFixture(dir = root) {
  const file = path.join(dir, "data", "mock-qloo.json");
  fixture = JSON.parse(readFileSync(file, "utf8"));
  return fixture;
}

export function getMockFixture() {
  if (!fixture) loadMockFixture();
  return fixture;
}

export function resetMockFixture() {
  fixture = null;
}

function matchSearch(query) {
  const data = getMockFixture().search || {};
  const q = String(query || "").trim();
  if (q && data[q]) return data[q];
  const lower = q.toLowerCase();
  for (const [key, value] of Object.entries(data)) {
    if (key === "default") continue;
    if (key.toLowerCase() === lower || lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return value;
    }
  }
  return data.default || [];
}

function matchTags(query) {
  const data = getMockFixture().tags || {};
  const q = String(query || "").trim().toLowerCase();
  if (q && data[q]) return data[q];
  for (const [key, value] of Object.entries(data)) {
    if (key === "default") continue;
    if (key.toLowerCase() === q || q.includes(key.toLowerCase()) || key.toLowerCase().includes(q)) {
      return value;
    }
  }
  return data.default || [];
}

function matchInsights(params = {}) {
  const data = getMockFixture().insights || {};
  const tags = String(params.tags || "").split(",").map((s) => s.trim()).filter(Boolean);
  const entities = String(params.entities || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const tag of tags) {
    if (data.byTag && data.byTag[tag]) return data.byTag[tag];
  }
  for (const entity of entities) {
    if (data.byEntity && data.byEntity[entity]) return data.byEntity[entity];
  }
  return data.default || [];
}

/**
 * Mock GET. Never touches the network. Returns the same shape as qlooGet.
 */
export async function mockQlooGet(kind, params = {}) {
  const started = Date.now();
  const url = buildUrl(kind, params);
  getMockFixture();
  let body;
  if (kind === "search") {
    body = { success: true, results: matchSearch(params.query) };
  } else if (kind === "tags") {
    body = {
      success: true,
      results: { tags: matchTags(params.filterQuery ?? params.query) },
    };
  } else if (kind === "insights") {
    body = {
      success: true,
      results: { entities: matchInsights(params) },
    };
  } else {
    return {
      ok: false,
      sent: false,
      cached: false,
      source: "mock",
      code: "QLOO_PATH_BLOCKED",
      error: `Unknown mock call: ${kind}`,
      url,
      ms: Date.now() - started,
    };
  }
  return {
    ok: true,
    sent: false,
    cached: false,
    source: "mock",
    url,
    body,
    ms: Date.now() - started,
  };
}

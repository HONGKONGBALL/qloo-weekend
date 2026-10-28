/**
 * Client for the Qloo hackathon API.
 * Nothing is sent unless QLOO_API_KEY is set in the environment or in .env
 * (and QLOO_DOTENV is not off). The key is never logged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_URL = "https://hackathon.api.qloo.com";

const PATHS = {
  search: "/search",
  tags: "/v2/tags",
  insights: "/v2/insights",
};

/**
 * Limits for outbound calls. Tests can shorten them through the environment
 * or by editing qlooConfig. Defaults: 4 s per call, 10 s budget per incoming
 * request, cache entries live 10 minutes, at most 200 entries.
 */
function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const qlooConfig = {
  callTimeoutMs: envNumber("QLOO_CALL_TIMEOUT_MS", 4000),
  requestBudgetMs: envNumber("QLOO_REQUEST_BUDGET_MS", 10000),
  cacheTtlMs: envNumber("QLOO_CACHE_TTL_MS", 10 * 60 * 1000),
  cacheMax: envNumber("QLOO_CACHE_MAX", 200),
  now: () => Date.now(),
};

// In-memory cache of successful responses, keyed by the request URL, which
// encodes the call kind and every parameter. The API key is not in the key.
const cache = new Map();

export function clearQlooCache() {
  cache.clear();
}

export function qlooCacheSize() {
  return cache.size;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= qlooConfig.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit); // least-recently-used order
  return hit.value;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, { value, expires: qlooConfig.now() + qlooConfig.cacheTtlMs });
  while (cache.size > qlooConfig.cacheMax) {
    cache.delete(cache.keys().next().value);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load QLOO_API_KEY from a .env file in `dir` (default: project root).
 * Skipped when QLOO_DOTENV=off, or when the env already has a non-empty key.
 */
export function loadEnvFile(dir = root) {
  if (String(process.env.QLOO_DOTENV || "").trim().toLowerCase() === "off") return;
  if (process.env.QLOO_API_KEY && String(process.env.QLOO_API_KEY).trim()) return;
  let text;
  try {
    text = readFileSync(path.join(dir, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== "QLOO_API_KEY") continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env.QLOO_API_KEY = value;
  }
}

loadEnvFile();

/** True when a non-empty QLOO_API_KEY is present in the environment. */
export function hasApiKey() {
  return Boolean(process.env.QLOO_API_KEY && String(process.env.QLOO_API_KEY).trim());
}

/**
 * Resolve QLOO_MODE: live | mock | auto.
 * auto → live when a key is present, otherwise mock.
 */
export function resolveMode(envMode = process.env.QLOO_MODE, keyPresent = hasApiKey()) {
  const raw = String(envMode == null ? "auto" : envMode).trim().toLowerCase();
  if (raw === "live" || raw === "mock") return raw;
  return keyPresent ? "live" : "mock";
}

export function getMode() {
  return resolveMode();
}

function setParam(url, name, value) {
  if (value == null || value === "") return;
  url.searchParams.set(name, String(value));
}

export function missingKeyResult(url) {
  return {
    ok: false,
    sent: false,
    code: "QLOO_API_KEY_MISSING",
    error:
      "QLOO_API_KEY is missing. No request was sent. Set it in the environment or in a gitignored .env file.",
    url: url || null,
  };
}

export function buildSearchUrl(params = {}) {
  const url = new URL(PATHS.search, BASE_URL);
  setParam(url, "query", params.query);
  setParam(url, "types", params.types);
  setParam(url, "take", params.take);
  return url.toString();
}

export function buildTagsUrl(params = {}) {
  const url = new URL(PATHS.tags, BASE_URL);
  setParam(url, "filter.query", params.filterQuery ?? params.query);
  setParam(url, "take", params.take);
  return url.toString();
}

export function buildInsightsUrl(params = {}) {
  const url = new URL(PATHS.insights, BASE_URL);
  url.searchParams.set("filter.type", params.filterType || "urn:entity:place");
  setParam(url, "signal.interests.tags", params.tags);
  setParam(url, "signal.interests.entities", params.entities);
  setParam(url, "filter.tags", params.filterTags);
  setParam(url, "filter.location.query", params.locationQuery);
  setParam(url, "take", params.take);
  return url.toString();
}

export function buildUrl(kind, params = {}) {
  if (kind === "search") return buildSearchUrl(params);
  if (kind === "tags") return buildTagsUrl(params);
  if (kind === "insights") return buildInsightsUrl(params);
  throw new Error(`Unknown Qloo call: ${kind}`);
}

export function buildHeaders() {
  const raw = process.env.QLOO_API_KEY;
  if (!raw || !String(raw).trim()) {
    return missingKeyResult();
  }
  return {
    ok: true,
    headers: {
      "X-Api-Key": String(raw).trim(),
      Accept: "application/json",
    },
  };
}

function publicText(value) {
  const text = String(value ?? "");
  const secret = process.env.QLOO_API_KEY;
  if (secret && text.includes(secret)) return text.split(secret).join("[redacted]");
  return text;
}

export function explainHttpError(status, body) {
  const message = extractMessage(body);
  if (message) return `Qloo responded with HTTP ${status}: ${publicText(message)}`;
  return `Qloo responded with HTTP ${status}`;
}

function extractMessage(body) {
  if (typeof body === "string") {
    if (/gateway time-?out/i.test(body) || /\b504\b/.test(body)) return "gateway timeout";
    if (/<html/i.test(body)) return "non-JSON error page";
    const trimmed = body.trim();
    return trimmed ? trimmed.slice(0, 240) : null;
  }
  if (!body || typeof body !== "object") return null;
  const errors = body.errors;
  if (Array.isArray(errors) && errors[0] && errors[0].message) return String(errors[0].message);
  if (typeof body.error === "string") return body.error;
  if (body.error && body.error.message) return String(body.error.message);
  if (typeof body.message === "string") return body.message;
  return null;
}

/**
 * Builds the URL and headers. If the key is missing, returns an error and
 * does not call fetch. Each call has its own AbortController timeout, and an
 * optional outer `options.signal` (the per-request budget) also aborts it.
 * Successful responses are cached in memory.
 */
export async function qlooGet(kind, params = {}, options = {}) {
  const url = buildUrl(kind, params);
  const headers = buildHeaders();
  if (!headers.ok) {
    return { ...missingKeyResult(url), sent: false };
  }

  const target = new URL(url);
  const allowed = new URL(BASE_URL);
  if (target.origin !== allowed.origin) {
    return {
      ok: false,
      sent: false,
      code: "QLOO_HOST_BLOCKED",
      error: "Refusing to call any host other than https://hackathon.api.qloo.com",
      url,
    };
  }
  const blocked = new Set(["/recommendations", "/recs", "/v2/insights/search", "/v2/trending"]);
  if (blocked.has(target.pathname)) {
    return {
      ok: false,
      sent: false,
      code: "QLOO_PATH_BLOCKED",
      error: `Refusing unsupported path ${target.pathname}`,
      url,
    };
  }

  const cached = cacheGet(url);
  if (cached) return { ...cached, sent: false, cached: true }; // served from memory, nothing went out

  const outer = options.signal;
  if (outer && outer.aborted) {
    return {
      ok: false,
      sent: false,
      code: "QLOO_TIMEOUT",
      error: "The request time budget ran out before this Qloo call.",
      url,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || qlooConfig.callTimeoutMs);
  // A pending per-call timer must not keep the process alive.
  if (typeof timer.unref === "function") timer.unref();
  const onOuterAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (outer) outer.addEventListener("abort", onOuterAbort, { once: true });
  const timeoutResult = {
    ok: false,
    sent: true,
    code: "QLOO_TIMEOUT",
    error: "Qloo request timed out before a response arrived.",
    url,
  };

  let response;
  let text;
  if (typeof options.onSend === "function") options.onSend(url);
  try {
    try {
      response = await fetch(url, {
        method: "GET",
        headers: headers.headers,
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut =
        controller.signal.aborted || (err && (err.name === "TimeoutError" || err.name === "AbortError"));
      if (timedOut) return timeoutResult;
      return {
        ok: false,
        sent: true,
        code: "QLOO_NETWORK_ERROR",
        error: "Qloo request failed before a response arrived.",
        url,
      };
    }
    try {
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) return timeoutResult;
      throw err;
    }
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }

  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    return {
      ok: false,
      sent: true,
      code: "QLOO_HTTP_ERROR",
      status: response.status,
      error: explainHttpError(response.status, body),
      url,
      body,
    };
  }
  const result = { ok: true, sent: true, source: "qloo", url, body };
  cacheSet(url, result);
  return result;
}

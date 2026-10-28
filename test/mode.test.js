import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate from any real .env before importing qloo.
const savedKey = process.env.QLOO_API_KEY;
const savedMode = process.env.QLOO_MODE;
const savedDotenv = process.env.QLOO_DOTENV;
delete process.env.QLOO_API_KEY;
process.env.QLOO_DOTENV = "off";
delete process.env.QLOO_MODE;

const qloo = await import("../src/qloo.js");
const mock = await import("../src/mock-qloo.js");
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.QLOO_API_KEY;
  else process.env.QLOO_API_KEY = savedKey;
  if (savedMode === undefined) delete process.env.QLOO_MODE;
  else process.env.QLOO_MODE = savedMode;
  if (savedDotenv === undefined) delete process.env.QLOO_DOTENV;
  else process.env.QLOO_DOTENV = savedDotenv;
});

test("resolveMode: live, mock, auto with and without key", () => {
  assert.equal(qloo.resolveMode("live", true), "live");
  assert.equal(qloo.resolveMode("live", false), "live");
  assert.equal(qloo.resolveMode("mock", true), "mock");
  assert.equal(qloo.resolveMode("mock", false), "mock");
  assert.equal(qloo.resolveMode("auto", true), "live");
  assert.equal(qloo.resolveMode("auto", false), "mock");
  assert.equal(qloo.resolveMode("AUTO", true), "live");
  assert.equal(qloo.resolveMode(undefined, false), "mock");
  assert.equal(qloo.resolveMode("other", true), "live");
});

test("QLOO_DOTENV=off does not read .env even when a fake file exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qloo-dotenv-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, ".env"), "QLOO_API_KEY=should-not-load-from-dotenv\n");
  delete process.env.QLOO_API_KEY;
  process.env.QLOO_DOTENV = "off";
  qloo.loadEnvFile(dir);
  assert.equal(process.env.QLOO_API_KEY, undefined);

  // When dotenv is allowed, the same file loads.
  delete process.env.QLOO_DOTENV;
  delete process.env.QLOO_API_KEY;
  qloo.loadEnvFile(dir);
  assert.equal(process.env.QLOO_API_KEY, "should-not-load-from-dotenv");
  delete process.env.QLOO_API_KEY;
  process.env.QLOO_DOTENV = "off";
});

test("mock fixture: note present and every id starts with MOCK-", () => {
  mock.resetMockFixture();
  const fixture = mock.loadMockFixture();
  assert.match(fixture.note, /Self-written demo fixture/i);
  assert.match(fixture.note, /Not a Qloo response/i);
  const ids = [];
  function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if ((k === "entity_id" || k === "id") && typeof v === "string") ids.push(v);
        else walk(v);
      }
    }
  }
  walk(fixture);
  assert.ok(ids.length > 10, `expected many ids, got ${ids.length}`);
  for (const id of ids) assert.ok(id.startsWith("MOCK-"), id);
});

test("mockQlooGet returns live-shaped bodies without network", async () => {
  const search = await mock.mockQlooGet("search", { query: "In the Mood for Love" });
  assert.equal(search.ok, true);
  assert.equal(search.source, "mock");
  assert.equal(search.sent, false);
  assert.ok(Array.isArray(search.body.results));
  assert.ok(search.body.results[0].entity_id.startsWith("MOCK-"));

  const tags = await mock.mockQlooGet("tags", { query: "museum" });
  assert.equal(tags.ok, true);
  assert.ok(tags.body.results.tags[0].id.startsWith("MOCK-"));

  const insights = await mock.mockQlooGet("insights", {
    tags: "MOCK-TAG-MUSEUM",
    locationQuery: "Hong Kong",
    take: 10,
  });
  assert.equal(insights.ok, true);
  assert.ok(insights.body.results.entities.length >= 1);
  assert.ok(insights.body.results.entities[0].entity_id.startsWith("MOCK-"));
});

test("401 from live path is reported so agent can fall to mock", async () => {
  process.env.QLOO_API_KEY = "fake-key-for-401-test";
  qloo.clearQlooCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const result = await qloo.qlooGet("tags", { query: "park" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.code, "QLOO_HTTP_ERROR");
    assert.ok(!JSON.stringify(result).includes("fake-key-for-401-test"));
  } finally {
    globalThis.fetch = orig;
    delete process.env.QLOO_API_KEY;
  }
});

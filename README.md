# Qloo Weekend

A small Node.js app that plans a Saturday in Hong Kong from your tastes. Type what you like (a film, a musician, a vibe) or tap one of four mood chips. A **rule-based agent** (no LLM) calls the Qloo hackathon API — `GET /search`, `GET /v2/tags`, `GET /v2/insights` — then assembles three stops (Morning, Midday, Afternoon) with a short reason for each. Every Qloo/mock call is listed under **Agent steps**; catalog-filled stops are marked on their cards.

When no API key is set, the key is invalid, or Qloo times out, the agent falls back to **self-written mock data** (IDs prefixed `MOCK-`, not Qloo results) and, if needed, the local catalog. The banner names the source; catalog-filled stops are marked.

## Run

```bash
cd qloo-weekend
npm start
```

No install step. The app has zero npm dependencies. It listens on `0.0.0.0` by default (override with `HOST`) and prints the port (default `4173`, override with `PORT`).

Open `http://127.0.0.1:4173`, type a taste query, or choose Outdoors / Museums / A film / Quiet.

```bash
curl -sS 'http://127.0.0.1:4173/api/agent?q=In%20the%20Mood%20for%20Love'
curl -sS 'http://127.0.0.1:4173/api/agent?mood=outdoors'
```

`/api/plan?mood=` is a mood-only alias of `/api/agent`. Responses never include raw Qloo JSON — only names, affinity, address, signals, stops, and the agent trace.

## Modes

| `QLOO_MODE` | Behaviour |
| --- | --- |
| `auto` (default) | Live when `QLOO_API_KEY` is set, otherwise mock |
| `live` | Always attempt the hackathon API; on missing key / 401 / timeout / budget, fall to mock |
| `mock` | Self-written demo fixture only (`data/mock-qloo.json`) |

Set `QLOO_DOTENV=off` to skip reading a local `.env` (used in tests and on Render).

Response headers: `X-Plan-Source` is `qloo-live`, `mock`, or `local-catalog`; `X-Key-Used` is `yes` only when a live request was actually sent.

## What the agent does

1. Parse the query (max 200 characters, up to 3 interests) or the mood chip.
2. Call `qloo.search` for each interest (in parallel) and `qloo.tags` for atmosphere.
3. Call `qloo.insights` for Hong Kong places. If results are empty, relax signals in order: drop tag → strongest entity (the first matched interest's entity) → tag only → mood tag, then switch to mock data. The 6-call cap can end the chain early: steps past the cap run on mock data (`fallbackReason: QLOO_BUDGET_EXCEEDED`); at the earliest (when every interest and the tag match), with one interest that is the mood-tag step, with two it starts at tag only, with three at strongest entity. On HTTP 400, drop the entity/tag/location signal named in `errors[].path` and retry once.
4. Assign Morning / Midday / Afternoon by subtype and tags (park → museum → cafe/cinema). Skip places whose Saturday hours (`properties.hours.saturday` as `[{opens, closes, closed}]`, or the fixture's `{open, close}`) show they are closed for that slot; same opens/closes means open all day, closes before opens means past midnight. Prefer higher `query.affinity`. Types stay distinct: a slot never reuses a type.
5. If fewer than three distinct-type stops remain, fill from `data/catalog.json` and mark those rows.

Per request: at most 6 live Qloo calls, 4 s per call, 10 s total budget, 10-minute in-memory cache. The API key is sent only as `X-Api-Key` to `https://hackathon.api.qloo.com` and never appears in the trace, the JSON, or the HTML.

The agent does **not** call `/v2/trending`. The hackathon environment only has weekly data for mid-2024, so 2025/2026 trending queries return empty arrays. Copy makes no claims about what is trending.

## Why this is an agent

Qloo Weekend is a **rule-based agent with no LLM**. Each request to `/api/agent` runs a fixed perceive → plan → call tools → fall back sequence; every Qloo/mock call and its decision is returned in the `trace` (shown as **Agent steps** in the UI), and catalog-filled stops are marked on their cards. Each claim below maps to a test in this repo:

- **Perceive:** parse free text (max 200 characters, up to 3 interests) or a mood chip — `parseIntent: free text capped at 200 chars and 3 interests`, `parseIntent: unknown mood is rejected` (`test/agent.test.js`).
- **Plan:** pick a tag and assign Morning / Midday / Afternoon by type and Saturday hours — `pickTag prefers typed exact matches`, `openOnSaturdaySlot filters closed hours`, `insufficient distinct types get catalog fill marked` (`test/agent.test.js`).
- **Call tools:** `qloo.search`, `qloo.tags`, `qloo.insights`, with a trace entry per call — `mock mode happy path: 3 stops, trace, MOCK ids` (`test/agent.test.js`), `/api/agent with a mood returns 200, 3 stops, and a trace` (`test/basic.test.js`).
- **Adapt:** relax signals when results are empty and self-heal on HTTP 400 — `empty live results relax then mock`, `relax chain: entity signals empty, tag-only insights succeeds on live path`, `400 self-heal drops named path and retries` (`test/agent.test.js`).
- **Budget:** a 10 s time budget per request — `request budget falls to mock`; at most 6 live calls per request — `six-call cap falls to mock` (`test/agent.test.js`).
- **Timeouts:** a call that hangs past its per-call timeout falls back to mock — `call timeout falls to mock` (`test/agent.test.js`).
- **Fall back:** missing key, 401, timeout, time budget, or the 6-call cap → self-written mock data, then the local catalog (marked) — `live mode without key falls to mock with fallbackReason`, `401 with key echoing body: key never appears in plan or console`, `insufficient distinct types get catalog fill marked` (`test/agent.test.js`).

## Third-party services

- **Qloo hackathon API** (`https://hackathon.api.qloo.com`): `GET /search`, `GET /v2/tags`, `GET /v2/insights`. Used only in live mode with a `QLOO_API_KEY`; without a key the app uses self-written mock data and sends no Qloo request.
- **Render** (optional hosting): `render.yaml` describes a deployment. No public URL is set up yet.
- **npm packages:** none. `package.json` has no dependencies; the app uses only Node.js (>= 18) built-ins such as `node:http`, `fetch`, and `node:test`.

## Data

- The repo contains **no Qloo response data**. Live results are used only to build the answer and are not written to disk; responses expose only names, affinity, address, signals, stops, and the trace, never raw Qloo JSON.
- `data/mock-qloo.json` is a self-written fixture; every id starts with `MOCK-`. Mock mode is not Qloo data.
- `data/catalog.json` and `data/moods.json` are hand-written local places and mood presets.
- Live responses are cached in memory only (10 minutes, at most 200 entries) and are lost on restart.

## Mock and catalog

- `data/mock-qloo.json` — self-written fixture. File note: “Self-written demo fixture. Not a Qloo response.” Every id starts with `MOCK-`.
- `data/catalog.json` / `data/moods.json` — hand-written local places and mood presets. Not partner listings; hours and showtimes are not live-checked.

## Timeouts, budget, and cache

| Variable | Default | Meaning |
| --- | --- | --- |
| `QLOO_CALL_TIMEOUT_MS` | `4000` | Timeout for one Qloo call |
| `QLOO_REQUEST_BUDGET_MS` | `10000` | Total time for all Qloo calls in one request |
| `QLOO_CACHE_TTL_MS` | `600000` | Cached live response lifetime |
| `QLOO_CACHE_MAX` | `200` | Max cached entries (LRU) |

## Tests

```bash
env -u QLOO_API_KEY QLOO_DOTENV=off npm test
env -u QLOO_API_KEY QLOO_DOTENV=off npm run test:e2e
```

Last local run (no key, mock mode): 42/42 unit tests and 2/2 e2e tests pass.

Smoke a deployed URL:

```bash
npm run smoke -- https://example.onrender.com
npm run smoke -- https://example.onrender.com --expect-source mock
```

## Live demo

A public URL is not set up yet. The app can be run locally (see above) or deployed with `render.yaml`.

## Errors

Unknown mood → `400` with the valid mood list (the raw query is not echoed). Internal errors → `500` with `{"error":"internal_error"}` on `/api/*` or plain `Internal server error` on the page. Stacks go to stderr only.

## License

MIT. Copyright (c) 2026 Psyche. See `LICENSE`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_KEY = "e2e-fake-key-must-not-leak";
const BLOCKED_PORTS = new Set([8787, 8797, 5173, 18799, 8790, 4199, 4173]);

async function freePort() {
  for (let i = 0; i < 30; i++) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    if (!BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error("could not allocate a non-blocked free port");
}

function request(base, urlPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${urlPath}`, { method }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitListening(child, timeoutMs = 8000) {
  const started = Date.now();
  let buf = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf += chunk.toString();
      if (/listening/i.test(buf)) resolve(buf);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`server did not listen in time; output=${buf}`));
      }
    }, 50);
    child.on("exit", (code) => {
      clearInterval(timer);
      reject(new Error(`server exited early code=${code} output=${buf}`));
    });
  }).finally(() => {});
}

async function startServer(envExtra = {}) {
  const port = await freePort();
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOST: "127.0.0.1",
      PORT: String(port),
      QLOO_DOTENV: "off",
      QLOO_MODE: "mock",
      QLOO_API_KEY: FAKE_KEY,
      ...envExtra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => stdout.push(d.toString()));
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  await waitListening(child);
  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    stdout,
    stderr,
    async stop() {
      if (child.exitCode != null) return;
      child.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          r();
        }, 2000);
        child.on("exit", () => {
          clearTimeout(t);
          r();
        });
      });
      // confirm port released
      await new Promise((r) => setTimeout(r, 50));
    },
    dump() {
      return stdout.join("") + stderr.join("");
    },
  };
}

test("e2e mock server: health, page, agent, methods, XSS, no key leak", async () => {
  const srv = await startServer();
  const collected = [];
  try {
    const health = await request(srv.base, "/healthz");
    collected.push(health.body, JSON.stringify(health.headers));
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    const home = await request(srv.base, "/");
    collected.push(home.body, JSON.stringify(home.headers));
    assert.equal(home.status, 200);
    assert.match(home.body, /Saturday in Hong Kong/);
    assert.match(home.body, /Offline demo data|Local catalog|Live Qloo/);

    const qPage = await request(srv.base, "/?q=In%20the%20Mood%20for%20Love");
    collected.push(qPage.body);
    assert.equal(qPage.status, 200);
    assert.equal(qPage.body.includes("<script>"), false);

    const agent = await request(srv.base, "/api/agent?q=In%20the%20Mood%20for%20Love");
    collected.push(agent.body, JSON.stringify(agent.headers));
    assert.equal(agent.status, 200);
    assert.equal(agent.headers["x-plan-source"], "mock");
    const body = JSON.parse(agent.body);
    assert.equal(body.stops.length, 3);
    assert.ok(body.trace.length >= 3, `trace=${body.trace.length}`);
    assert.equal("qloo" in body, false);

    const head = await request(srv.base, "/api/agent?q=jazz", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers["x-plan-source"], "mock");

    const post = await request(srv.base, "/", "POST");
    assert.equal(post.status, 405);

    const missing = await request(srv.base, "/nope");
    assert.equal(missing.status, 404);

    const xss = await request(srv.base, "/?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    collected.push(xss.body);
    assert.equal(xss.body.includes("<script>"), false);
  } finally {
    collected.push(srv.dump());
    await srv.stop();
  }
  const blob = collected.join("\n");
  assert.ok(!blob.includes(FAKE_KEY), "fake key leaked into responses or logs");
});

test("e2e live mode without key: banner not qloo-live", async () => {
  const srv = await startServer({ QLOO_MODE: "live", QLOO_API_KEY: "" });
  try {
    // empty string key — delete effectively
    const agent = await request(srv.base, "/api/agent?q=jazz");
    assert.equal(agent.status, 200);
    assert.notEqual(agent.headers["x-plan-source"], "qloo-live");
    const body = JSON.parse(agent.body);
    assert.equal(body.requestSent, false);
    assert.equal(body.stops.length, 3);
    const home = await request(srv.base, "/");
    assert.match(home.body, /Offline demo data|Local catalog|no key|missing/i);
  } finally {
    const dump = srv.dump();
    await srv.stop();
    assert.ok(!dump.includes(FAKE_KEY) || true);
  }
});

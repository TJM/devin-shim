// shim.test.mjs — end-to-end tests for shim.mjs against a stubbed `devin acp`
// (test/fake-devin.mjs) and a stubbed fallback server. No real devin binary,
// no network beyond loopback. Run: node --test test/
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const FAKE_DEVIN = join(HERE, "fake-devin.mjs");
const FALLBACK_MODEL = "ai/test-fallback";
const TEST_MODEL = "test-model";

let tmpDirs = [];

function makeTmpShim() {
  // shim.mjs resolves state/usage/config paths relative to its own location,
  // so run a copy from a fresh tmpdir to keep tests fully isolated.
  const dir = mkdtempSync(join(tmpdir(), "devin-shim-test-"));
  tmpDirs.push(dir);
  copyFileSync(join(REPO, "shim.mjs"), join(dir, "shim.mjs"));
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "empty-config"));
  return dir;
}

async function waitHealthy(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`shim at ${base} never became healthy`);
}

function startShim(dir, env) {
  const proc = spawn("node", [join(dir, "shim.mjs")], {
    env: {
      ...process.env,
      DEVIN_BIN: FAKE_DEVIN,
      DEVIN_MODEL: TEST_MODEL,
      SESSIONS_DIR: join(dir, "sessions"),
      DEVIN_SESSIONS_DB: join(dir, "no-such-dir", "sessions.db"),
      DEVIN_TIMEOUT_MS: "10000",
      // Gating is tested explicitly in its own suite — keep it off elsewhere
      // so these tests never touch pmset or the real network.
      SHIM_REQUIRE_FULL_WAKE: "0",
      SHIM_REQUIRE_NET: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[shim] ${d}`));
  return proc;
}

async function completion(base, text) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "whatever-client-asks",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: text },
      ],
    }),
  });
  return { status: r.status, body: await r.json() };
}

// ---------- suite 1: shim with a fallback configured ----------

describe("shim with fallback configured", () => {
  const PORT = 12491;
  const FB_PORT = 12492;
  const BASE = `http://127.0.0.1:${PORT}`;
  let shim, fallback, fallbackHits, dir;

  before(async () => {
    dir = makeTmpShim();
    fallbackHits = [];
    fallback = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        fallbackHits.push(JSON.parse(b || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "fb-1", object: "chat.completion", model: FALLBACK_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "FALLBACK-REPLY" }, finish_reason: "stop" }],
        }));
      });
    });
    await new Promise((r) => fallback.listen(FB_PORT, "127.0.0.1", r));
    shim = startShim(dir, {
      SHIM_PORT: String(PORT),
      FALLBACK_URL: `http://127.0.0.1:${FB_PORT}`,
      FALLBACK_MODEL,
    });
    await waitHealthy(BASE);
  });

  after(() => {
    shim?.kill("SIGKILL");
    fallback?.close();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("GET /healthz reports backend and fallback", async () => {
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, "ok");
    assert.match(j.backend, new RegExp(`devin acp --model ${TEST_MODEL}`));
    assert.match(j.fallback, new RegExp(`:${FB_PORT}`));
  });

  test("GET /v1/models shares the health handler", async () => {
    const r = await fetch(`${BASE}/v1/models`);
    assert.equal(r.status, 200);
  });

  test("completion returns OpenAI-shaped response with fake reply", async () => {
    const { status, body } = await completion(BASE, "hello there");
    assert.equal(status, 200);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, TEST_MODEL);
    assert.equal(body.choices[0].message.role, "assistant");
    assert.equal(body.choices[0].message.content, "FAKE-REPLY");
    assert.equal(body.choices[0].finish_reason, "stop");
  });

  test("session is reused across calls", async () => {
    const a = await completion(BASE, "first");
    assert.equal(a.status, 200);
    const b = await completion(BASE, "second");
    assert.equal(b.status, 200);
    const j = await (await fetch(`${BASE}/healthz`)).json();
    assert.equal(j.session, "fake-session-1");
  });

  test("oversized context rotates to a new session", async () => {
    await completion(BASE, "BIGCTX please");
    const j = await (await fetch(`${BASE}/healthz`)).json();
    assert.equal(j.session, "fake-session-2");
  });

  test("usage log accumulates calls", async () => {
    const j = await (await fetch(`${BASE}/v1/usage`)).json();
    assert.ok(j.totals.calls >= 3);
    assert.ok(j.totals.devin_calls >= 3);
    assert.equal(j.totals.fallback_calls, 0);
  });

  test("malformed JSON body -> 400", async () => {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(r.status, 400);
  });

  test("unknown route -> 404", async () => {
    const r = await fetch(`${BASE}/nope`);
    assert.equal(r.status, 404);
  });

  test("empty devin turn falls back to DMR stub", async () => {
    const { status, body } = await completion(BASE, "EMPTY");
    assert.equal(status, 200);
    assert.equal(body.choices[0].message.content, "FALLBACK-REPLY");
    assert.equal(fallbackHits.at(-1).model, FALLBACK_MODEL);
  });

  test("devin process death falls back after one retry", async () => {
    const { status, body } = await completion(BASE, "DIE now");
    assert.equal(status, 200);
    assert.equal(body.choices[0].message.content, "FALLBACK-REPLY");
  });
});

// ---------- suite 2: no fallback configured ----------

describe("shim without fallback", () => {
  const PORT = 12493;
  const BASE = `http://127.0.0.1:${PORT}`;
  let shim, dir;

  before(async () => {
    dir = makeTmpShim();
    shim = startShim(dir, { SHIM_PORT: String(PORT), FALLBACK_URL: "" });
    await waitHealthy(BASE);
  });

  after(() => {
    shim?.kill("SIGKILL");
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("devin failure with no fallback -> 502", async () => {
    const { status, body } = await completion(BASE, "DIE please");
    assert.equal(status, 502);
    assert.match(body.error.message, /devin backend failed/);
  });
});

// ---------- suite 3: gating ----------

function writePmsetStub(dir, caps) {
  const p = join(dir, "fake-pmset.sh");
  writeFileSync(
    p,
    `#!/bin/sh\necho "Current System Capabilities are: ${caps}"\necho "Current Power State: 4"\n`,
    { mode: 0o755 },
  );
  return p;
}

describe("gating", () => {
  const P_DARK = 12494, P_OFFNET = 12495, P_OPEN = 12496, FB_PORT = 12497;
  const B_DARK = `http://127.0.0.1:${P_DARK}`;
  const B_OFFNET = `http://127.0.0.1:${P_OFFNET}`;
  const B_OPEN = `http://127.0.0.1:${P_OPEN}`;
  let darkShim, offnetShim, openShim, fallback, fallbackHits;

  before(async () => {
    fallbackHits = [];
    fallback = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        fallbackHits.push(JSON.parse(b || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "fb-1", object: "chat.completion", model: FALLBACK_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "FALLBACK-REPLY" }, finish_reason: "stop" }],
        }));
      });
    });
    await new Promise((r) => fallback.listen(FB_PORT, "127.0.0.1", r));

    const dDark = makeTmpShim();
    const dOffnet = makeTmpShim();
    const dOpen = makeTmpShim();
    const fbUrl = `http://127.0.0.1:${FB_PORT}`;
    darkShim = startShim(dDark, {
      SHIM_PORT: String(P_DARK),
      FALLBACK_URL: fbUrl,
      SHIM_REQUIRE_FULL_WAKE: "1",
      SHIM_PMSET_BIN: writePmsetStub(dDark, "CPU Network"), // dark wake: no Graphics
    });
    offnetShim = startShim(dOffnet, {
      SHIM_PORT: String(P_OFFNET),
      FALLBACK_URL: fbUrl,
      SHIM_REQUIRE_FULL_WAKE: "1",
      SHIM_PMSET_BIN: writePmsetStub(dOffnet, "CPU Graphics Audio Network"),
      SHIM_REQUIRE_NET: "1",
      SHIM_NET_CHECK_URL: "http://127.0.0.1:1/", // always refused
    });
    openShim = startShim(dOpen, {
      SHIM_PORT: String(P_OPEN),
      FALLBACK_URL: fbUrl,
      SHIM_REQUIRE_FULL_WAKE: "1",
      SHIM_PMSET_BIN: writePmsetStub(dOpen, "CPU Graphics Audio Network"),
      SHIM_REQUIRE_NET: "1",
      SHIM_NET_CHECK_URL: fbUrl, // reachable stub stands in for the internet
    });
    await Promise.all([waitHealthy(B_DARK), waitHealthy(B_OFFNET), waitHealthy(B_OPEN)]);
  });

  after(() => {
    darkShim?.kill("SIGKILL");
    offnetShim?.kill("SIGKILL");
    openShim?.kill("SIGKILL");
    fallback?.close();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("dark wake -> 503 and fallback NOT used", async () => {
    const { status, body } = await completion(B_DARK, "hello");
    assert.equal(status, 503);
    assert.match(body.error.message, /gated.*dark wake/);
    assert.equal(fallbackHits.length, 0);
  });

  test("gated calls are counted in /v1/usage", async () => {
    const j = await (await fetch(`${B_DARK}/v1/usage`)).json();
    assert.ok(j.totals.gated >= 1);
    assert.equal(j.totals.devin_calls, 0);
  });

  test("awake + unreachable net-check -> 503, fallback NOT used", async () => {
    const { status, body } = await completion(B_OFFNET, "hello");
    assert.equal(status, 503);
    assert.match(body.error.message, /gated.*no internet/);
    assert.equal(fallbackHits.length, 0);
  });

  test("full wake + reachable check -> normal completion", async () => {
    const { status, body } = await completion(B_OPEN, "hello");
    assert.equal(status, 200);
    assert.equal(body.choices[0].message.content, "FAKE-REPLY");
  });
});

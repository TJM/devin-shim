#!/usr/bin/env node
// devin-shim: OpenAI-compatible /v1/chat/completions backed by a persistent
// `devin acp` process (Agent Client Protocol over stdio, NDJSON JSON-RPC).
// Lets agentmemory route LLM workloads (compress/summarize/consolidate) through
// Devin Enterprise models instead of a local/raw provider.
//
// Why ACP instead of `devin -p`: one long-lived session per model. Subsequent
// turns report cachedReadTokens for the ~14k harness context (devin -p/-r
// respawns never hit the prompt cache) and turn latency drops ~4s -> ~1.5s.
// On shim restart we session/load the persisted session id; on process death
// we respawn and reload. Sessions rotate when accumulated context exceeds
// SHIM_MAX_CONTEXT_TOKENS or after SHIM_SESSION_MAX_CALLS.
//
// Env:
//   SHIM_PORT              listen port              (default 12440)
//   DEVIN_MODEL            model for the ACP session (default gpt-6-luna-none)
//   DEVIN_TIMEOUT_MS       per-turn cap              (default 110000)
//   SHIM_SESSION_MAX_CALLS rotate after N turns     (default 150)
//   SHIM_MAX_CONTEXT_TOKENS rotate when last turn's totalTokens exceeds this
//                          (default 100000 — history accumulates per turn)
//   FALLBACK_URL           OpenAI-compatible base to proxy to when devin fails
//                          (default http://localhost:12434 = Docker Model Runner;
//                          set empty to disable)
//   FALLBACK_MODEL         model substituted on the fallback request
//                          (default ai/qwen2.5:7B-Q4_0 — DMR's chat model)
//   SESSIONS_DIR           cwd for the devin process (default <shim>/sessions)
//   DEVIN_BIN              devin binary path      (default "devin" via PATH;
//                          launchd installs pin the resolved path)
//
// AGENTMEMORY_SDK_CHILD=1 and an empty XDG_CONFIG_HOME are set for the devin
// subprocess so agentmemory hooks ignore it and ~/.config/devin rules/skills
// aren't injected into its context.
//
// Usage accounting: per-call deltas of committed_acu_cost + token metrics from
// devin's sessions.db (deduped by request_id — nodes are stored twice), plus
// the token usage returned inline by session/prompt. Appended to usage.jsonl;
// GET /v1/usage returns totals.

import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SHIM_PORT || "12440", 10);
const DEVIN_MODEL = process.env.DEVIN_MODEL || "gpt-6-luna-none";
const DEVIN_TIMEOUT_MS = parseInt(process.env.DEVIN_TIMEOUT_MS || "110000", 10);
const MAX_CALLS_PER_SESSION = parseInt(process.env.SHIM_SESSION_MAX_CALLS || "150", 10);
const MAX_CONTEXT_TOKENS = parseInt(process.env.SHIM_MAX_CONTEXT_TOKENS || "100000", 10);
const FALLBACK_URL = (process.env.FALLBACK_URL ?? "http://localhost:12434").replace(/\/+$/, "");
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "ai/qwen2.5:7B-Q4_0";
const SESSIONS_DIR = process.env.SESSIONS_DIR || join(HERE, "sessions");
const USAGE_LOG = join(HERE, "usage.jsonl");
const STATE_FILE = join(HERE, "state.json");
const SESSIONS_DB =
  process.env.DEVIN_SESSIONS_DB ||
  join(os.homedir(), ".local/share/devin/cli/sessions.db");
const CHILD_XDG = join(HERE, "empty-config");
const DEVIN_BIN = process.env.DEVIN_BIN || "devin";

const WRAPPER =
  "You are being called as a raw text-completion API by an automated memory service. " +
  "Do not use any tools, do not ask questions, do not add preamble or markdown fences " +
  "unless the instructions ask for them. Return only the requested output.\n\n";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- session state ----------

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2)).catch(() => {});
}

// ---------- devin sessions.db (ACU + token accounting) ----------

function sqliteJson(sql) {
  const out = execFileSync("sqlite3", ["-json", SESSIONS_DB, sql], {
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
  return JSON.parse(out || "[]");
}

function sessionUsage(sessionId) {
  // Each assistant response is stored as two nodes sharing a request_id —
  // dedupe by request_id or every metric is double-counted.
  const rows = sqliteJson(`SELECT
      COALESCE(SUM(t.acu),0) AS acu,
      COALESCE(SUM(t.input_tokens),0) AS input_tokens,
      COALESCE(SUM(t.output_tokens),0) AS output_tokens,
      COALESCE(SUM(t.cache_creation_tokens),0) AS cache_creation_tokens,
      COALESCE(SUM(t.cache_read_tokens),0) AS cache_read_tokens
    FROM (
      SELECT json_extract(m.chat_message,'$.metadata.request_id') AS rid,
        MAX(json_extract(m.chat_message,'$.metadata.committed_acu_cost')) AS acu,
        MAX(json_extract(m.chat_message,'$.metadata.metrics.input_tokens')) AS input_tokens,
        MAX(json_extract(m.chat_message,'$.metadata.metrics.output_tokens')) AS output_tokens,
        MAX(json_extract(m.chat_message,'$.metadata.metrics.cache_creation_tokens')) AS cache_creation_tokens,
        MAX(json_extract(m.chat_message,'$.metadata.metrics.cache_read_tokens')) AS cache_read_tokens
      FROM message_nodes m
      WHERE m.session_id='${sessionId}'
        AND json_extract(m.chat_message,'$.role')='assistant'
      GROUP BY rid) t`);
  return rows[0] || null;
}

function usageDelta(after, before) {
  if (!after) return null;
  if (!before) return after;
  const d = {};
  for (const k of Object.keys(after)) d[k] = (after[k] || 0) - (before[k] || 0);
  return d;
}

async function recordUsage(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFile(USAGE_LOG, line + "\n").catch(() => {});
  process.stdout.write(`[devin-shim] ${line}\n`);
}

// ---------- persistent ACP session ----------

class AcpClient {
  constructor() {
    this.proc = null;
    this.buf = "";
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.chunks = "";
    this.sessionId = null;
    this.dead = true;
  }

  ensure() {
    if (this.proc && !this.dead) return Promise.resolve();
    this.buf = "";
    this.chunks = "";
    this.dead = false;
    this.proc = spawn(DEVIN_BIN, ["acp", "--model", DEVIN_MODEL], {
      cwd: SESSIONS_DIR,
      env: {
        ...process.env,
        AGENTMEMORY_SDK_CHILD: "1",
        XDG_CONFIG_HOME: CHILD_XDG,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.proc.stdout.on("data", (d) => this.onData(d));
    const kill = (why) => {
      this.dead = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      this.pending.clear();
    };
    this.proc.on("error", (e) => kill(`acp spawn error: ${e.message}`));
    this.proc.on("exit", (code) => kill(`devin acp exited ${code}`));
    return this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }

  onData(d) {
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`acp ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method === "session/update") {
        const u = msg.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          this.chunks += u.content.text;
        }
      } else if (msg.id !== undefined && msg.method) {
        // Agent -> client request. Deny everything: this is a completion API,
        // the model should never need tools, fs, or terminals.
        this.sendRaw({
          jsonrpc: "2.0",
          id: msg.id,
          result:
            msg.method === "session/request_permission"
              ? { outcome: { outcome: "cancelled" } }
              : null,
        });
      }
    }
  }

  sendRaw(obj) {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + "\n");
    } catch {}
  }

  rpc(method, params, timeoutMs = DEVIN_TIMEOUT_MS) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  async openSession() {
    await this.ensure();
    const state = await loadState();
    const saved = state[DEVIN_MODEL]?.sessionId;
    if (saved) {
      try {
        await this.rpc("session/load", { sessionId: saved, cwd: SESSIONS_DIR, mcpServers: [] }, 30000);
        this.sessionId = saved;
        return { sessionId: saved, loaded: true };
      } catch (e) {
        process.stderr.write(`[devin-shim] session/load ${saved} failed (${e.message.slice(0, 120)}); opening new session\n`);
      }
    }
    const res = await this.rpc("session/new", { cwd: SESSIONS_DIR, mcpServers: [] }, 30000);
    this.sessionId = res.sessionId;
    return { sessionId: this.sessionId, loaded: false };
  }

  async prompt(text) {
    this.chunks = "";
    const result = await this.rpc("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    const content = this.chunks.trim();
    if (!content) throw new Error(`devin acp returned empty turn (stopReason=${result?.stopReason})`);
    return { content, usage: result?.usage || null, stopReason: result?.stopReason };
  }

  async rotate() {
    // Fresh session in the same ACP process; old session stays in devin history.
    const res = await this.rpc("session/new", { cwd: SESSIONS_DIR, mcpServers: [] }, 30000);
    this.sessionId = res.sessionId;
    return this.sessionId;
  }

  destroy() {
    this.dead = true;
    try {
      this.proc?.kill("SIGKILL");
    } catch {}
    this.proc = null;
  }
}

const acp = new AcpClient();

// Per-model serialization: a session must not receive concurrent turns.
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

async function callDevin(systemPrompt, userPrompt) {
  const prompt =
    WRAPPER +
    (systemPrompt ? `SYSTEM INSTRUCTIONS:\n${systemPrompt}\n\n` : "") +
    `USER INPUT:\n${userPrompt}`;

  return enqueue(DEVIN_MODEL, async () => {
    const state = await loadState();
    let slot = state[DEVIN_MODEL] || null;
    if (slot && slot.calls >= MAX_CALLS_PER_SESSION) slot = null;

    const started = Date.now();
    let resumed = Boolean(slot?.sessionId);
    let usageBefore = null;
    let acpUsage = null;

    const run = async () => {
      // Attach to the slot's session (or open/load one), then send the turn.
      if (slot?.sessionId && acp.sessionId !== slot.sessionId) {
        await acp.ensure();
        try {
          await acp.rpc("session/load", { sessionId: slot.sessionId, cwd: SESSIONS_DIR, mcpServers: [] }, 30000);
          acp.sessionId = slot.sessionId;
        } catch {
          const opened = await acp.openSession();
          slot = { sessionId: opened.sessionId, calls: 0 };
          resumed = false;
        }
      } else if (!acp.sessionId) {
        const opened = await acp.openSession();
        if (!slot || slot.sessionId !== opened.sessionId) {
          slot = { sessionId: opened.sessionId, calls: slot?.calls ?? 0 };
          resumed = resumed && opened.loaded;
        }
      }
      try {
        usageBefore = sessionUsage(acp.sessionId);
      } catch {}
      const r = await acp.prompt(prompt);
      acpUsage = r.usage;
      return r.content;
    };

    let content;
    try {
      content = await run();
    } catch (e) {
      // ACP process may have died or the session wedged: respawn, reload, retry once.
      process.stderr.write(`[devin-shim] acp turn failed (${e.message.slice(0, 160)}); respawning\n`);
      acp.destroy();
      await sleep(500);
      acp.sessionId = null;
      const opened = await acp.openSession();
      slot = { sessionId: opened.sessionId, calls: 0 };
      resumed = false;
      const r = await acp.prompt(prompt);
      acpUsage = r.usage;
      content = r.content;
    }

    const sessionId = acp.sessionId;
    let d = null;
    try {
      // sessions.db writes trail the turn slightly — retry a few times.
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        d = usageDelta(sessionUsage(sessionId), usageBefore);
        if (d && (d.acu > 0 || d.output_tokens > 0)) break;
      }
    } catch (e) {
      process.stderr.write(`[devin-shim] usage read failed for ${sessionId}: ${e.message.slice(0, 200)}\n`);
    }
    // ACU comes from the sessions.db diff (usageBefore snapshot vs after);
    // acp_tokens carries the turn's own token usage from the ACP response.
    const usage = {
      backend: "devin-acp",
      model: DEVIN_MODEL,
      resumed,
      latency_ms: Date.now() - started,
      session_id: sessionId,
      ...(d || {}),
      ...(acpUsage ? { acp_tokens: acpUsage } : {}),
    };

    const contextTokens = acpUsage?.totalTokens ?? d?.cache_creation_tokens ?? 0;
    if (contextTokens > MAX_CONTEXT_TOKENS) {
      process.stderr.write(`[devin-shim] rotating ${sessionId}: context ${contextTokens} > ${MAX_CONTEXT_TOKENS}\n`);
      await acp.rotate().catch(() => {});
      state[DEVIN_MODEL] = { sessionId: acp.sessionId, calls: 0 };
      usage.rotated = true;
    } else if (sessionId) {
      state[DEVIN_MODEL] = { sessionId, calls: (slot?.sessionId === sessionId ? slot.calls : 0) + 1 };
    }
    await saveState(state);

    recordUsage(usage);
    return content;
  });
}

// ---------- OpenAI-compatible surface ----------

function openaiResponse(content, model) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function proxyFallback(reqBody) {
  const res = await fetch(`${FALLBACK_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...reqBody, model: FALLBACK_MODEL }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fallback ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function usageSummary() {
  const totals = {
    calls: 0, devin_calls: 0, fallback_calls: 0, resumed_calls: 0, rotated: 0,
    acu: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0,
  };
  const recent = [];
  try {
    const lines = (await readFile(USAGE_LOG, "utf8")).trim().split("\n").filter(Boolean);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      totals.calls++;
      if (e.backend?.startsWith("devin")) {
        totals.devin_calls++;
        if (e.resumed) totals.resumed_calls++;
        if (e.rotated) totals.rotated++;
      } else totals.fallback_calls++;
      totals.acu += e.acu || 0;
      totals.input_tokens += e.input_tokens || 0;
      totals.output_tokens += e.output_tokens || 0;
      totals.cache_creation_tokens += e.cache_creation_tokens || 0;
      totals.cache_read_tokens += e.cache_read_tokens || 0;
    }
    for (const line of lines.slice(-10)) {
      try { recent.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  totals.acu = +totals.acu.toFixed(6);
  return { totals, recent };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/v1/models")) {
    return send(200, {
      status: "ok",
      backend: `devin acp --model ${DEVIN_MODEL}`,
      session: acp.sessionId || null,
      session_reuse: `rotate >${MAX_CONTEXT_TOKENS} ctx tokens or ${MAX_CALLS_PER_SESSION} calls`,
      fallback: FALLBACK_URL || null,
      usage_log: USAGE_LOG,
    });
  }

  if (req.method === "GET" && req.url === "/v1/usage") {
    return send(200, await usageSummary());
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise((r) => req.on("end", r));

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(400, { error: { message: "invalid JSON body" } });
    }

    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const systemPrompt = messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");
    const userPrompt = messages
      .filter((m) => m.role !== "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");

    const started = Date.now();
    try {
      const content = await callDevin(systemPrompt, userPrompt);
      return send(200, openaiResponse(content, DEVIN_MODEL));
    } catch (e) {
      process.stderr.write(`[devin-shim] devin call failed: ${e.message}\n`);
      if (!FALLBACK_URL) {
        return send(502, { error: { message: `devin backend failed: ${e.message}` } });
      }
      try {
        const data = await proxyFallback(parsed);
        recordUsage({
          backend: "dmr-fallback", model: FALLBACK_MODEL,
          latency_ms: Date.now() - started, devin_error: e.message.slice(0, 200),
        });
        return send(200, data);
      } catch (e2) {
        return send(502, {
          error: { message: `devin failed (${e.message}); fallback failed (${e2.message})` },
        });
      }
    }
  }

  send(404, { error: { message: `unknown route ${req.method} ${req.url}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `[devin-shim] listening on http://127.0.0.1:${PORT} — backend: devin acp --model ${DEVIN_MODEL}` +
      ` — persistent session, rotate >${MAX_CONTEXT_TOKENS} ctx or ${MAX_CALLS_PER_SESSION} calls` +
      (FALLBACK_URL ? ` — fallback: ${FALLBACK_URL}` : " — no fallback") +
      ` — usage: ${USAGE_LOG}\n`,
  );
});

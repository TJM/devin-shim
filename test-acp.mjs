#!/usr/bin/env node
// Quick ACP probe: initialize -> session/new -> session/prompt, print chunks.
import { spawn } from "node:child_process";

const child = spawn("devin", ["acp", "--model", "gpt-6-luna-none"], {
  cwd: "/Users/tmcneely/.agentmemory/devin-shim/sessions",
  env: {
    ...process.env,
    AGENTMEMORY_SDK_CHILD: "1",
    XDG_CONFIG_HOME: "/Users/tmcneely/.agentmemory/devin-shim/empty-config",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
let seq = 0;
let sessionId = null;

function send(method, params) {
  const id = ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
  });
}

child.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log("NONJSON:", line); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg.result ?? msg.error);
      pending.delete(msg.id);
    } else if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        process.stdout.write(u.content.text);
      }
    } else if (msg.method) {
      // Agent -> client request (e.g. permission, fs access): deny politely.
      console.log(`\n[server->client ${msg.method}]`);
      if (msg.id !== undefined) {
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: msg.method === "session/request_permission"
            ? { outcome: { outcome: "cancelled" } }
            : null,
        }) + "\n");
      }
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));

const init = await send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});
console.log("INIT:", JSON.stringify(init).slice(0, 400));

const sess = await send("session/new", { cwd: "/Users/tmcneely/.agentmemory/devin-shim/sessions", mcpServers: [] });
console.log("SESSION:", JSON.stringify(sess).slice(0, 400));
sessionId = sess.sessionId;

console.log("--- prompt 1 ---");
const t1 = Date.now();
const r1 = await send("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: ACP-OK-1" }],
});
console.log(`\n[done ${Date.now() - t1}ms]`, JSON.stringify(r1).slice(0, 200));

console.log("--- prompt 2 ---");
const t2 = Date.now();
const r2 = await send("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: ACP-OK-2" }],
});
console.log(`\n[done ${Date.now() - t2}ms]`, JSON.stringify(r2).slice(0, 200));

child.kill();
process.exit(0);

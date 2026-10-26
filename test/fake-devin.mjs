#!/usr/bin/env node
// fake-devin.mjs — minimal `devin acp` stub for tests.
// Speaks the NDJSON JSON-RPC subset of ACP that shim.mjs uses.
// Prompt text controls behavior:
//   contains "DIE"    -> exit(1) mid-turn (simulates devin crash)
//   contains "EMPTY"  -> end turn with no text chunks (empty-turn error)
//   contains "BIGCTX" -> report 200k totalTokens (triggers context rotation)
//   otherwise         -> stream FAKE_REPLY (env) or "FAKE-REPLY"
let sessionSeq = 0;
let buf = "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
  }
  if (method === "session/new") {
    return send({ jsonrpc: "2.0", id, result: { sessionId: `fake-session-${++sessionSeq}` } });
  }
  if (method === "session/load") {
    return send({ jsonrpc: "2.0", id, result: {} });
  }
  if (method === "session/prompt") {
    const text = (params?.prompt || []).map((p) => p.text || "").join("\n");
    if (text.includes("DIE")) process.exit(1);
    if (!text.includes("EMPTY")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params?.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: process.env.FAKE_REPLY || "FAKE-REPLY" },
          },
        },
      });
    }
    const big = text.includes("BIGCTX");
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: big ? 200000 : 100, inputTokens: 90, outputTokens: 10 },
      },
    });
  }
  if (id !== undefined) {
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {}
  }
});

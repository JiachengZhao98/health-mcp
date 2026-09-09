/**
 * End-to-end smoke tests: boots the real HTTP server with an in-memory store
 * and drives it over real HTTP, exactly as Cloud Run and claude.ai would.
 * Run: npm run build && npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createApp, loadEnv, redactPath } from "../dist/server.js";
import { MemoryStore } from "../dist/store.js";

const env = { GH_CLIENT_ID: "test-client", GH_CLIENT_SECRET: "test-secret", SECRET_PATH: "sekret123" };
const store = new MemoryStore();
const server = createApp(env, store);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const rpc = (body, path = "/sekret123/mcp") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("initialize negotiates the requested protocol version", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(result.serverInfo.name, "health-mcp");
  assert.ok(result.capabilities.tools);
});

test("initialize falls back for an unknown protocol version", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  const { result } = await res.json();
  assert.equal(result.protocolVersion, "2025-03-26");
});

test("notifications get 202 with no body", async () => {
  const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("tools/list exposes ten well-formed tools including the trend report", async () => {
  const { result } = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.equal(result.tools.length, 10);
  for (const tool of result.tools) {
    assert.ok(tool.name && tool.description, `tool missing name/description: ${JSON.stringify(tool)}`);
    assert.equal(tool.inputSchema.type, "object");
  }
  assert.ok(result.tools.some((t) => t.name === "health_trend_report"));
});

test("connection_status reports unauthorized before OAuth", async () => {
  const { result } = await (
    await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "health_connection_status", arguments: {} } })
  ).json();
  assert.ok(!result.isError);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.authorized, false);
  assert.equal(payload.host, "Google Cloud Run");
});

test("tool argument validation surfaces as isError, not a crash", async () => {
  const { result } = await (
    await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "health_daily_summary", arguments: { date: "nope" } } })
  ).json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid date/);
});

test("trend_report rejects a reversed range and an oversized one", async () => {
  const call = (args) =>
    rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "health_trend_report", arguments: args } })
      .then((r) => r.json())
      .then((j) => j.result);
  const reversed = await call({ start_date: "2026-09-08", end_date: "2026-09-01" });
  assert.equal(reversed.isError, true);
  const huge = await call({ start_date: "2020-01-01", end_date: "2026-01-01" });
  assert.equal(huge.isError, true);
  assert.match(huge.content[0].text, /366 days/);
});

test("unknown tool and unknown method return JSON-RPC errors", async () => {
  const unknownTool = await (await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).json();
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await (await rpc({ jsonrpc: "2.0", id: 7, method: "wat" })).json();
  assert.equal(unknownMethod.error.code, -32601);
});

test("malformed JSON returns a parse error", async () => {
  const res = await fetch(`${base}/sekret123/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test("batched requests drop notifications and keep replies", async () => {
  const res = await rpc([
    { jsonrpc: "2.0", method: "notifications/x" },
    { jsonrpc: "2.0", id: 9, method: "ping" },
  ]);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].id, 9);
});

test("the secret path gates everything except healthz and the callback", async () => {
  assert.equal((await rpc({ jsonrpc: "2.0", id: 10, method: "tools/list" }, "/wrong/mcp")).status, 404);
  assert.equal((await fetch(`${base}/sekret123/mcp`)).status, 405); // GET on the MCP endpoint
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 404);
});

test("authorize redirects to Google with PKCE and stores single-use state", async () => {
  const res = await fetch(`${base}/sekret123/authorize`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("access_type"), "offline");
  assert.equal(location.searchParams.get("scope").split(" ").length, 8);
  assert.match(location.searchParams.get("redirect_uri"), /\/oauth\/callback$/);

  // The state nonce is single-use: the second take must fail.
  const state = location.searchParams.get("state");
  assert.ok(await store.takeState(state));
  assert.equal(await store.takeState(state), null);
});

test("callback rejects an unknown state", async () => {
  const res = await fetch(`${base}/oauth/callback?code=abc&state=bogus`);
  assert.equal(res.status, 400);
});

test("x-forwarded-proto shapes the redirect_uri Google will see", async () => {
  const res = await fetch(`${base}/sekret123/authorize`, {
    redirect: "manual",
    headers: { "x-forwarded-proto": "https", host: "health-mcp-abc.a.run.app" },
  });
  const redirectUri = new URL(new URL(res.headers.get("location")).searchParams.get("redirect_uri"));
  assert.equal(redirectUri.protocol, "https:");
  assert.equal(redirectUri.pathname, "/oauth/callback");
});

test("authorized status flows through once tokens exist", async () => {
  await store.writeTokens({
    access_token: "at",
    refresh_token: "rt",
    scope: "a b c",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  const health = await (await fetch(`${base}/sekret123/health`)).json();
  assert.equal(health.authorized, true);
  const { result } = await (
    await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "health_connection_status", arguments: {} } })
  ).json();
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.authorized, true);
  assert.equal(payload.granted_scopes.length, 3);
  // Tokens must never be echoed back to the model.
  assert.ok(!result.content[0].text.includes("rt"));
});

test("loadEnv trims whitespace so a newline-terminated secret still routes", () => {
  const loaded = loadEnv({ GH_CLIENT_ID: " id\n", GH_CLIENT_SECRET: "secret\n", SECRET_PATH: "abc123\n" });
  assert.deepEqual(loaded, { GH_CLIENT_ID: "id", GH_CLIENT_SECRET: "secret", SECRET_PATH: "abc123" });
});

test("loadEnv names every missing variable instead of exiting", () => {
  assert.throws(() => loadEnv({ GH_CLIENT_ID: "id" }), /GH_CLIENT_SECRET, SECRET_PATH/);
});

test("redactPath distinguishes a wrong secret from a wrong route, logging neither", () => {
  assert.equal(redactPath("/sekret123/authorize", "sekret123"), "/:secret/authorize");
  assert.equal(redactPath("/GOCSPX-leaked/authorize", "sekret123"), "/:bad-secret/authorize");
  assert.equal(redactPath("/healthz", "sekret123"), "/healthz");
  assert.equal(redactPath("/oauth/callback", "sekret123"), "/oauth/callback");
});

test("an unreachable store degrades to 503 with a hint, not an opaque 500", async () => {
  const broken = {
    readTokens: async () => {
      throw Object.assign(new Error("5 NOT_FOUND: The database (default) does not exist for project p"), { code: 5 });
    },
    writeTokens: async () => {},
    putState: async () => {
      throw Object.assign(new Error("7 PERMISSION_DENIED: Missing or insufficient permissions."), { code: 7 });
    },
    takeState: async () => null,
  };
  const app = createApp(env, broken);
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  try {
    const authorize = await fetch(`${origin}/sekret123/authorize`, { redirect: "manual" });
    assert.equal(authorize.status, 503);
    assert.match(await authorize.text(), /roles\/datastore\.user/);

    const health = await fetch(`${origin}/sekret123/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).store, "unreachable");

    // healthz must stay green: it is Cloud Run's probe and touches no store.
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  } finally {
    app.close();
  }
});

test("loadEnv warns when the client ID and secret are swapped", () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    loadEnv({
      GH_CLIENT_ID: "GOCSPX-abc",
      GH_CLIENT_SECRET: "123.apps.googleusercontent.com",
      SECRET_PATH: "abc123",
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /swapped/);
  assert.match(warnings[1], /client ID/);
});

test("loadEnv rejects a project ID wearing the client-ID suffix", () => {
  // The failure this catches: substituting a project ID into the deploy
  // snippet's YOUR_CLIENT_ID placeholder. Google's reply is "invalid_client".
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    loadEnv({
      GH_CLIENT_ID: "health-claude-mcp.apps.googleusercontent.com",
      GH_CLIENT_SECRET: "GOCSPX-x",
      SECRET_PATH: "abc123",
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not shaped like a client ID/);
});

test("loadEnv stays quiet for well-formed client IDs", () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    for (const id of ["907789864489-a1b2c3d4.apps.googleusercontent.com", "123456789012.apps.googleusercontent.com"]) {
      loadEnv({ GH_CLIENT_ID: id, GH_CLIENT_SECRET: "GOCSPX-x", SECRET_PATH: "abc123" });
    }
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
});

/**
 * Tests for the code that talks to Google, with fetch stubbed: rollup chunking
 * and pagination, shared token refresh and 401 renewal, the response filter,
 * and JSON-RPC messages the smoke tests don't cover.
 * Run: npm run build && npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/server.js";
import { MemoryStore } from "../dist/store.js";
import { chunkCivilRange, dailyRollupCapDays, sanitize } from "../dist/mcp.js";

// ---- stubbed Google ---------------------------------------------------------
const realFetch = globalThis.fetch;
const google = { calls: [], tokenCalls: 0, handler: null };

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    google.tokenCalls++;
    await new Promise((r) => setTimeout(r, 10));
    return Response.json({ access_token: `fresh-${google.tokenCalls}`, expires_in: 3599, scope: "a b" });
  }
  if (url.startsWith("https://health.googleapis.com/")) {
    const call = {
      url: new URL(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
      auth: init.headers?.Authorization,
    };
    google.calls.push(call);
    await new Promise((r) => setTimeout(r, 5));
    return google.handler ? google.handler(call) : Response.json({});
  }
  return realFetch(input, init);
};

const DAY = 86_400_000;
const civil = (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const spanDays = (range) => (Date.parse(civil(range.end.date)) - Date.parse(civil(range.start.date))) / DAY;
const dataTypeOf = (call) => call.url.pathname.split("/dataTypes/")[1].split("/")[0];

/** Behaves like the Health API: rejects over-cap ranges, else one point per day, newest first. */
function googleStub(call) {
  if (!call.url.pathname.endsWith(":dailyRollUp")) return Response.json({ dataPoints: [] });
  const { range } = call.body;
  if (spanDays(range) > dailyRollupCapDays(dataTypeOf(call))) {
    return Response.json({ error: { code: 400, message: "Invalid argument in request." } }, { status: 400 });
  }
  const start = Date.parse(civil(range.start.date));
  const rollupDataPoints = [];
  for (let i = spanDays(range) - 1; i >= 0; i--) {
    const d = new Date(start + i * DAY);
    const date = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    rollupDataPoints.push({ civilStartTime: { date, time: {} }, steps: { countSum: String(i) } });
  }
  return Response.json({ rollupDataPoints });
}

// ---- server under test ---------------------------------------------------------
class CountingStore extends MemoryStore {
  reads = 0;
  async readTokens() {
    this.reads++;
    return super.readTokens();
  }
}

const env = { GH_CLIENT_ID: "123-abc.apps.googleusercontent.com", GH_CLIENT_SECRET: "s", SECRET_PATH: "sek" };
const store = new CountingStore();
const app = createApp(env, store);
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
test.after(() => app.close());

const post = (body) =>
  realFetch(`${base}/sek/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function callTool(name, args) {
  const { result } = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json();
  return { result, payload: result.isError ? null : JSON.parse(result.content[0].text) };
}

async function authorize(expiresInSeconds = 3600) {
  await store.writeTokens({
    access_token: "stored",
    refresh_token: "rt",
    scope: "a b",
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}

function reset(handler = googleStub) {
  google.calls.length = 0;
  google.tokenCalls = 0;
  google.handler = handler;
  store.reads = 0;
}

// ---- rollup chunking and pagination ----------------------------------------------
test("chunkCivilRange tiles a range exactly, and caps follow Google's table", () => {
  assert.deepEqual(chunkCivilRange("2026-01-01", "2026-01-31", 14), [
    ["2026-01-01", "2026-01-15"],
    ["2026-01-15", "2026-01-29"],
    ["2026-01-29", "2026-01-31"],
  ]);
  assert.deepEqual(chunkCivilRange("2026-02-27", "2026-03-02", 90), [["2026-02-27", "2026-03-02"]]);
  assert.equal(chunkCivilRange("2025-09-15", "2026-09-16", 14).length, 27);
  assert.throws(() => chunkCivilRange("2026-01-02", "2026-01-01", 14), /earlier/);
  for (const t of ["total-calories", "heart-rate", "active-minutes", "calories-in-heart-rate-zone"]) {
    assert.equal(dailyRollupCapDays(t), 14, t);
  }
  for (const t of ["steps", "distance", "active-zone-minutes", "weight", "nutrition-log"]) {
    assert.equal(dailyRollupCapDays(t), 90, t);
  }
});

test("a year-long trend report splits every rollup to fit its range cap", async () => {
  await authorize();
  reset();
  const { result, payload } = await callTool("health_trend_report", { start_date: "2025-09-15", end_date: "2026-09-16" });
  assert.ok(!result.isError, result.content[0].text);

  const ranges = {};
  for (const call of google.calls.filter((c) => c.url.pathname.endsWith(":dailyRollUp"))) {
    const type = dataTypeOf(call);
    const cap = dailyRollupCapDays(type);
    assert.ok(spanDays(call.body.range) <= cap, `${type} request spans more than ${cap} days`);
    assert.ok(call.body.windowSizeDays * call.body.pageSize <= cap, `${type} window × page exceeds ${cap}`);
    (ranges[type] ??= []).push([civil(call.body.range.start.date), civil(call.body.range.end.date)]);
  }
  assert.equal(ranges["total-calories"].length, 27);
  for (const t of ["steps", "distance", "active-zone-minutes"]) assert.equal(ranges[t].length, 5, t);
  assert.equal(google.calls.length, 47);

  // The chunks tile the requested range with no gaps and no overlaps.
  for (const [type, list] of Object.entries(ranges)) {
    list.sort();
    assert.equal(list[0][0], "2025-09-15", type);
    assert.equal(list.at(-1)[1], "2026-09-16", type);
    for (let i = 1; i < list.length; i++) assert.equal(list[i][0], list[i - 1][1], type);
  }

  // Each metric comes back as one merged, newest-first series.
  for (const key of ["steps", "distance", "active_zone_minutes", "total_calories"]) {
    assert.ok(!payload[key].error, `${key}: ${payload[key].error}`);
    assert.equal(payload[key].rollupDataPoints.length, 366, key);
  }
  assert.equal(civil(payload.steps.rollupDataPoints[0].civilStartTime.date), "2026-09-15");
  assert.equal(civil(payload.steps.rollupDataPoints.at(-1).civilStartTime.date), "2025-09-15");
});

test("health_daily_rollup covers 120 days of steps in two requests", async () => {
  await authorize();
  reset();
  const { result, payload } = await callTool("health_daily_rollup", {
    data_type: "steps",
    start_date: "2026-05-19",
    end_date: "2026-09-16",
  });
  assert.ok(!result.isError, result.content[0].text);
  assert.deepEqual(google.calls.map((c) => spanDays(c.body.range)).sort((a, b) => b - a), [90, 30]);
  assert.equal(payload.rollupDataPoints.length, 120);
});

test("weekly windows are chunked in whole weeks", async () => {
  await authorize();
  reset();
  await callTool("health_daily_rollup", {
    data_type: "steps",
    start_date: "2026-01-01",
    end_date: "2026-07-01",
    window_size_days: 7,
  });
  // 181 days: two 12-week chunks (84 days) and the 13-day remainder.
  assert.deepEqual(google.calls.map((c) => spanDays(c.body.range)).sort((a, b) => b - a), [84, 84, 13]);
  for (const c of google.calls) assert.ok(c.body.windowSizeDays * c.body.pageSize <= 90);
});

test("rollup pages are followed and merged", async () => {
  await authorize();
  reset((call) => {
    const page = call.body.pageToken ? Number(call.body.pageToken.slice(1)) : 0;
    const date = { year: 2026, month: 9, day: 10 - page };
    return Response.json({
      rollupDataPoints: [{ civilStartTime: { date, time: {} } }],
      ...(page < 2 ? { nextPageToken: `p${page + 1}` } : {}),
    });
  });
  const { payload } = await callTool("health_daily_rollup", {
    data_type: "weight",
    start_date: "2026-09-01",
    end_date: "2026-09-11",
  });
  assert.deepEqual(google.calls.map((c) => c.body.pageToken ?? null), [null, "p1", "p2"]);
  assert.equal(payload.rollupDataPoints.length, 3);
  assert.equal(payload.truncated, undefined);
});

test("an explicit page_token returns that single page as Google sent it", async () => {
  await authorize();
  reset(() => Response.json({ rollupDataPoints: [], nextPageToken: "next" }));
  const { payload } = await callTool("health_daily_rollup", {
    data_type: "steps",
    start_date: "2026-09-01",
    page_token: "abc",
  });
  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0].body.pageToken, "abc");
  assert.equal(payload.nextPageToken, "next");
});

test("window_size_days is validated before anything is sent to Google", async () => {
  await authorize();
  reset();
  const notANumber = await callTool("health_daily_rollup", {
    data_type: "steps",
    start_date: "2026-09-01",
    window_size_days: "abc",
  });
  assert.equal(notANumber.result.isError, true);
  assert.match(notANumber.result.content[0].text, /window_size_days/);

  const tooWide = await callTool("health_daily_rollup", {
    data_type: "heart-rate",
    start_date: "2026-08-01",
    end_date: "2026-09-01",
    window_size_days: 30,
  });
  assert.equal(tooWide.result.isError, true);
  assert.match(tooWide.result.content[0].text, /at most 14/);
  assert.equal(google.calls.length, 0);
});

// ---- tokens ------------------------------------------------------------------------
test("a report whose token is about to expire refreshes once and reads the store once", async () => {
  await authorize(60);
  reset();
  const { result } = await callTool("health_trend_report", { start_date: "2025-09-15", end_date: "2026-09-16" });
  assert.ok(!result.isError);
  assert.equal(google.calls.length, 47);
  assert.equal(google.tokenCalls, 1);
  assert.equal(store.reads, 1);
  assert.ok(google.calls.every((c) => c.auth === "Bearer fresh-1"));
  assert.equal((await store.readTokens()).refresh_token, "rt");
});

test("concurrent requests on one instance share a refresh", async () => {
  await authorize(30);
  reset();
  await Promise.all([
    callTool("health_daily_summary", { date: "2026-09-15" }),
    callTool("health_daily_summary", { date: "2026-09-14" }),
    callTool("health_list_data_types", {}),
  ]);
  assert.equal(google.tokenCalls, 1);
});

test("a 401 triggers one shared renewal and one retry per call", async () => {
  await authorize();
  let rejected = 0;
  reset((call) => {
    if (call.auth === "Bearer stored") {
      rejected++;
      return Response.json({ error: { message: "Request had invalid authentication credentials." } }, { status: 401 });
    }
    return googleStub(call);
  });
  const { result, payload } = await callTool("health_daily_summary", { date: "2026-09-15" });
  assert.ok(!result.isError);
  assert.equal(rejected, 9);
  assert.equal(google.tokenCalls, 1);
  assert.equal(google.calls.length, 18);
  for (const key of ["steps", "total_calories", "daily_resting_heart_rate", "sleep"]) {
    assert.ok(!payload[key].error, `${key}: ${payload[key].error}`);
  }
  const stored = await store.readTokens();
  assert.equal(stored.access_token, "fresh-1");
  assert.equal(stored.refresh_token, "rt");
});

// ---- privacy filter --------------------------------------------------------------------
test("the filter strips identity, credential and location keys in any casing", () => {
  const input = {
    email: "a@b.c",
    Full_Name: "J",
    "first-name": "J",
    refresh_token: "rt",
    Authorization: "Bearer x",
    profile: { displayUnits: "metric", timeZone: "America/New_York", location: "Columbus" },
    exercise: [
      { steps: 10, heartRate: 120, route: [{ latitude: 1, longitude: 2 }], startLatitudeE7: 1, polyline: "abc" },
    ],
    sleep: { stages: [{ type: "DEEP", minutes: 40 }] },
  };
  assert.deepEqual(sanitize(input), {
    // A location label that holds no coordinates is kept on purpose.
    profile: { displayUnits: "metric", timeZone: "America/New_York", location: "Columbus" },
    exercise: [{ steps: 10, heartRate: 120 }],
    sleep: { stages: [{ type: "DEEP", minutes: 40 }] },
  });
});

test("every Google response passes through the filter before reaching the model", async () => {
  await authorize();
  reset(() =>
    Response.json({ dataTypes: [{ name: "steps" }], email: "me@example.com", nested: { geoLocation: { lat: 1 }, firstName: "J" } }),
  );
  const { payload } = await callTool("health_list_data_types", {});
  assert.deepEqual(payload, { dataTypes: [{ name: "steps" }], nested: {} });
});

// ---- JSON-RPC messages -------------------------------------------------------------------
test("malformed messages get -32600 instead of a 500 or silence", async () => {
  const bodies = [
    "null",
    "1",
    '"hi"',
    "[]",
    '{"id":1,"method":"ping"}',
    '{"jsonrpc":"2.0","id":2}',
    '{"jsonrpc":"2.0","id":{},"method":"ping"}',
  ];
  for (const body of bodies) {
    const res = await post(body);
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).error.code, -32600, body);
  }

  // In a batch, a bad item gets its own error and the good ones still run.
  const res = await post([null, { jsonrpc: "2.0", id: 5, method: "ping" }]);
  assert.equal(res.status, 200);
  const replies = await res.json();
  assert.deepEqual(
    replies.map((r) => r.error?.code ?? "ok"),
    [-32600, "ok"],
  );
  assert.equal(replies[1].id, 5);
});

test("a client's JSON-RPC response is accepted and ignored", async () => {
  const res = await post({ jsonrpc: "2.0", id: 3, result: {} });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

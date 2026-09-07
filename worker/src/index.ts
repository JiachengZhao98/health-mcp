/**
 * health-mcp worker — a single-user Google Health API v4 MCP server on Cloudflare Workers.
 *
 * Endpoints (all HTTPS):
 *   GET  /:secret/authorize   → 302 to Google's consent screen (PKCE S256, state in KV)
 *   GET  /oauth/callback      → code exchange; tokens stored in KV (gated by pending state, not the secret)
 *   POST /:secret/mcp         → MCP Streamable HTTP, stateless JSON responses
 *   GET  /:secret/health      → liveness + auth status (no secrets in the body)
 *
 * Everything else → 404 with an empty body.
 *
 * Trust model: single user. The 256-bit secret path segment is the only caller auth,
 * so treat the full /mcp URL like a password. Tokens and the client secret live in
 * Workers KV / Worker secrets — never in responses.
 *
 * Endpoint shapes, OAuth parameters, dailyRollUp caps and the privacy key lists are
 * ported from google-health-mcp-unofficial v0.7.8 (MIT), verified against
 * https://developers.google.com/health/reference/rest — credit to its authors.
 */

export interface Env {
  TOKENS: KVNamespace;
  GH_CLIENT_ID: string;
  GH_CLIENT_SECRET: string;
  SECRET_PATH: string;
}

const API_BASE = "https://health.googleapis.com";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  "https://www.googleapis.com/auth/googlehealth.settings.readonly",
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
  "https://www.googleapis.com/auth/googlehealth.ecg.readonly",
  "https://www.googleapis.com/auth/googlehealth.irn.readonly",
];

const SERVER_INFO = { name: "health-mcp", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SOURCE_FAMILIES = ["all-sources", "google-wearables", "google-sources"] as const;

// Google validates window_size_days * page_size <= maxDurationDays for some types.
const DAILY_ROLLUP_MAX_DURATION_DAYS: Record<string, number> = {
  "nutrition-log": 90,
  "total-calories": 14,
};
const DEFAULT_DAILY_ROLLUP_PAGE_SIZE = 90;

// ---------------------------------------------------------------------------
// Privacy filter (structured mode): identity/secret keys and location keys are
// dropped from every API response before it reaches the model.
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  "email", "fullname", "firstname", "lastname", "avatar", "photourl",
  "access_token", "refresh_token", "id_token", "authorization", "legacyuserid",
  "tcxlink", "client_secret", "api_key", "password",
].map((k) => normalizeKey(k)));

const GPS_LEAF_KEYS = new Set([
  "startLatitude", "startLongitude", "start_latlng", "endLatitude", "endLongitude", "end_latlng",
  "latitude", "longitude", "lat", "lon", "lng", "latlng", "coordinates", "coordinate",
  "gps", "gpx", "geoPolylineDTO", "map", "polyline", "summary_polyline", "activities-tracker-gps",
  "latitudeE7", "longitudeE7", "latE7", "lngE7", "lonE7",
  "startLatitudeE7", "startLongitudeE7", "endLatitudeE7", "endLongitudeE7",
  "lat_deg", "lng_deg", "lon_deg", "latitudeDegrees", "longitudeDegrees",
].map(normalizeKey));

const GPS_CONTAINER_KEYS = new Set([
  "location", "locations", "geoLocation", "geoLocations", "geo", "geoJson",
  "route", "routes", "position", "positions", "waypoint", "waypoints",
  "trackPoint", "trackPoints", "placeVisit",
].map(normalizeKey));

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function holdsObject(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => v !== null && typeof v === "object");
  return value !== null && typeof value === "object";
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const nk = normalizeKey(key);
    if (SENSITIVE_KEYS.has(nk)) continue;
    if (GPS_LEAF_KEYS.has(nk)) continue;
    if (GPS_CONTAINER_KEYS.has(nk) && holdsObject(v)) continue;
    out[key] = sanitize(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64url(digest);
}

function normalizeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date, expected YYYY-MM-DD: ${value}`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date: ${value}`);
  }
  return value;
}

function nextDate(value: string): string {
  const d = new Date(`${normalizeDate(value)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function civilDateTime(date: string) {
  const [year, month, day] = normalizeDate(date).split("-").map(Number);
  return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } };
}

function civilRange(startDate: string, endDateExclusive: string) {
  if (normalizeDate(startDate) >= normalizeDate(endDateExclusive)) {
    throw new Error("start_date must be earlier than end_date (end is exclusive)");
  }
  return { start: civilDateTime(startDate), end: civilDateTime(endDateExclusive) };
}

function sourceFamilyPath(family?: string): string | undefined {
  if (!family) return undefined;
  if (!(SOURCE_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(`source_family must be one of: ${SOURCE_FAMILIES.join(", ")}`);
  }
  return `users/me/dataSourceFamilies/${family}`;
}

function snakeType(dataType: string): string {
  return dataType.replace(/-/g, "_");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Token store (Workers KV) + Google Health HTTP client
// ---------------------------------------------------------------------------

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_at?: number; // unix seconds
}

const TOKENS_KEY = "tokens";

async function readTokens(env: Env): Promise<StoredTokens | null> {
  return (await env.TOKENS.get<StoredTokens>(TOKENS_KEY, "json")) ?? null;
}

async function requestTokens(env: Env, params: Record<string, string>): Promise<StoredTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GH_CLIENT_ID,
      client_secret: env.GH_CLIENT_SECRET,
      ...params,
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    const detail = typeof data.error === "string" ? `${data.error}: ${data.error_description ?? ""}` : `HTTP ${res.status}`;
    throw new Error(`Google token endpoint refused (${detail.trim()}). If this is invalid_grant, re-open your /authorize URL.`);
  }
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    expires_at:
      typeof data.expires_in === "number" ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
  };
}

async function refreshTokens(env: Env, current: StoredTokens): Promise<StoredTokens> {
  if (!current.refresh_token) throw new Error("No refresh token stored. Re-open your /authorize URL.");
  const fresh = await requestTokens(env, {
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  });
  const merged: StoredTokens = {
    ...current,
    ...fresh,
    refresh_token: fresh.refresh_token ?? current.refresh_token,
  };
  await env.TOKENS.put(TOKENS_KEY, JSON.stringify(merged));
  return merged;
}

async function getAccessToken(env: Env): Promise<string> {
  const tokens = await readTokens(env);
  if (!tokens?.access_token) {
    throw new Error("Not authorized yet. Open your saved /authorize URL once in a browser, approve, then retry.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (tokens.refresh_token && tokens.expires_at && tokens.expires_at - now < 120) {
    return (await refreshTokens(env, tokens)).access_token;
  }
  return tokens.access_token;
}

async function apiRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const doFetch = (token: string) =>
    fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch(await getAccessToken(env));
  if (res.status === 401) {
    const tokens = await readTokens(env);
    if (tokens) res = await doFetch((await refreshTokens(env, tokens)).access_token);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const msg = (data as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Google Health API error on ${method} ${path}: ${msg}`);
  }
  return sanitize(data);
}

// ---------------------------------------------------------------------------
// Google Health operations backing the tools
// ---------------------------------------------------------------------------

function clampPageSize(value: unknown, fallback: number, max = 1000): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, 1), max);
}

async function opListDataPoints(env: Env, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required (e.g. steps, sleep, heart-rate)");
  return apiRequest(env, "GET", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints`, {
    params: {
      pageSize: clampPageSize(a.page_size, 200),
      pageToken: a.page_token as string | undefined,
      filter: a.filter as string | undefined,
    },
  });
}

async function opReconcile(env: Env, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required");
  return apiRequest(env, "GET", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:reconcile`, {
    params: {
      pageSize: clampPageSize(a.page_size, 200),
      pageToken: a.page_token as string | undefined,
      filter: a.filter as string | undefined,
      dataSourceFamily: sourceFamilyPath(a.source_family as string | undefined),
    },
  });
}

async function opDailyRollup(env: Env, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required");
  const startDate = String(a.start_date ?? "");
  const endDate = a.end_date ? String(a.end_date) : nextDate(startDate);
  const windowSizeDays = Math.max(1, Math.trunc(Number(a.window_size_days ?? 1)));
  const cap = DAILY_ROLLUP_MAX_DURATION_DAYS[dataType];
  let pageSize = clampPageSize(a.page_size, DEFAULT_DAILY_ROLLUP_PAGE_SIZE);
  if (cap) pageSize = Math.min(pageSize, Math.max(1, Math.floor(cap / windowSizeDays)));
  return apiRequest(env, "POST", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:dailyRollUp`, {
    body: {
      range: civilRange(startDate, endDate),
      windowSizeDays,
      pageSize,
      pageToken: a.page_token,
      dataSourceFamily: sourceFamilyPath(a.source_family as string | undefined),
    },
  });
}

async function opRollup(env: Env, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required");
  const startTime = String(a.start_time ?? "");
  const endTime = String(a.end_time ?? "");
  if (!startTime || !endTime || Date.parse(startTime) >= Date.parse(endTime)) {
    throw new Error("start_time and end_time must be RFC3339 timestamps with start < end");
  }
  return apiRequest(env, "POST", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:rollUp`, {
    body: {
      range: { startTime, endTime },
      windowSize: a.window_size,
      pageSize: clampPageSize(a.page_size, 100),
      pageToken: a.page_token,
      dataSourceFamily: sourceFamilyPath(a.source_family as string | undefined),
    },
  });
}

async function opSleepSessions(env: Env, a: Record<string, unknown>) {
  const start = normalizeDate(String(a.start_date ?? ""));
  const end = a.end_date ? normalizeDate(String(a.end_date)) : nextDate(start);
  // Sleep sessions filter on civil_end_time so a night belongs to its wake-up date.
  const filter = `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${end}"`;
  return opListDataPoints(env, { data_type: "sleep", filter, page_size: 100 });
}

const DAILY_SAMPLE_TYPES = [
  "daily-resting-heart-rate",
  "daily-heart-rate-variability",
  "daily-oxygen-saturation",
  "daily-respiratory-rate",
];

async function opDailySummary(env: Env, a: Record<string, unknown>) {
  const date = normalizeDate(String(a.date ?? ""));
  const end = nextDate(date);
  const settle = async <T>(label: string, p: Promise<T>): Promise<[string, unknown]> => {
    try {
      return [label, await p];
    } catch (err) {
      return [label, { error: err instanceof Error ? err.message : String(err) }];
    }
  };
  const rollup = (type: string) => opDailyRollup(env, { data_type: type, start_date: date, end_date: end });
  const daily = (type: string) =>
    opListDataPoints(env, {
      data_type: type,
      filter: `${snakeType(type)}.date >= "${date}" AND ${snakeType(type)}.date < "${end}"`,
      page_size: 10,
    });
  const entries = await Promise.all([
    settle("steps", rollup("steps")),
    settle("distance", rollup("distance")),
    settle("active_zone_minutes", rollup("active-zone-minutes")),
    settle("total_calories", rollup("total-calories")),
    ...DAILY_SAMPLE_TYPES.map((t) => settle(snakeType(t), daily(t))),
    settle("sleep", opSleepSessions(env, { start_date: date, end_date: end })),
  ]);
  return { date, ...Object.fromEntries(entries) };
}

async function opConnectionStatus(env: Env) {
  const tokens = await readTokens(env);
  const now = Math.floor(Date.now() / 1000);
  return {
    server: SERVER_INFO,
    authorized: Boolean(tokens?.access_token),
    has_refresh_token: Boolean(tokens?.refresh_token),
    access_token_expires_in_s: tokens?.expires_at ? tokens.expires_at - now : null,
    granted_scopes: tokens?.scope?.split(" ") ?? [],
    privacy_mode: "structured (identity + location keys removed)",
    hint: tokens?.access_token ? "Ready." : "Open your saved /authorize URL in a browser to connect Google Health.",
  };
}

// ---------------------------------------------------------------------------
// MCP tool catalog
// ---------------------------------------------------------------------------

type ToolHandler = (env: Env, args: Record<string, unknown>) => Promise<unknown>;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const sourceFamilyProp = {
  type: "string",
  enum: [...SOURCE_FAMILIES],
  description: "Restrict to a data source family (default: all sources).",
};

const TOOLS: Array<{ name: string; description: string; inputSchema: unknown; handler: ToolHandler }> = [
  {
    name: "health_connection_status",
    description: "Check whether the server is authorized to Google Health, which scopes are granted, and token freshness. Call this first if other tools fail.",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => opConnectionStatus(env),
  },
  {
    name: "health_list_data_types",
    description: "List every Google Health data type available to this account (names, units, structure).",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => apiRequest(env, "GET", "/v4/users/me/dataTypes", { params: { pageSize: 200 } }),
  },
  {
    name: "health_get_profile",
    description: "Read the user's Google Health profile and settings (display units, time zone, paired devices). Identity fields are redacted.",
    inputSchema: { type: "object", properties: {} },
    handler: async (env) => ({
      profile: await apiRequest(env, "GET", "/v4/users/me/profile"),
      settings: await apiRequest(env, "GET", "/v4/users/me/settings"),
    }),
  },
  {
    name: "health_daily_summary",
    description: "One day at a glance: steps, distance, active zone minutes, calories, resting heart rate, HRV, SpO2, respiratory rate, and sleep sessions for a civil date (YYYY-MM-DD).",
    inputSchema: {
      type: "object",
      properties: { date: str("Civil date YYYY-MM-DD (use yesterday for complete data)") },
      required: ["date"],
    },
    handler: (env, a) => opDailySummary(env, a),
  },
  {
    name: "health_daily_rollup",
    description: "Per-day aggregates of one data type over a date range — the workhorse for trends (steps/day, sleep minutes/day, calories/day). end_date is exclusive.",
    inputSchema: {
      type: "object",
      properties: {
        data_type: str("Kebab-case data type, e.g. steps, distance, active-zone-minutes, total-calories, weight"),
        start_date: str("YYYY-MM-DD inclusive"),
        end_date: str("YYYY-MM-DD exclusive (default: start_date + 1)"),
        window_size_days: num("Aggregate window in days (default 1)"),
        page_size: num("Max windows per page"),
        page_token: str("Token from a previous page"),
        source_family: sourceFamilyProp,
      },
      required: ["data_type", "start_date"],
    },
    handler: (env, a) => opDailyRollup(env, a),
  },
  {
    name: "health_rollup",
    description: "Aggregates over arbitrary timezone-aware windows (RFC3339 start/end). Use for sub-daily or custom windows; prefer health_daily_rollup for whole days.",
    inputSchema: {
      type: "object",
      properties: {
        data_type: str("Kebab-case data type"),
        start_time: str("RFC3339, e.g. 2026-09-01T00:00:00-04:00"),
        end_time: str("RFC3339, exclusive"),
        window_size: str("Optional window duration, e.g. 3600s"),
        page_size: num("Max windows per page"),
        page_token: str("Token from a previous page"),
        source_family: sourceFamilyProp,
      },
      required: ["data_type", "start_time", "end_time"],
    },
    handler: (env, a) => opRollup(env, a),
  },
  {
    name: "health_list_data_points",
    description: "Raw data points of one type at full resolution, with an optional filter expression. Filters use snake_case members, e.g. heart_rate.sample_time.physical_time >= \"2026-09-01T00:00:00Z\", steps.interval.civil_start_time >= \"2026-09-01\", daily_resting_heart_rate.date >= \"2026-09-01\". Intraday heart-rate is ~5-second samples — keep windows short and prefer rollups for long ranges.",
    inputSchema: {
      type: "object",
      properties: {
        data_type: str("Kebab-case data type, e.g. heart-rate, sleep, daily-resting-heart-rate"),
        filter: str("Optional filter expression (see description for member spelling)"),
        page_size: num("Max points per page (default 200, max 1000)"),
        page_token: str("Token from a previous page"),
      },
      required: ["data_type"],
    },
    handler: (env, a) => opListDataPoints(env, a),
  },
  {
    name: "health_sleep_sessions",
    description: "Sleep sessions (with stages) whose wake-up time falls in [start_date, end_date). Convenience over health_list_data_points with the correct civil_end_time filter.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: str("YYYY-MM-DD inclusive (wake-up date)"),
        end_date: str("YYYY-MM-DD exclusive (default: start_date + 1)"),
      },
      required: ["start_date"],
    },
    handler: (env, a) => opSleepSessions(env, a),
  },
  {
    name: "health_reconcile_data_points",
    description: "Changed data points since a previous sync cursor — incremental sync without re-reading history.",
    inputSchema: {
      type: "object",
      properties: {
        data_type: str("Kebab-case data type"),
        filter: str("Optional filter expression"),
        page_size: num("Max points per page"),
        page_token: str("Reconcile cursor from a previous call"),
        source_family: sourceFamilyProp,
      },
      required: ["data_type"],
    },
    handler: (env, a) => opReconcile(env, a),
  },
];

// ---------------------------------------------------------------------------
// MCP Streamable HTTP (stateless, JSON responses)
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MAX_RESULT_CHARS = 180_000;

function toolResultText(data: unknown): string {
  const text = JSON.stringify(data, null, 1) ?? "null";
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated — narrow the date range or page_size]`
    : text;
}

async function handleRpc(env: Env, msg: RpcMessage): Promise<Record<string, unknown> | null> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) =>
    isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } };

  try {
    switch (method) {
      case "initialize": {
        const requested = String(params?.protocolVersion ?? "");
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : "2025-03-26";
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Single-user Google Health data (Fitbit Air via the Google Health app). All tools are read-only. Prefer health_daily_summary / health_daily_rollup; keep intraday list windows short. Data is not medical advice.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const name = String(params?.name ?? "");
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        try {
          const data = await tool.handler(env, args);
          return reply({ content: [{ type: "text", text: toolResultText(data) }] });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply({ content: [{ type: "text", text: message }], isError: true });
        }
      }
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        if (method?.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, err instanceof Error ? err.message : "Internal error");
  }
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // Stateless server: no SSE stream, no session to delete.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(env, m as RpcMessage)))).filter(
      (r): r is Record<string, unknown> => r !== null,
    );
    return replies.length === 0 ? new Response(null, { status: 202 }) : json(200, replies);
  }

  const reply = await handleRpc(env, body as RpcMessage);
  return reply === null ? new Response(null, { status: 202 }) : json(200, reply);
}

// ---------------------------------------------------------------------------
// OAuth endpoints
// ---------------------------------------------------------------------------

function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/oauth/callback`;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const state = randomToken(16);
  const verifier = randomToken(32);
  await env.TOKENS.put(`oauth_state:${state}`, verifier, { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.GH_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
    code_challenge: await sha256b64url(verifier),
    code_challenge_method: "S256",
  });
  return Response.redirect(`${AUTH_URL}?${params}`, 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const verifier = state ? await env.TOKENS.get(`oauth_state:${state}`) : null;
  if (!code || !verifier) {
    return new Response("Invalid or expired authorization attempt. Start again from your /authorize URL.", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  await env.TOKENS.delete(`oauth_state:${state}`);
  const tokens = await requestTokens(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(request),
    code_verifier: verifier,
  });
  const scope = tokens.scope ?? url.searchParams.get("scope") ?? undefined;
  await env.TOKENS.put(TOKENS_KEY, JSON.stringify({ ...tokens, scope }));
  const scopeCount = scope ? scope.split(" ").length : 0;
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Connected</title>
     <body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; line-height: 1.6">
     <h1>Connected &#10003;</h1>
     <p>health-mcp is now authorized to read your Google Health data (${scopeCount} scopes granted).
     You can close this tab and ask Claude a health question from any device.</p></body>`,
    { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // Fixed-path OAuth callback (protected by single-use state, not the secret,
    // so the secret never has to be registered in Google's console).
    if (segments.length === 2 && segments[0] === "oauth" && segments[1] === "callback") {
      return handleCallback(request, env);
    }

    // Everything else lives under the secret path segment.
    if (segments.length === 2 && env.SECRET_PATH && segments[0] === env.SECRET_PATH) {
      switch (segments[1]) {
        case "mcp":
          return handleMcp(request, env);
        case "authorize":
          return handleAuthorize(request, env);
        case "health": {
          const tokens = await readTokens(env);
          return json(200, { ok: true, authorized: Boolean(tokens?.access_token), server: SERVER_INFO });
        }
      }
    }

    return new Response(null, { status: 404 });
  },
};

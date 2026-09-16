/**
 * health-mcp — single-user Google Health API v4 MCP server.
 *
 * Runtime-agnostic: this module only uses standard Web APIs (fetch, Request,
 * Response, crypto.subtle, URL), so it runs unchanged on Node 22 behind the
 * adapter in server.ts.
 *
 * Routes:
 *   GET  /:secret/authorize   302 to Google consent (PKCE S256, state in the store)
 *   GET  /oauth/callback      code exchange; tokens persisted
 *   POST /:secret/mcp         MCP Streamable HTTP, stateless JSON responses
 *   GET  /:secret/health      liveness + auth status (no secrets in the body)
 *   GET  /healthz             unauthenticated liveness for Cloud Run probes
 *
 * Endpoint shapes, OAuth parameters, dailyRollUp caps and the privacy key lists
 * are ported from google-health-mcp-unofficial v0.7.8 (MIT), verified against
 * https://developers.google.com/health/reference/rest — credit to its authors.
 */

import type { Store, StoredTokens } from "./store.js";

export interface Env {
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

const SERVER_INFO = { name: "health-mcp", version: "2.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SOURCE_FAMILIES = ["all-sources", "google-wearables", "google-sources"] as const;

// Google caps the civil range of a single dailyRollUp request by data type: 14 days
// for the four types below and 90 days for every other type (REST reference,
// users.dataTypes.dataPoints/dailyRollUp, `range`). Longer ranges are split into
// consecutive chunks, and window_size_days * page_size is kept within the same cap.
const DAILY_ROLLUP_RANGE_CAP_DAYS: Record<string, number> = {
  "total-calories": 14,
  "heart-rate": 14,
  "active-minutes": 14,
  "calories-in-heart-rate-zone": 14,
};
const DEFAULT_DAILY_ROLLUP_RANGE_CAP_DAYS = 90;
const DEFAULT_DAILY_ROLLUP_PAGE_SIZE = 90;
// Bounds how many nextPageToken hops one chunk may take, so a bad cursor can't loop.
const MAX_ROLLUP_PAGES_PER_CHUNK = 10;

export function dailyRollupCapDays(dataType: string): number {
  return DAILY_ROLLUP_RANGE_CAP_DAYS[dataType] ?? DEFAULT_DAILY_ROLLUP_RANGE_CAP_DAYS;
}

// ---------------------------------------------------------------------------
// Privacy filter (structured mode)
// ---------------------------------------------------------------------------

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SENSITIVE_KEYS = new Set(
  [
    "email", "fullName", "firstName", "lastName", "avatar", "photoUrl",
    "access_token", "refresh_token", "id_token", "authorization", "legacyUserId",
    "tcxLink", "client_secret", "api_key", "password",
  ].map(normalizeKey),
);

const GPS_LEAF_KEYS = new Set(
  [
    "startLatitude", "startLongitude", "start_latlng", "endLatitude", "endLongitude", "end_latlng",
    "latitude", "longitude", "lat", "lon", "lng", "latlng", "coordinates", "coordinate",
    "gps", "gpx", "geoPolylineDTO", "map", "polyline", "summary_polyline", "activities-tracker-gps",
    "latitudeE7", "longitudeE7", "latE7", "lngE7", "lonE7",
    "startLatitudeE7", "startLongitudeE7", "endLatitudeE7", "endLongitudeE7",
    "lat_deg", "lng_deg", "lon_deg", "latitudeDegrees", "longitudeDegrees",
  ].map(normalizeKey),
);

const GPS_CONTAINER_KEYS = new Set(
  [
    "location", "locations", "geoLocation", "geoLocations", "geo", "geoJson",
    "route", "routes", "position", "positions", "waypoint", "waypoints",
    "trackPoint", "trackPoints", "placeVisit",
  ].map(normalizeKey),
);

function holdsObject(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => v !== null && typeof v === "object");
  return value !== null && typeof value === "object";
}

export function sanitize(value: unknown): unknown {
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

function shiftDate(value: string, days: number): string {
  const d = new Date(`${normalizeDate(value)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextDate(value: string): string {
  return shiftDate(value, 1);
}

function daysBetween(start: string, endExclusive: string): number {
  const a = Date.parse(`${normalizeDate(start)}T00:00:00Z`);
  const b = Date.parse(`${normalizeDate(endExclusive)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Split the civil range [start, endExclusive) into consecutive, non-overlapping
 * chunks of at most `maxDays` days; the last chunk may be shorter.
 */
export function chunkCivilRange(start: string, endExclusive: string, maxDays: number): Array<[string, string]> {
  const span = daysBetween(start, endExclusive);
  if (span <= 0) throw new Error("start_date must be earlier than end_date (end is exclusive)");
  const step = Math.max(1, Math.trunc(maxDays));
  const chunks: Array<[string, string]> = [];
  for (let offset = 0; offset < span; offset += step) {
    chunks.push([shiftDate(start, offset), shiftDate(start, Math.min(offset + step, span))]);
  }
  return chunks;
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
// Google OAuth + Health API client
// ---------------------------------------------------------------------------

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
    const detail =
      typeof data.error === "string" ? `${data.error}: ${data.error_description ?? ""}` : `HTTP ${res.status}`;
    throw new Error(
      `Google token endpoint refused (${detail.trim()}). If this is invalid_grant, re-open your /authorize URL.`,
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    expires_at: typeof data.expires_in === "number" ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
  };
}

const NOT_AUTHORIZED = "Not authorized yet. Open your saved /authorize URL once in a browser, approve, then retry.";

// Callers on the same instance that need a refresh at the same moment share one
// request to Google instead of each spending the refresh token.
const inflightRefresh = new WeakMap<Store, Promise<StoredTokens>>();

function refreshTokens(env: Env, store: Store, current: StoredTokens): Promise<StoredTokens> {
  const pending = inflightRefresh.get(store);
  if (pending) return pending;
  const refresh = (async () => {
    if (!current.refresh_token) throw new Error("No refresh token stored. Re-open your /authorize URL.");
    const fresh = await requestTokens(env, { grant_type: "refresh_token", refresh_token: current.refresh_token });
    const merged: StoredTokens = { ...current, ...fresh, refresh_token: fresh.refresh_token ?? current.refresh_token };
    await store.writeTokens(merged);
    return merged;
  })().finally(() => inflightRefresh.delete(store));
  inflightRefresh.set(store, refresh);
  return refresh;
}

async function getAccessToken(env: Env, store: Store): Promise<string> {
  const tokens = await store.readTokens();
  if (!tokens?.access_token) throw new Error(NOT_AUTHORIZED);
  const now = Math.floor(Date.now() / 1000);
  if (tokens.refresh_token && tokens.expires_at && tokens.expires_at - now < 120) {
    return (await refreshTokens(env, store, tokens)).access_token;
  }
  return tokens.access_token;
}

interface Ctx {
  env: Env;
  store: Store;
  /** The access token for this HTTP request: looked up once, shared by every upstream call. */
  token?: Promise<string>;
  /** The renewal after Google answered 401, shared by every call that saw the 401. */
  renewal?: Promise<string>;
}

function accessToken(ctx: Ctx): Promise<string> {
  if (!ctx.token) {
    const lookup = getAccessToken(ctx.env, ctx.store);
    ctx.token = lookup;
    // Don't cache a failure: a later call in the same request looks again.
    lookup.catch(() => {
      if (ctx.token === lookup) ctx.token = undefined;
    });
  }
  return ctx.token;
}

function renewAfter401(ctx: Ctx): Promise<string> {
  if (!ctx.renewal) {
    ctx.renewal = (async () => {
      const tokens = await ctx.store.readTokens();
      if (!tokens?.access_token) throw new Error(NOT_AUTHORIZED);
      return (await refreshTokens(ctx.env, ctx.store, tokens)).access_token;
    })();
    ctx.token = ctx.renewal;
  }
  return ctx.renewal;
}

async function apiRequest(
  ctx: Ctx,
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

  let res = await doFetch(await accessToken(ctx));
  if (res.status === 401) res = await doFetch(await renewAfter401(ctx));
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
// Operations
// ---------------------------------------------------------------------------

function clampPageSize(value: unknown, fallback: number, max = 1000): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, 1), max);
}

async function opListDataPoints(ctx: Ctx, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required (e.g. steps, sleep, heart-rate)");
  return apiRequest(ctx, "GET", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints`, {
    params: {
      pageSize: clampPageSize(a.page_size, 200),
      pageToken: a.page_token as string | undefined,
      filter: a.filter as string | undefined,
    },
  });
}

async function opReconcile(ctx: Ctx, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required");
  return apiRequest(ctx, "GET", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:reconcile`, {
    params: {
      pageSize: clampPageSize(a.page_size, 200),
      pageToken: a.page_token as string | undefined,
      filter: a.filter as string | undefined,
      dataSourceFamily: sourceFamilyPath(a.source_family as string | undefined),
    },
  });
}

function parseWindowSizeDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) throw new Error("window_size_days must be a whole number of days, at least 1");
  return n;
}

interface RollupPage {
  rollupDataPoints?: unknown;
  nextPageToken?: unknown;
}

function dailyRollupPage(
  ctx: Ctx,
  dataType: string,
  range: [string, string],
  windowSizeDays: number,
  pageSize: number,
  pageToken: string | undefined,
  sourceFamily: string | undefined,
): Promise<RollupPage> {
  return apiRequest(ctx, "POST", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:dailyRollUp`, {
    body: {
      range: civilRange(range[0], range[1]),
      windowSizeDays,
      pageSize,
      pageToken,
      dataSourceFamily: sourceFamilyPath(sourceFamily),
    },
  }) as Promise<RollupPage>;
}

function civilDayKey(point: unknown): number | null {
  const date = (point as { civilStartTime?: { date?: { year?: unknown; month?: unknown; day?: unknown } } })
    ?.civilStartTime?.date;
  if (!date || typeof date.year !== "number") return null;
  return date.year * 10_000 + Number(date.month ?? 0) * 100 + Number(date.day ?? 0);
}

/** Chunks come back oldest range first; present one newest-first series, as Google orders a single page. */
function newestFirst(chunks: unknown[][]): unknown[] {
  const all = chunks.flat();
  const keys = all.map(civilDayKey);
  if (keys.some((k) => k === null)) return chunks.slice().reverse().flat();
  return all
    .map((point, i) => ({ point, i, key: keys[i] as number }))
    .sort((x, y) => y.key - x.key || x.i - y.i)
    .map((e) => e.point);
}

async function opDailyRollup(ctx: Ctx, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required");
  const startDate = normalizeDate(String(a.start_date ?? ""));
  const endDate = a.end_date ? normalizeDate(String(a.end_date)) : nextDate(startDate);
  const windowSizeDays = parseWindowSizeDays(a.window_size_days);
  const cap = dailyRollupCapDays(dataType);
  if (windowSizeDays > cap) {
    throw new Error(`window_size_days can be at most ${cap} for ${dataType}; Google limits one request to ${cap} days.`);
  }
  const pageSize = Math.min(clampPageSize(a.page_size, DEFAULT_DAILY_ROLLUP_PAGE_SIZE), Math.floor(cap / windowSizeDays));
  const sourceFamily = a.source_family as string | undefined;

  // An explicit page_token means the caller is paging by hand: return exactly that page.
  if (typeof a.page_token === "string" && a.page_token) {
    return dailyRollupPage(ctx, dataType, [startDate, endDate], windowSizeDays, pageSize, a.page_token, sourceFamily);
  }

  // Otherwise split the range to fit the cap (in whole windows) and follow every page.
  const chunks = chunkCivilRange(startDate, endDate, Math.floor(cap / windowSizeDays) * windowSizeDays);
  let truncated = false;
  const perChunk = await Promise.all(
    chunks.map(async (range) => {
      const points: unknown[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_ROLLUP_PAGES_PER_CHUNK; page++) {
        const res = await dailyRollupPage(ctx, dataType, range, windowSizeDays, pageSize, pageToken, sourceFamily);
        if (Array.isArray(res.rollupDataPoints)) points.push(...res.rollupDataPoints);
        pageToken = typeof res.nextPageToken === "string" && res.nextPageToken ? res.nextPageToken : undefined;
        if (!pageToken) return points;
      }
      truncated = true;
      return points;
    }),
  );
  return truncated
    ? { rollupDataPoints: newestFirst(perChunk), truncated: true }
    : { rollupDataPoints: newestFirst(perChunk) };
}

async function opRollup(ctx: Ctx, a: Record<string, unknown>) {
  const dataType = String(a.data_type ?? "").trim();
  if (!dataType) throw new Error("data_type is required");
  const startTime = String(a.start_time ?? "");
  const endTime = String(a.end_time ?? "");
  if (!startTime || !endTime || Date.parse(startTime) >= Date.parse(endTime)) {
    throw new Error("start_time and end_time must be RFC3339 timestamps with start < end");
  }
  return apiRequest(ctx, "POST", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:rollUp`, {
    body: {
      range: { startTime, endTime },
      windowSize: a.window_size,
      pageSize: clampPageSize(a.page_size, 100),
      pageToken: a.page_token,
      dataSourceFamily: sourceFamilyPath(a.source_family as string | undefined),
    },
  });
}

async function opSleepSessions(ctx: Ctx, a: Record<string, unknown>) {
  const start = normalizeDate(String(a.start_date ?? ""));
  const end = a.end_date ? normalizeDate(String(a.end_date)) : nextDate(start);
  // Sleep sessions filter on civil_end_time so a night belongs to its wake-up date.
  const filter = `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${end}"`;
  return opListDataPoints(ctx, { data_type: "sleep", filter, page_size: clampPageSize(a.page_size, 100) });
}

/** Daily-summary data types that are read via list + a `<type>.date` filter. */
const DAILY_SAMPLE_TYPES = [
  "daily-resting-heart-rate",
  "daily-heart-rate-variability",
  "daily-oxygen-saturation",
  "daily-respiratory-rate",
];

const ROLLUP_METRICS = ["steps", "distance", "active-zone-minutes", "total-calories"];

async function settle<T>(label: string, p: Promise<T>): Promise<[string, unknown]> {
  try {
    return [label, await p];
  } catch (err) {
    return [label, { error: err instanceof Error ? err.message : String(err) }];
  }
}

function dailyListArgs(type: string, start: string, end: string, pageSize: number) {
  const member = snakeType(type);
  return {
    data_type: type,
    filter: `${member}.date >= "${start}" AND ${member}.date < "${end}"`,
    page_size: pageSize,
  };
}

async function opDailySummary(ctx: Ctx, a: Record<string, unknown>) {
  const date = normalizeDate(String(a.date ?? ""));
  const end = nextDate(date);
  const entries = await Promise.all([
    ...ROLLUP_METRICS.map((t) =>
      settle(snakeType(t), opDailyRollup(ctx, { data_type: t, start_date: date, end_date: end })),
    ),
    ...DAILY_SAMPLE_TYPES.map((t) => settle(snakeType(t), opListDataPoints(ctx, dailyListArgs(t, date, end, 10)))),
    settle("sleep", opSleepSessions(ctx, { start_date: date, end_date: end })),
  ]);
  return { date, ...Object.fromEntries(entries) };
}

/**
 * Multi-week trend pull. This is the tool the Cloudflare free plan could not
 * host: it fans out to 9 upstream calls for a short range and up to 47 for a
 * year (each rollup split to fit Google's per-type range cap), which exceeded
 * both the 10 ms CPU budget and the 50-subrequest cap there.
 */
async function opTrendReport(ctx: Ctx, a: Record<string, unknown>) {
  const start = normalizeDate(String(a.start_date ?? ""));
  const end = a.end_date ? normalizeDate(String(a.end_date)) : nextDate(start);
  const span = daysBetween(start, end);
  if (span <= 0) throw new Error("start_date must be earlier than end_date (end is exclusive)");
  if (span > 366) throw new Error("Range is limited to 366 days; ask for a narrower window.");

  const requested = Array.isArray(a.metrics) ? (a.metrics as string[]).map(String) : null;
  const rollups = requested ? ROLLUP_METRICS.filter((m) => requested.includes(m)) : ROLLUP_METRICS;
  const samples = requested ? DAILY_SAMPLE_TYPES.filter((m) => requested.includes(m)) : DAILY_SAMPLE_TYPES;
  const wantSleep = !requested || requested.includes("sleep");

  // Each rollup is split to fit its type's range cap (14 or 90 days) inside opDailyRollup.
  const rollupTasks = rollups.map((type) =>
    settle(snakeType(type), opDailyRollup(ctx, { data_type: type, start_date: start, end_date: end })),
  );

  const entries = await Promise.all([
    ...rollupTasks,
    ...samples.map((t) => settle(snakeType(t), opListDataPoints(ctx, dailyListArgs(t, start, end, Math.min(span + 5, 1000))))),
    ...(wantSleep ? [settle("sleep", opSleepSessions(ctx, { start_date: start, end_date: end, page_size: Math.min(span + 5, 1000) }))] : []),
  ]);

  return { start_date: start, end_date_exclusive: end, days: span, ...Object.fromEntries(entries) };
}

async function opConnectionStatus(ctx: Ctx) {
  const tokens = await ctx.store.readTokens();
  const now = Math.floor(Date.now() / 1000);
  return {
    server: SERVER_INFO,
    host: "Google Cloud Run",
    authorized: Boolean(tokens?.access_token),
    has_refresh_token: Boolean(tokens?.refresh_token),
    access_token_expires_in_s: tokens?.expires_at ? tokens.expires_at - now : null,
    granted_scopes: tokens?.scope?.split(" ") ?? [],
    privacy_mode: "structured (identity + location keys removed)",
    hint: tokens?.access_token
      ? "Ready."
      : "Open your saved /authorize URL in a browser to connect Google Health.",
  };
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

type ToolHandler = (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const sourceFamilyProp = {
  type: "string",
  enum: [...SOURCE_FAMILIES],
  description: "Restrict to a data source family (default: all sources).",
};

export const TOOLS: Array<{ name: string; description: string; inputSchema: unknown; handler: ToolHandler }> = [
  {
    name: "health_connection_status",
    description:
      "Check whether the server is authorized to Google Health, which scopes are granted, and token freshness. Call this first if other tools fail.",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => opConnectionStatus(ctx),
  },
  {
    name: "health_list_data_types",
    description: "List every Google Health data type available to this account (names, units, structure).",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => apiRequest(ctx, "GET", "/v4/users/me/dataTypes", { params: { pageSize: 200 } }),
  },
  {
    name: "health_get_profile",
    description:
      "Read the user's Google Health profile and settings (display units, time zone, paired devices). Identity fields are redacted.",
    inputSchema: { type: "object", properties: {} },
    handler: async (ctx) => ({
      profile: await apiRequest(ctx, "GET", "/v4/users/me/profile"),
      settings: await apiRequest(ctx, "GET", "/v4/users/me/settings"),
    }),
  },
  {
    name: "health_daily_summary",
    description:
      "One day at a glance: steps, distance, active zone minutes, calories, resting heart rate, HRV, SpO2, respiratory rate, and sleep sessions for a civil date (YYYY-MM-DD).",
    inputSchema: {
      type: "object",
      properties: { date: str("Civil date YYYY-MM-DD (use yesterday for complete data)") },
      required: ["date"],
    },
    handler: (ctx, a) => opDailySummary(ctx, a),
  },
  {
    name: "health_trend_report",
    description:
      "Every headline metric across a date range in one call — daily steps, distance, active zone minutes and calories, plus daily resting heart rate, HRV, SpO2, respiratory rate and sleep sessions. Use this for trend questions ('last 8 weeks', 'this month vs last') instead of many separate calls. Ranges up to 366 days.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: str("YYYY-MM-DD inclusive"),
        end_date: str("YYYY-MM-DD exclusive (default: start_date + 1)"),
        metrics: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional subset, e.g. [\"steps\",\"sleep\",\"daily-resting-heart-rate\"]. Omit for everything.",
        },
      },
      required: ["start_date"],
    },
    handler: (ctx, a) => opTrendReport(ctx, a),
  },
  {
    name: "health_daily_rollup",
    description:
      "Per-day aggregates of one data type over a date range — steps/day, calories/day, weight over time. end_date is exclusive. Long ranges are split to fit Google's per-type limit (14 days for total-calories and heart-rate, 90 for most types) and every page is returned in one list.",
    inputSchema: {
      type: "object",
      properties: {
        data_type: str("Kebab-case data type, e.g. steps, distance, active-zone-minutes, total-calories, weight"),
        start_date: str("YYYY-MM-DD inclusive"),
        end_date: str("YYYY-MM-DD exclusive (default: start_date + 1)"),
        window_size_days: num("Aggregate window in days (default 1)"),
        page_size: num("Max windows per upstream page (all pages are fetched)"),
        page_token: str("Only to page by hand: returns that single page"),
        source_family: sourceFamilyProp,
      },
      required: ["data_type", "start_date"],
    },
    handler: (ctx, a) => opDailyRollup(ctx, a),
  },
  {
    name: "health_rollup",
    description:
      "Aggregates over arbitrary timezone-aware windows (RFC3339 start/end). Use for sub-daily or custom windows; prefer health_daily_rollup for whole days.",
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
    handler: (ctx, a) => opRollup(ctx, a),
  },
  {
    name: "health_list_data_points",
    description:
      'Raw data points of one type at full resolution, with an optional filter expression. Filters use snake_case members, e.g. heart_rate.sample_time.physical_time >= "2026-09-01T00:00:00Z", steps.interval.civil_start_time >= "2026-09-01", daily_resting_heart_rate.date >= "2026-09-01". Intraday heart-rate is ~5-second samples — keep windows short and prefer rollups for long ranges.',
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
    handler: (ctx, a) => opListDataPoints(ctx, a),
  },
  {
    name: "health_sleep_sessions",
    description:
      "Sleep sessions (with stages) whose wake-up time falls in [start_date, end_date). Convenience over health_list_data_points with the correct civil_end_time filter.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: str("YYYY-MM-DD inclusive (wake-up date)"),
        end_date: str("YYYY-MM-DD exclusive (default: start_date + 1)"),
        page_size: num("Max sessions per page"),
      },
      required: ["start_date"],
    },
    handler: (ctx, a) => opSleepSessions(ctx, a),
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
    handler: (ctx, a) => opReconcile(ctx, a),
  },
];

// ---------------------------------------------------------------------------
// MCP Streamable HTTP (stateless, JSON responses)
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const INVALID_REQUEST = { code: -32600, message: "Invalid Request" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Cloud Run has no 10 ms CPU ceiling, so this is about the model's context
// window rather than the runtime: a result larger than this is not useful.
const MAX_RESULT_CHARS = 400_000;

function toolResultText(data: unknown): string {
  const text = JSON.stringify(data, null, 1) ?? "null";
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated — narrow the date range or page_size]`
    : text;
}

async function handleRpc(ctx: Ctx, raw: unknown): Promise<Record<string, unknown> | null> {
  if (!isObject(raw)) return { jsonrpc: "2.0", id: null, error: INVALID_REQUEST };
  const msg = raw as RpcMessage;
  // A reply to a server-initiated request. This server never sends one, so accept and ignore it.
  if (msg.method === undefined && ("result" in msg || "error" in msg)) return null;
  const idOk = msg.id === undefined || msg.id === null || typeof msg.id === "string" || typeof msg.id === "number";
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !idOk) {
    const badId = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
    return { jsonrpc: "2.0", id: badId, error: INVALID_REQUEST };
  }
  const method = msg.method;
  const id = msg.id as string | number | null | undefined;
  const params = isObject(msg.params) ? msg.params : undefined;
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
            "Single-user Google Health data (Fitbit Air via the Google Health app). All tools are read-only. Use health_trend_report for multi-day trends, health_daily_summary for one day; keep intraday list windows short. Data is not medical advice.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const name = String(params?.name ?? "");
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        const args = isObject(params?.arguments) ? params.arguments : {};
        try {
          const data = await tool.handler(ctx, args);
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
        if (method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, err instanceof Error ? err.message : "Internal error");
  }
}

async function handleMcp(request: Request, ctx: Ctx): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  if (Array.isArray(body)) {
    // JSON-RPC 2.0: an empty batch is itself an invalid request.
    if (body.length === 0) return json(400, { jsonrpc: "2.0", id: null, error: INVALID_REQUEST });
    const replies = (await Promise.all(body.map((m) => handleRpc(ctx, m)))).filter(
      (r): r is Record<string, unknown> => r !== null,
    );
    return replies.length === 0 ? new Response(null, { status: 202 }) : json(200, replies);
  }

  const reply = await handleRpc(ctx, body);
  if (reply === null) return new Response(null, { status: 202 });
  return json(reply.error === INVALID_REQUEST ? 400 : 200, reply);
}

// ---------------------------------------------------------------------------
// OAuth endpoints
// ---------------------------------------------------------------------------

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/oauth/callback`;
}

async function handleAuthorize(request: Request, ctx: Ctx): Promise<Response> {
  const state = randomToken(16);
  const verifier = randomToken(32);
  // The PKCE verifier has to survive the round trip through Google, so an
  // unreachable store means the flow cannot start. Name it in the response:
  // only the secret holder reaches this route, and they are mid-setup.
  try {
    await ctx.store.putState(state, verifier, 600);
  } catch (err) {
    return new Response(
      "Cannot reach the token store, so the consent flow has nowhere to keep its PKCE verifier.\n\n" +
        `${err instanceof Error ? err.message : String(err)}\n\n` +
        "Check that a Native-mode Firestore database exists in this project (gcloud firestore databases list) " +
        "and that the runtime service account holds roles/datastore.user.",
      { status: 503, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } },
    );
  }
  const params = new URLSearchParams({
    client_id: ctx.env.GH_CLIENT_ID,
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
  return new Response(null, { status: 302, headers: { Location: `${AUTH_URL}?${params}`, "Cache-Control": "no-store" } });
}

async function handleCallback(request: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const verifier = state ? await ctx.store.takeState(state) : null;
  if (!code || !verifier) {
    return new Response("Invalid or expired authorization attempt. Start again from your /authorize URL.", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const tokens = await requestTokens(ctx.env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(request),
    code_verifier: verifier,
  });
  const scope = tokens.scope ?? url.searchParams.get("scope") ?? undefined;
  await ctx.store.writeTokens({ ...tokens, scope });
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

export async function handleRequest(request: Request, env: Env, store: Store): Promise<Response> {
  const ctx: Ctx = { env, store };
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);

  // Unauthenticated liveness probe for Cloud Run. Reveals nothing.
  if (segments.length === 1 && segments[0] === "healthz") {
    return json(200, { ok: true, server: SERVER_INFO });
  }

  // Fixed-path OAuth callback, protected by the single-use state nonce rather
  // than the secret path, so the secret never has to be registered with Google.
  if (segments.length === 2 && segments[0] === "oauth" && segments[1] === "callback") {
    return handleCallback(request, ctx);
  }

  if (segments.length === 2 && env.SECRET_PATH && segments[0] === env.SECRET_PATH) {
    switch (segments[1]) {
      case "mcp":
        return handleMcp(request, ctx);
      case "authorize":
        return handleAuthorize(request, ctx);
      case "health": {
        // Report a broken store rather than throwing: this is the endpoint you
        // curl when something is wrong, so it has to answer when it is.
        try {
          const tokens = await store.readTokens();
          return json(200, { ok: true, authorized: Boolean(tokens?.access_token), server: SERVER_INFO });
        } catch (err) {
          return json(503, {
            ok: false,
            store: "unreachable",
            error: err instanceof Error ? err.message : String(err),
            server: SERVER_INFO,
          });
        }
      }
    }
  }

  return new Response(null, { status: 404 });
}

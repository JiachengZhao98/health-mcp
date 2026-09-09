/**
 * Node HTTP adapter for Cloud Run.
 *
 * Cloud Run gives us a Node process and a $PORT; the handler in mcp.ts speaks
 * the Web Request/Response API. This file is the only glue between them, which
 * keeps the actual server logic runtime-agnostic (and identical to the edge
 * version it was ported from).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { handleRequest, type Env } from "./mcp.js";
import { FirestoreStore, MemoryStore, type Store } from "./store.js";

/**
 * Read config, trimming surrounding whitespace.
 *
 * Secret Manager stores bytes verbatim, so a secret created from `echo` or
 * pasted into the console textarea carries a trailing newline. An untrimmed
 * SECRET_PATH can never match a path segment, which turns every route into a
 * silent 404 — so normalize here rather than at each use.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const names = ["GH_CLIENT_ID", "GH_CLIENT_SECRET", "SECRET_PATH"] as const;
  const values = {} as Record<(typeof names)[number], string>;
  const missing: string[] = [];
  for (const name of names) {
    const raw = source[name] ?? "";
    const value = raw.trim();
    if (!value) missing.push(name);
    else if (value !== raw) console.warn(`${name} had surrounding whitespace; trimmed ${raw.length - value.length} character(s)`);
    values[name] = value;
  }
  if (missing.length > 0) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);

  // The three values are easy to cross-wire, and Google reports the result as a
  // bare "invalid_client" on the consent screen with no hint as to which one is
  // wrong. Their shapes are distinctive, so say so here instead. A real client
  // ID is the project *number*, then a hash: 9078…64489-a1b2c3.apps.
  // googleusercontent.com — the suffix alone proves nothing, since appending it
  // to a project ID produces a plausible-looking string Google has never heard of.
  if (!/^\d+(-[a-z0-9_]+)?\.apps\.googleusercontent\.com$/.test(values.GH_CLIENT_ID)) {
    console.warn(
      values.GH_CLIENT_ID.startsWith("GOCSPX-")
        ? "GH_CLIENT_ID holds a client secret (GOCSPX-…), not a client ID — gh-client-id and gh-client-secret look swapped; Google will answer invalid_client"
        : "GH_CLIENT_ID is not shaped like a client ID (expected <project-number>-<hash>.apps.googleusercontent.com, copied verbatim from the Clients console); Google will answer invalid_client",
    );
  }
  if (values.GH_CLIENT_SECRET.endsWith(".apps.googleusercontent.com")) {
    console.warn("GH_CLIENT_SECRET holds a client ID — gh-client-id and gh-client-secret look swapped");
  }
  return values;
}

/**
 * Log the shape of traffic, never its contents. The first segment of a gated
 * route is the URL secret, so it never reaches the log: the marker says only
 * whether it matched, which is what separates a wrong-secret 404 from a
 * wrong-route one.
 */
export function redactPath(path: string, secret: string): string {
  const segments = path.split("/");
  const first = segments[1];
  if (first && first !== "healthz" && first !== "oauth") {
    segments[1] = first === secret ? ":secret" : ":bad-secret";
  }
  return segments.join("/");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Rebuild the externally visible URL: Cloud Run terminates TLS in front of us. */
function externalUrl(req: IncomingMessage): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = forwardedProto || "http";
  const host = String(req.headers.host ?? "localhost");
  return `${proto}://${host}${req.url ?? "/"}`;
}

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
  let bytes: Uint8Array | undefined;
  if (hasBody) {
    bytes = new Uint8Array(body.byteLength);
    bytes.set(body);
  }
  return new Request(externalUrl(req), { method, headers, body: bytes });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 0) headers["content-length"] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(body.length > 0 ? body : undefined);
}

export function createApp(env: Env, store: Store) {
  return createServer(async (req, res) => {
    const started = Date.now();
    try {
      const request = toRequest(req, await readBody(req));
      const response = await handleRequest(request, env, store);
      await writeResponse(res, response);
      // Log the shape of traffic, never its contents.
      const path = redactPath((req.url ?? "/").split("?")[0], env.SECRET_PATH);
      console.log(`${req.method} ${path} -> ${response.status} (${Date.now() - started}ms)`);
    } catch (err) {
      // Name the route and the provider's error code. An opaque 500 in Cloud
      // Run's request log is otherwise the only trace a failed dependency
      // leaves, and that log cannot say which call failed or why.
      const path = redactPath((req.url ?? "/").split("?")[0], env.SECRET_PATH);
      const code = (err as { code?: unknown }).code;
      console.error(
        `Unhandled error on ${req.method} ${path}${code === undefined ? "" : ` [code ${String(code)}]`}:`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        res.end();
      }
    }
  });
}

function main(): void {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // preferRest avoids pulling up a gRPC channel on every cold start; this
  // workload is a handful of tiny document reads, so REST is the cheaper path.
  const store: Store =
    process.env.HEALTH_MCP_STORE === "memory"
      ? new MemoryStore()
      : new FirestoreStore(new Firestore({ preferRest: true }));

  const port = Number(process.env.PORT ?? 8080);
  const server = createApp(env, store);
  // The secret itself stays out of the logs; its length is enough to confirm
  // the deploy picked up the version you think it did.
  server.listen(port, () =>
    console.log(`health-mcp listening on :${port} (secret path segment: ${env.SECRET_PATH.length} chars)`),
  );

  // Cloud Run sends SIGTERM before reclaiming an idle instance.
  process.on("SIGTERM", () => {
    console.log("SIGTERM received, closing");
    server.close(() => process.exit(0));
  });
}

// Only start a listener when run directly, so tests can import createApp.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

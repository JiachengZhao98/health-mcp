# health-mcp on Cloud Run

The cloud half of [Health MCP](../README.md): a single-user Google Health API v4 MCP server running on Cloud Run, so Claude can read your health data from any device — phone included — with no computer awake anywhere.

Everything lives in the same Google Cloud project as the OAuth client and the health data itself: one console, one bill, one place to audit.

- **MCP over Streamable HTTP** — stateless JSON, works as a claude.ai custom connector
- **OAuth handled by the service** — one browser consent; tokens in Firestore; automatic refresh
- **Read-only** — 8 `googlehealth.*.readonly` scopes, nothing else
- **Structured-mode privacy filter** — identity and location keys stripped from every response before the model sees it (key lists ported from `google-health-mcp-unofficial`, MIT — credit to its authors)
- **No CPU ceiling**, unlike the edge version: `health_trend_report` pulls every headline metric across up to 366 days in one call

## Access model — read before deploying

There is no login on the MCP endpoint. Every route lives under a 256-bit secret path segment: `https://<service-url>/<SECRET>/mcp`. Whoever holds that URL can read your health data, so treat it like a password — it goes into claude.ai's connector settings and nowhere else. Rotate by adding a new secret version and redeploying.

Two paths sit outside the secret: `/oauth/callback`, guarded by a single-use PKCE `state` nonce so the secret never has to be registered with Google, and `/healthz`, which returns only a liveness flag.

Cloud Run's own IAM authentication can't be used here — claude.ai speaks plain HTTPS and can't sign Google IAM requests — hence `--allow-unauthenticated` plus the secret path.

## Deploy (≈20 minutes)

Prereqs: the [gcloud CLI](https://cloud.google.com/sdk/docs/install), and a Google Cloud project with an OAuth client of type **Web application** under [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients). Reuse the one the Mac setup made only if it is a Web application client — a Desktop client cannot register the `https://…/oauth/callback` redirect URI this service needs. Creating a second client in the same project is fine; each gets its own consent.

```bash
cd cloudrun
gcloud auth login
gcloud config set project YOUR_PROJECT_ID      # the health-mcp project
export PROJECT_ID=$(gcloud config get-value project)
export REGION=us-central1

# 1. APIs
gcloud services enable run.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 2. Firestore (Native mode) — the token store. One per project; skip if it exists.
gcloud firestore databases create --location=$REGION --type=firestore-native

# 3. Secrets. Copy both values verbatim from Google Auth Platform -> Clients; the
#    client ID already ends in .apps.googleusercontent.com, so paste the whole
#    thing -- it starts with the project *number*, not the project ID.
printf '%s' "123456789012-abcdef0123456789.apps.googleusercontent.com" | gcloud secrets create gh-client-id --data-file=-
printf '%s' "GOCSPX-your-client-secret" | gcloud secrets create gh-client-secret --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create health-mcp-secret-path --data-file=-

# 4. A dedicated runtime identity with only the two roles it needs
gcloud iam service-accounts create health-mcp --display-name="health-mcp Cloud Run"
export SA=health-mcp@$PROJECT_ID.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role=roles/datastore.user
for s in gh-client-id gh-client-secret health-mcp-secret-path; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done

# 5. Ship it (Cloud Build picks up the Dockerfile automatically)
gcloud run deploy health-mcp \
  --source . \
  --region=$REGION \
  --service-account=$SA \
  --allow-unauthenticated \
  --min-instances=0 --max-instances=2 \
  --cpu=1 --memory=512Mi --timeout=300 \
  --set-secrets=GH_CLIENT_ID=gh-client-id:latest,GH_CLIENT_SECRET=gh-client-secret:latest,SECRET_PATH=health-mcp-secret-path:latest
```

Then collect the two values you need:

```bash
gcloud run services describe health-mcp --region=$REGION --format='value(status.url)'
gcloud secrets versions access latest --secret=health-mcp-secret-path
```

## Wire up Google (once)

1. [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients) → your OAuth client → add an authorized redirect URI:
   `https://<service-url>/oauth/callback`
2. Visit `https://<service-url>/<SECRET>/authorize` in any browser, pick your Google Health account, approve. You should land on "Connected ✓".

`<SECRET>` is the 64-character hex string from `health-mcp-secret-path` — the one `openssl rand -hex 32` generated in step 3 of the deploy, printed by the second command above. It is *not* the OAuth client secret (`GOCSPX-…`), which never appears in a URL; the service sends that to Google itself, from Secret Manager. Pasting the wrong one gives a bare 404, because no route matches.

Your existing `run.app` domain needs no entry under Authorized domains — that list governs the consent screen's own links, which still point at your GitHub Pages site.

### If `/authorize` 404s

Every gated route shares one prefix, so a 404 means the first path segment didn't match `SECRET_PATH`. In the app log the request line says which:

```
GET /:secret/authorize -> 302     # matched; you're fine
GET /:bad-secret/authorize -> 404 # the segment you sent is not the deployed secret
```

Check, in order:

1. **The value.** `gcloud secrets versions access latest --secret=health-mcp-secret-path` — expect 64 hex characters, no `GOCSPX-` prefix, no `.apps.googleusercontent.com`.
2. **Whitespace.** The startup log prints `secret path segment: 64 chars`. If it reads 65, the secret version was created with `echo` (or pasted into the console textarea) and carries a trailing newline. The service trims it at startup, so a redeploy is enough; `printf '%s'` or `| tr -d '\n'` keeps it clean next time.
3. **The revision.** `gcloud run services describe health-mcp --region=$REGION --format='value(status.latestReadyRevisionName, status.traffic)'` — if traffic still points at an older revision, it's still serving the older secret.

No Google-side setting can cause this one: `/authorize` is answered entirely by the service, before Google is involved. A misconfigured redirect URI fails later, on the callback.

### If `/authorize` 500s

The secret matched — the route ran and threw. The only external call `/authorize` makes is the Firestore write that parks the PKCE verifier, so that is almost always what failed. Cloud Run's request log shows the 500 but never the reason; the service logs that itself:

```bash
gcloud run services logs read health-mcp --region=$REGION --limit=30   # look for "Unhandled error on GET /:secret/authorize"
```

`/<SECRET>/health` isolates it without reading logs: it answers `503 {"store":"unreachable"}` when Firestore is the problem and `200` when it isn't, while `/healthz` stays `200` either way since it touches no store. Common causes, by the error code in the log:

| Code | Meaning | Fix |
| --- | --- | --- |
| `5 NOT_FOUND` | no Firestore database in the project | `gcloud firestore databases create --location=$REGION --type=firestore-native` (deploy step 2) |
| `7 PERMISSION_DENIED` | runtime service account lacks the role | re-run the `roles/datastore.user` binding from deploy step 4, then redeploy |
| `9 FAILED_PRECONDITION` | database exists in Datastore mode | Native mode is required; create a Native database, or use a named one |

`gcloud firestore databases list` settles the first two in one look.

### If Google answers `Error 401: invalid_client`

The service did its job — it redirected, and Google rejected the `client_id` in that redirect. Only `client_id` and `redirect_uri` are validated at the consent screen, so the client secret is not involved yet (a bad one fails later, on the callback, and a stale redirect URI fails here as `400 redirect_uri_mismatch` instead). Read the value the service actually sent:

```bash
curl -sS -D - -o /dev/null "https://<service-url>/<SECRET>/authorize" | tr '&' '\n' | grep client_id
```

Expect `<project-number>-<hash>.apps.googleusercontent.com` and nothing else. What usually shows up instead:

- **`%0A` on the end** — `gh-client-id` carries a trailing newline, which gets percent-encoded into the consent URL. `gcloud secrets versions access latest --secret=gh-client-id | tail -c 1 | xxd` prints `0a` when that is the case. The service trims it at startup, so redeploy; add the clean version with `printf '%s'`.
- **`GOCSPX-…`** — `gh-client-id` holds the client *secret*. The two secrets are swapped; rewrite both versions.
- **A project ID wearing the suffix**, like `my-project.apps.googleusercontent.com` — the suffix was appended to a name instead of the whole ID being copied. Google replies `The OAuth client was not found.` A real ID begins with the project **number** and a dash (`123456789012-…`), so anything starting with letters is not one.

All three are caught at startup on the next deploy, which logs `GH_CLIENT_ID is not shaped like a client ID …` or `… holds a client secret …`. If the value does look right, confirm the client still exists under [Clients](https://console.cloud.google.com/auth/clients) — a deleted client is the remaining cause.

Secret env vars are re-read when a new instance starts, so while debugging prefer an explicit redeploy over waiting for scale-to-zero — a new revision is guaranteed to pick up the version you just added.

## Connect Claude

claude.ai → **Settings → Connectors → Add custom connector** → URL:

```
https://<service-url>/<SECRET>/mcp
```

Leave OAuth fields empty; the secret path is the auth. Enable it in a chat's tools menu, then try: *"Use health_connection_status, then give me a health_trend_report for the last 30 days."* Works on web, desktop, and mobile.

## Tools

`health_connection_status` · `health_list_data_types` · `health_get_profile` · `health_daily_summary` · **`health_trend_report`** · `health_daily_rollup` · `health_rollup` · `health_list_data_points` · `health_sleep_sessions` · `health_reconcile_data_points`

All read-only. `health_trend_report` is the one to reach for on trend questions — it fans out to every headline metric over a range, up to 47 upstream calls for a full year. Google caps each daily rollup request at 14 days for `total-calories` and `heart-rate` and at 90 days for most other types, so `health_trend_report` and `health_daily_rollup` split long ranges into chunks that fit and follow every page. Data types are kebab-case (`steps`, `sleep`, `heart-rate`, `daily-resting-heart-rate`); filters use snake_case members (`heart_rate.sample_time.physical_time`, `sleep.interval.civil_end_time`).

## Migrating off the Cloudflare Worker

1. Deploy and authorize here first, and confirm the connector answers.
2. In claude.ai, delete the old Worker connector (or repoint it to the new URL).
3. Optional: `npx wrangler delete` in `worker/`, and remove the Worker's redirect URI from the OAuth client.

Re-authorizing is the migration — refresh tokens aren't worth copying between stores, and a second consent costs one browser click. Both can coexist safely in the meantime; Google issues each its own token.

## Local development

```bash
npm install
npm run check                # typecheck
npm test                     # 37 tests: the real HTTP server end to end, plus the Google calls against a stubbed fetch
npm run build && GH_CLIENT_ID=x GH_CLIENT_SECRET=y SECRET_PATH=dev \
  HEALTH_MCP_STORE=memory npm start        # in-memory store, no Firestore needed
```

`HEALTH_MCP_STORE=memory` swaps Firestore for an in-process store — useful for protocol work, useless for real data (tokens vanish on restart).

## Operations

- **Logs:** `gcloud run services logs tail health-mcp --region=$REGION`. The service's own request lines record method, redacted path (`:secret` when the segment matched, `:bad-secret` when it didn't) and status — never the secret, tokens, or health values. Cloud Run's *platform* request log is separate and outside the service's control: it records the full `requestUrl`, secret segment included, under `run.googleapis.com/requests`. So anyone with Logs Viewer on the project can read the URL secret, and a secret you mistype into the URL bar is durably logged too — rotate it if that happens.
- **Rotate the URL secret:** `openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add health-mcp-secret-path --data-file=-`, redeploy, update the connector URL in claude.ai.
- **Revoke Google access:** [myaccount.google.com/permissions](https://myaccount.google.com/permissions) → Health MCP → Remove access, then delete the `health_mcp/google_tokens` document in Firestore.
- **Cost:** $0 within Cloud Run's free tier (2M requests, 180k vCPU-s, 360k GiB-s/month) with `min-instances=0`; Firestore's daily free quota is ~1,000× this workload. The one thing that accumulates is old container images in Artifact Registry — set a cleanup policy or occasionally prune with `gcloud artifacts docker images list`.
- **Cold start:** 1–3 s after idle. Firestore is constructed with `preferRest: true` to skip gRPC channel setup on that path.

## Caveats

The Google Health API is still evolving; if a data type starts erroring, check the [release notes](https://developers.google.com/health/release-notes). Not affiliated with Google, Fitbit, Alphabet, or Anthropic. Not medical advice.

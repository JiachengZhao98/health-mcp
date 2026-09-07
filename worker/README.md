# health-mcp worker

The cloud half of [Health MCP](../README.md): a single-user Google Health API v4 MCP server that runs on Cloudflare Workers (free plan), so Claude can read your health data from any device — phone included — with no computer awake anywhere.

- **MCP over Streamable HTTP** — stateless JSON, works as a claude.ai custom connector
- **OAuth done by the Worker** — one-time browser consent; tokens live in Workers KV; automatic refresh
- **Read-only** — 8 `googlehealth.*.readonly` scopes, nothing else
- **Structured-mode privacy filter** — identity and location keys are stripped from every response before the model sees it (key lists ported from `google-health-mcp-unofficial`, MIT — credit to its authors)

## Access model (read before deploying)

There is no login on the MCP endpoint. Instead, every route lives under a 256-bit secret path segment: `https://<worker>/<SECRET>/mcp`. Whoever has that full URL can read your health data, so treat it exactly like a password: it goes into claude.ai's connector settings and nowhere else. The OAuth callback (`/oauth/callback`) is the one fixed path, protected by a single-use `state` nonce instead, so the secret never has to be registered with Google. Rotate by setting a new `SECRET_PATH` secret and updating the connector URL.

## Deploy (≈10 minutes)

Prereqs: Node 20+, a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd worker
npm install
npx wrangler login                        # opens browser once

# 1. Storage for tokens
npx wrangler kv namespace create TOKENS   # paste the printed id into wrangler.jsonc

# 2. Secrets
npx wrangler secret put GH_CLIENT_ID      # from Google Cloud → Auth Platform → Clients
npx wrangler secret put GH_CLIENT_SECRET
openssl rand -hex 32                      # copy the output…
npx wrangler secret put SECRET_PATH       # …and paste it here

# 3. Ship it
npm run check                             # typecheck
npm run deploy                            # prints https://health-mcp.<your-subdomain>.workers.dev
```

## Wire up Google (once)

1. In [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients), open your OAuth client and add an authorized redirect URI:
   `https://health-mcp.<your-subdomain>.workers.dev/oauth/callback`
2. In [Branding → Authorized domains](https://console.cloud.google.com/auth/branding), add `workers.dev` if the console asks for it.
3. Visit `https://health-mcp.<your-subdomain>.workers.dev/<SECRET>/authorize` in any browser, pick your Google Health account, approve. You should land on "Connected ✓".

## Connect Claude

claude.ai → **Settings → Connectors → Add custom connector** → URL:

```
https://health-mcp.<your-subdomain>.workers.dev/<SECRET>/mcp
```

No OAuth on the connector itself (the secret path is the auth). Enable it in a chat's tools menu, then ask: *"Use health_connection_status, then give me a health_daily_summary for yesterday."* Works on web, desktop, and mobile.

## Tools

`health_connection_status` · `health_list_data_types` · `health_get_profile` · `health_daily_summary` · `health_daily_rollup` · `health_rollup` · `health_list_data_points` · `health_sleep_sessions` · `health_reconcile_data_points`

All read-only. Filters use snake_case members (`heart_rate.sample_time.physical_time`, `daily_resting_heart_rate.date`, `sleep.interval.civil_end_time`); data types are kebab-case (`steps`, `sleep`, `heart-rate`, `daily-resting-heart-rate`, …) — `health_list_data_types` enumerates them.

## Operations

- **Logs:** `npm run tail` (or the Cloudflare dashboard). Log bodies never include tokens.
- **Rotate the URL secret:** `npx wrangler secret put SECRET_PATH` with a fresh value → update the connector URL in claude.ai.
- **Revoke Google access:** [myaccount.google.com/permissions](https://myaccount.google.com/permissions) → Health MCP → Remove access; then delete the `tokens` key in KV (dashboard → KV) if you want the copy gone too.
- **Free-plan headroom:** 100k requests/day and daily KV quotas are ~3 orders of magnitude above one person's usage; token refresh writes ~1 KV write/hour of active use.

## Costs & caveats

$0 on the Workers free plan. The Google Health API is still evolving (beta-era); if a data type starts erroring, check the [release notes](https://developers.google.com/health/release-notes). Not affiliated with Google, Fitbit, Alphabet, or Anthropic. Not medical advice.

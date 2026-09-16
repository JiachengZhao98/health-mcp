# Health MCP

Project site and server for **Health MCP** — a personal, single-user setup that connects your Google Health data (synced from a Fitbit Air) to an AI assistant through the [Model Context Protocol](https://modelcontextprotocol.io), read-only, running either on your own machine or in your own Google Cloud project.

**Live site:** https://jiachengzhao98.github.io/health-mcp/

This repo holds two things: the public pages Google Cloud requires for an OAuth app in production — a homepage and a privacy policy — and [`cloudrun/`](cloudrun/), a self-contained MCP server you can deploy to a Google Cloud project you own.

## Contents

| File | Purpose |
| --- | --- |
| `index.html` | Project homepage: what Health MCP is, how the data flows, what it can read, quickstart |
| `privacy.html` | Privacy policy (linked on the Google OAuth consent screen) |
| `styles.css` | Shared stylesheet, light + dark themes, no build step |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |
| `cloudrun/` | The Cloud Run MCP server — TypeScript source, Dockerfile, 37 tests, and its own [deploy guide](cloudrun/README.md) |

The site has no framework and no build step — edit the HTML/CSS and push. `cloudrun/` is an ordinary TypeScript project with one runtime dependency.

## Two ways to run it

Both read the same [Google Health API](https://developers.google.com/health) (successor to the Fitbit Web API, retired September 2026) through your own OAuth client, with read-only scopes only. Pick whichever fits; they can coexist, and Google issues each its own token.

| | Local | Cloud Run |
| --- | --- | --- |
| Runs on | your computer | a Google Cloud project you own |
| Answers when | that computer is awake | always |
| Reachable from | the MCP client on that machine | claude.ai on any device, phone included |
| Tokens in | `~/.google-health-mcp/` | one Firestore document in your project |
| Cost | none | $0 within Cloud Run's free tier |

### Local

The open-source [`google-health-mcp-unofficial`](https://github.com/davidmosiah/google-health-mcp) server (MIT), authorized against your own Google Cloud OAuth client. Tokens live in `~/.google-health-mcp/`, readable only by your user account.

```bash
npx -y google-health-mcp-unofficial setup --client claude --scope-preset full
npx -y google-health-mcp-unofficial auth
npx -y google-health-mcp-unofficial doctor --live
```

### Cloud Run

[`cloudrun/`](cloudrun/) is a single-user MCP server over Streamable HTTP that works as a claude.ai custom connector, so a question asked from a phone gets an answer with no computer switched on. OAuth is handled by the service itself — one browser consent, tokens in Firestore, refreshed automatically — and every response passes a filter that strips identity and location keys before the model sees them. There is no login on the endpoint: every route sits under a 256-bit secret path segment, which is the credential.

```bash
cd cloudrun && gcloud run deploy health-mcp --source . --region us-central1 \
  --set-secrets=GH_CLIENT_ID=gh-client-id:latest,GH_CLIENT_SECRET=gh-client-secret:latest,SECRET_PATH=health-mcp-secret-path:latest
```

Full walkthrough, including Firestore setup, the ten tools, and troubleshooting for the 404 / 500 / `invalid_client` failures worth knowing about: [`cloudrun/README.md`](cloudrun/README.md).

It replaced a Cloudflare Worker, which could not host `health_trend_report` — every headline metric across up to 366 days in one call — inside the free plan's 10 ms CPU budget and 50-subrequest cap.

## Roadmap (maybe)

- Scheduled weekly summaries
- Longitudinal charts against training logs
- Groundedness checks on assistant answers
- If it ever serves anyone but me: Google app verification, then a real release

## Disclaimers

Personal project. Not affiliated with, endorsed by, or supported by Google, Fitbit, Alphabet, or Anthropic. Not a medical device; nothing here is medical advice.

## License

[MIT](LICENSE)

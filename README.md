# Health MCP

Project site for **Health MCP** — my personal, single-user setup that connects my Google Health data (synced from a Fitbit Air) to an AI assistant through the [Model Context Protocol](https://modelcontextprotocol.io), local-first and read-only.

**Live site:** `https://<username>.github.io/health-mcp/` (GitHub Pages, deployed from the `main` branch root).

This repo currently holds the public pages Google Cloud requires for an OAuth app in production — a homepage and a privacy policy — plus room to grow if the project ever becomes a real published app.

## Contents

| File | Purpose |
| --- | --- |
| `index.html` | Project homepage: what Health MCP is, how the data flows, what it can read, quickstart |
| `privacy.html` | Privacy policy (linked on the Google OAuth consent screen) |
| `styles.css` | Shared stylesheet, light + dark themes, no build step |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

No framework, no build step — edit the HTML/CSS and push.

## How the actual connector works

The running system is the open-source [`google-health-mcp-unofficial`](https://github.com/davidmosiah/google-health-mcp) server (MIT) pointed at the [Google Health API](https://developers.google.com/health) (successor to the Fitbit Web API, retired September 2026), authorized against my own Google Cloud OAuth client with read-only scopes. Tokens live in `~/.google-health-mcp/` on my machine.

```bash
npx -y google-health-mcp-unofficial setup --client claude --scope-preset full
npx -y google-health-mcp-unofficial auth
npx -y google-health-mcp-unofficial doctor --live
```

## Deploy

1. Push to `main`.
2. Repo **Settings → Pages** → Deploy from a branch → `main` / `/ (root)`.
3. In Google Cloud → **Google Auth Platform → Branding**: add `<username>.github.io` under Authorized domains, set the homepage and privacy-policy URLs to this site.

## Roadmap (maybe)

- Scheduled weekly summaries
- Longitudinal charts against training logs
- Groundedness checks on assistant answers
- If it ever serves anyone but me: Google app verification, then a real release

## Disclaimers

Personal project. Not affiliated with, endorsed by, or supported by Google, Fitbit, Alphabet, or Anthropic. Not a medical device; nothing here is medical advice.

## License

[MIT](LICENSE)

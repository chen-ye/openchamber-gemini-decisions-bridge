# Gemini Decisions Bridge extension for OpenChamber

Runs a local HTTP bridge on `127.0.0.1:4006` that connects OpenChamber, OpenCode, and `decision-ui` to Google's Gemini Decisions API (`gemini-decision-1`) using your Google OAuth credentials or a Gemini API key.

## Setup

### 1. Enable in OpenChamber

1. Open **Settings → Extensions** in OpenChamber.
2. Add or enable **Gemini Decisions Bridge** and allow its background service to run.

### 2. Configure authentication

Configure credentials via environment variables or `~/.config/openchamber/gemini-decisions-bridge.json` (config file values take precedence when set; override the file path with `BRIDGE_CONFIG_PATH`).

#### Option 1: Google OAuth (`~/.local/share/opencode/auth.json`)

By default the bridge looks for an existing Google OAuth token in `~/.local/share/opencode/auth.json` (plus `GOOGLE_TOKEN_PATH`, `OPENCODE_AUTH_PATH`, `~/.config/opencode/auth.json`, `~/.config/litellm/google-oauth-tokens.json`, or `GOOGLE_OAUTH_ACCESS_TOKEN`):

- `GOOGLE_PROJECT_ID` (config: `projectId`) — Optional GCP project ID sent in the `x-goog-user-project` header when using OAuth.
- `GOOGLE_CLIENT_ID` (config: `oauthClientId`) — OAuth 2.0 client ID required to auto-refresh expired access tokens.
- `GOOGLE_CLIENT_SECRET` (config: `oauthClientSecret`) — OAuth 2.0 client secret included in refresh requests when required by your OAuth client.
- `GOOGLE_TOKEN_PATH` (config: `oauthTokenPath`) — Optional custom path to your OAuth token JSON file.
- `GOOGLE_OAUTH_TOKEN_URL` — Optional token endpoint override (defaults to `https://oauth2.googleapis.com/token`).

#### Option 2: Gemini API key

- `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` (config: `apiKey`) — Sent as `x-goog-api-key` instead of OAuth Bearer tokens.

#### Optional bridge settings

- `BRIDGE_PORT` or `GEMINI_DECISIONS_PROXY_PORT` (config: `proxyPort`, default `4006`)
- `GEMINI_DECISIONS_MODEL` (config: `defaultModel`, default `gemini-decision-1`)
- `GEMINI_DECISIONS_UPSTREAM_URL` (config: `upstreamBaseUrl`, default `https://generativelanguage.googleapis.com/v1beta`)

Example `~/.config/openchamber/gemini-decisions-bridge.json` with OAuth:

```json
{
  "projectId": "your-gcp-project-id",
  "oauthClientId": "your-oauth-client-id.apps.googleusercontent.com",
  "oauthClientSecret": "your-oauth-client-secret"
}
```

Or with an API key:

```json
{
  "apiKey": "your-gemini-api-key"
}
```

### 3. Connect OpenChamber, OpenCode, or `decision-ui`

- **OpenChamber Classification**: In **Settings → Providers → Classification providers → Custom endpoint**, set URL to `http://127.0.0.1:4006/v1/systemone` and Model to `gemini-decision-1`.
- **OpenCode (`v2.2.7+`)**: Add a `gemini-decisions` provider to `~/.config/opencode/opencode.jsonc` with `baseURL: "http://127.0.0.1:4006/v1"`, `apiKey: "local"`, model `gemini-decision-1` (`type: "decision"`, `package: "@opencode/ai/providers/typesafe-ai/decisions"`), and allow `"gemini-decisions"` in policies. The **Connect** tab in the panel provides the exact JSON to copy.
- **`decision-ui` extension**: Connects to `http://127.0.0.1:4006` automatically by default.
- **Direct Google Decisions API**: Send `POST http://127.0.0.1:4006/v1beta/decisions` for direct passthrough with automatic OAuth or API key injection.

## Using Gemini Decisions Bridge in OpenChamber

### Gemini Decisions panel

- **Header**: Displays the auth status badge (`OAuth`, `API Key`, or `No Auth`), **Test** (runs a quick probe), and **Refresh**.
- **Playground tab**: Choose a preset scenario (**Multi-question triage**, **Agent model routing**, **Permission safety gate**) or edit the shared input context and `questions` JSON (`noul`, `choice`, `score`), then click **Evaluate** to view probability bars, winners, latency, and input token counts.
- **Status tab**: Inspect Local Proxy, Model, Requests, Avg Latency, Input Tokens, Project, Auth Source, and up to 20 **Recent Decisions** traces (or click **Run Probe**).
- **Connect tab**: Copy ready-to-use snippets (**Copy URL** / **Copy JSON**) for OpenChamber Classification, OpenCode, and the Google Decisions API.

### Work Status panel

The **Gemini Decisions** section in Work Status shows:

- **Bridge** (`:4006` and auth badge)
- **Model** (`gemini-decision-1`)
- **Decisions** (ok/error counts)
- **Latency** sparkline and average milliseconds (after 2+ requests)
- Auth source, latest decision summary or error, and a **Test** button

### Endpoints (`127.0.0.1:4006`)

- `POST /v1/systemone` and `POST /systemone` — SystemOne translator for OpenChamber and OpenCode.
- `POST /v1beta/decisions`, `POST /v1/decisions`, and `POST /decisions` — Native Google Gemini Decisions API passthrough with OAuth token refresh and header injection.
- `GET /v1/models`, `GET /models`, and `GET /v1beta/models/...` — Model metadata discovery.
- `GET /health`, `GET /config`, and `POST /config` — Bridge health check and configuration inspection or updates.

## Development

```bash
bun run build
bun run check
bun run typecheck
bun test
```

# Gemini Decisions Bridge

OpenChamber extension that exposes Google's Gemini Decisions API (`gemini-decision-1`) on a local loopback bridge (`127.0.0.1:4006`) using either your existing Google Gemini OAuth credentials (`~/.local/share/opencode/auth.json`) or a Gemini API key.

## Configuration

Configure authentication and optional GCP project routing via environment variables or `~/.config/openchamber/gemini-decisions-bridge.json` (config file values take precedence when set):

### Option 1: Google OAuth (`~/.local/share/opencode/auth.json`)

- `GOOGLE_PROJECT_ID` (config: `projectId`) — Optional GCP project ID sent via the `x-goog-user-project` header when using OAuth. Omitted if unset.
- `GOOGLE_CLIENT_ID` (config: `oauthClientId`) — OAuth 2.0 client ID required to automatically refresh expired access tokens.
- `GOOGLE_CLIENT_SECRET` (config: `oauthClientSecret`) — OAuth 2.0 client secret included in refresh requests when required by your OAuth client.
- `GOOGLE_TOKEN_PATH` (config: `oauthTokenPath`) — Optional custom path to your OAuth token JSON file.

### Option 2: Gemini API Key

- `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` (config: `apiKey`) — Sent as `x-goog-api-key` instead of OAuth Bearer tokens.

Example `~/.config/openchamber/gemini-decisions-bridge.json`:

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

## Endpoints (`127.0.0.1:4006`)

- `POST /v1/systemone` and `POST /systemone` — SystemOne / Jev wire translator for OpenChamber's Custom Classification Provider and OpenCode's `@opencode/ai/providers/typesafe-ai/decisions`.
- `POST /v1beta/decisions`, `POST /v1/decisions`, and `POST /decisions` — Native Google Gemini Decisions API passthrough with automatic OAuth token injection and refresh.
- `GET /v1beta/models/gemini-decision-1` and `GET /v1/models` — Model metadata discovery.
- `GET /health` and `GET /config` (`POST /config`) — Bridge health and configuration (`~/.config/openchamber/gemini-decisions-bridge.json`).

## Development

```bash
bun run build
bun run check
bun run typecheck
bun test
```

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_UPSTREAM_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-decision-1';
const DEFAULT_PROXY_PORT = 4006;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface BridgeConfig {
  readonly proxyPort: number;
  readonly upstreamBaseUrl: string;
  readonly defaultModel: string;
  readonly projectId?: string;
  readonly oauthClientId?: string;
  readonly oauthClientSecret?: string;
  readonly configFile: string;
  readonly oauthTokenPath?: string;
  readonly apiKey?: string;
}

export interface BridgeConfigFile {
  readonly proxyPort?: number;
  readonly upstreamBaseUrl?: string;
  readonly defaultModel?: string;
  readonly projectId?: string;
  readonly oauthClientId?: string;
  readonly oauthClientSecret?: string;
  readonly oauthTokenPath?: string;
  readonly apiKey?: string;
}

export interface AuthInspection {
  readonly configured: boolean;
  readonly mode: 'oauth' | 'api-key' | 'missing';
  readonly source: string;
  readonly projectId?: string;
  readonly expiresAt: number | null;
}

export interface ResolvedAuth {
  readonly headers: Readonly<Record<string, string>>;
  readonly mode: 'oauth' | 'api-key';
  readonly source: string;
  readonly expiresAt: number | null;
}

interface StoredOAuthRecord {
  readonly access: string;
  readonly refresh?: string;
  readonly expires?: number;
}

interface CachedTokenState {
  readonly sourcePath: string;
  readonly access: string;
  readonly refresh?: string;
  readonly expires: number;
}

let memoryTokenCache: CachedTokenState | null = null;
let refreshInFlight: Promise<CachedTokenState> | null = null;

/** Expands leading `~` or `~/` to the current user's home directory. */
export function expandHomePath(inputPath: string, homeDir: string = os.homedir()): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return path.join(homeDir, trimmed.slice(2));
  return trimmed;
}

/** Formats paths inside the user's home directory with a leading `~/` prefix. */
export function formatHomePath(targetPath: string, homeDir: string = os.homedir()): string {
  const normalizedHome = homeDir.replace(/\/+$/, '');
  if (targetPath === normalizedHome) return '~';
  if (targetPath.startsWith(`${normalizedHome}/`)) {
    return `~/${targetPath.slice(normalizedHome.length + 1)}`;
  }
  return targetPath;
}

export function resolveConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRIDGE_CONFIG_PATH) {
    return expandHomePath(env.BRIDGE_CONFIG_PATH);
  }
  return path.join(os.homedir(), '.config', 'openchamber', 'gemini-decisions-bridge.json');
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : undefined;
}

/** Loads bridge settings from disk and environment variables without exposing secrets. */
export function getBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const configFile = resolveConfigFilePath(env);
  let fileConfig: BridgeConfigFile = {};

  try {
    if (fs.existsSync(configFile)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileConfig = parsed as BridgeConfigFile;
      }
    }
  } catch (err) {
    console.warn('[gemini-decisions-bridge] Failed to parse config file:', err);
  }

  const proxyPort =
    (typeof fileConfig.proxyPort === 'number' && Number.isInteger(fileConfig.proxyPort)
      ? fileConfig.proxyPort
      : undefined) ??
    parsePort(env.BRIDGE_PORT) ??
    parsePort(env.GEMINI_DECISIONS_PROXY_PORT) ??
    DEFAULT_PROXY_PORT;

  const upstreamBaseUrl = (
    fileConfig.upstreamBaseUrl ||
    env.GEMINI_DECISIONS_UPSTREAM_URL ||
    DEFAULT_UPSTREAM_BASE_URL
  ).replace(/\/+$/, '');

  const defaultModel = fileConfig.defaultModel || env.GEMINI_DECISIONS_MODEL || DEFAULT_MODEL;
  const projectId = fileConfig.projectId || env.GOOGLE_PROJECT_ID || undefined;
  const oauthClientId = fileConfig.oauthClientId || env.GOOGLE_CLIENT_ID || undefined;
  const oauthClientSecret = fileConfig.oauthClientSecret || env.GOOGLE_CLIENT_SECRET || undefined;
  const oauthTokenPath = fileConfig.oauthTokenPath
    ? expandHomePath(fileConfig.oauthTokenPath)
    : env.GOOGLE_TOKEN_PATH
      ? expandHomePath(env.GOOGLE_TOKEN_PATH)
      : undefined;
  const apiKey = fileConfig.apiKey || env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || undefined;

  return {
    proxyPort,
    upstreamBaseUrl,
    defaultModel,
    ...(projectId ? { projectId } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
    ...(oauthClientSecret ? { oauthClientSecret } : {}),
    configFile,
    ...(oauthTokenPath ? { oauthTokenPath } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Merges and persists non-empty configuration updates to the user's config file. */
export function updateBridgeConfigFile(
  updates: BridgeConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const configFile = resolveConfigFilePath(env);
  let existing: Record<string, unknown> = {};

  try {
    if (fs.existsSync(configFile)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = { ...(parsed as Record<string, unknown>) };
      }
    }
  } catch {
    existing = {};
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null || value === '') {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const tmpFile = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpFile, configFile);

  return getBridgeConfig(env);
}

function candidateOAuthPaths(config: BridgeConfig, env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir();
  const xdgData = env.XDG_DATA_HOME ? expandHomePath(env.XDG_DATA_HOME, home) : path.join(home, '.local', 'share');
  const xdgConfig = env.XDG_CONFIG_HOME ? expandHomePath(env.XDG_CONFIG_HOME, home) : path.join(home, '.config');

  const rawCandidates = [
    config.oauthTokenPath,
    env.OPENCODE_AUTH_PATH ? expandHomePath(env.OPENCODE_AUTH_PATH, home) : undefined,
    path.join(xdgData, 'opencode', 'auth.json'),
    path.join(xdgConfig, 'opencode', 'auth.json'),
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    path.join(home, '.config', 'opencode', 'auth.json'),
    path.join(home, '.config', 'litellm', 'google-oauth-tokens.json'),
  ].filter((entry): entry is string => Boolean(entry));

  return Array.from(new Set(rawCandidates));
}

function extractOAuthRecord(parsed: unknown): {
  record: StoredOAuthRecord;
  nestedKey: 'google' | 'google-oauth' | null;
} | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  for (const key of ['google', 'google-oauth'] as const) {
    const candidate = obj[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const rec = candidate as Record<string, unknown>;
      if (typeof rec.access === 'string' && rec.access.length > 0 && (rec.type === 'oauth' || rec.type === undefined)) {
        return {
          nestedKey: key,
          record: {
            access: rec.access,
            ...(typeof rec.refresh === 'string' && rec.refresh.length > 0 ? { refresh: rec.refresh } : {}),
            ...(typeof rec.expires === 'number' ? { expires: rec.expires } : {}),
          },
        };
      }
    }
  }

  if (typeof obj.access === 'string' && obj.access.length > 0) {
    return {
      nestedKey: null,
      record: {
        access: obj.access,
        ...(typeof obj.refresh === 'string' && obj.refresh.length > 0 ? { refresh: obj.refresh } : {}),
        ...(typeof obj.expires === 'number' ? { expires: obj.expires } : {}),
      },
    };
  }

  return null;
}

function persistRefreshedToken(
  authPath: string,
  nestedKey: 'google' | 'google-oauth' | null,
  updated: CachedTokenState,
): void {
  try {
    if (!fs.existsSync(authPath)) return;
    const raw = fs.readFileSync(authPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const root = { ...(parsed as Record<string, unknown>) };
    if (nestedKey) {
      const existingProvider =
        root[nestedKey] && typeof root[nestedKey] === 'object' && !Array.isArray(root[nestedKey])
          ? (root[nestedKey] as Record<string, unknown>)
          : { type: 'oauth' };
      root[nestedKey] = {
        ...existingProvider,
        type: 'oauth',
        access: updated.access,
        ...(updated.refresh ? { refresh: updated.refresh } : {}),
        expires: updated.expires,
      };
    } else {
      root.access = updated.access;
      if (updated.refresh) root.refresh = updated.refresh;
      root.expires = updated.expires;
    }

    const tmpFile = `${authPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(root, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpFile, authPath);
  } catch (err) {
    console.warn('[gemini-decisions-bridge] Could not persist refreshed OAuth token to disk; keeping in memory:', err);
  }
}

async function refreshGoogleOAuthToken(
  refreshToken: string,
  sourcePath: string,
  nestedKey: 'google' | 'google-oauth' | null,
  config: BridgeConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<CachedTokenState> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const tokenUrl = env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const clientId = config.oauthClientId || env.GOOGLE_CLIENT_ID;
  const clientSecret = config.oauthClientSecret || env.GOOGLE_CLIENT_SECRET;

  if (!clientId) {
    throw new Error(
      'Cannot refresh Google OAuth token: GOOGLE_CLIENT_ID (or oauthClientId in config) is not configured. Set GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET if applicable) or configure an API key (GEMINI_API_KEY / apiKey).',
    );
  }

  const task = (async (): Promise<CachedTokenState> => {
    const bodyParams: Record<string, string> = {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    if (clientSecret) {
      bodyParams.client_secret = clientSecret;
    }
    const body = new URLSearchParams(bodyParams);

    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Google OAuth token refresh failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      throw new Error('Google OAuth token refresh response did not contain access_token');
    }

    const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    const nextState: CachedTokenState = {
      sourcePath,
      access: data.access_token,
      refresh: typeof data.refresh_token === 'string' && data.refresh_token.length > 0 ? data.refresh_token : refreshToken,
      expires: Date.now() + expiresInSec * 1000,
    };

    memoryTokenCache = nextState;
    persistRefreshedToken(sourcePath, nestedKey, nextState);
    return nextState;
  })();

  refreshInFlight = task;
  try {
    return await task;
  } finally {
    refreshInFlight = null;
  }
}

/** Resets in-memory OAuth token cache for isolated tests. */
export function clearAuthCacheForTests(): void {
  memoryTokenCache = null;
  refreshInFlight = null;
}

/** Inspects credential readiness without exposing secrets or mutating tokens. */
export function inspectAuthStatus(
  config: BridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): AuthInspection {
  if (config.apiKey) {
    return {
      configured: true,
      mode: 'api-key',
      source: env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY ? 'environment' : formatHomePath(config.configFile),
      ...(config.projectId ? { projectId: config.projectId } : {}),
      expiresAt: null,
    };
  }

  for (const authPath of candidateOAuthPaths(config, env)) {
    try {
      if (!fs.existsSync(authPath)) continue;
      const extracted = extractOAuthRecord(JSON.parse(fs.readFileSync(authPath, 'utf-8')));
      if (extracted) {
        const cached = memoryTokenCache?.sourcePath === authPath ? memoryTokenCache : null;
        return {
          configured: true,
          mode: 'oauth',
          source: formatHomePath(authPath),
          ...(config.projectId ? { projectId: config.projectId } : {}),
          expiresAt: cached?.expires ?? extracted.record.expires ?? null,
        };
      }
    } catch {
      // Check next candidate
    }
  }

  if (env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return {
      configured: true,
      mode: 'oauth',
      source: 'GOOGLE_OAUTH_ACCESS_TOKEN',
      ...(config.projectId ? { projectId: config.projectId } : {}),
      expiresAt: null,
    };
  }

  return {
    configured: false,
    mode: 'missing',
    source: formatHomePath(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')),
    ...(config.projectId ? { projectId: config.projectId } : {}),
    expiresAt: null,
  };
}

/** Resolves upstream authentication headers, refreshing expired OAuth tokens when needed. */
export async function resolveUpstreamAuthHeaders(
  config: BridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedAuth> {
  if (config.apiKey) {
    return {
      headers: { 'x-goog-api-key': config.apiKey },
      mode: 'api-key',
      source: env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY ? 'environment' : formatHomePath(config.configFile),
      expiresAt: null,
    };
  }

  for (const authPath of candidateOAuthPaths(config, env)) {
    let extracted: ReturnType<typeof extractOAuthRecord> = null;
    try {
      if (!fs.existsSync(authPath)) continue;
      extracted = extractOAuthRecord(JSON.parse(fs.readFileSync(authPath, 'utf-8')));
    } catch {
      continue;
    }
    if (!extracted) continue;

    const cached =
      memoryTokenCache &&
      memoryTokenCache.sourcePath === authPath &&
      memoryTokenCache.expires > (extracted.record.expires ?? 0)
        ? memoryTokenCache
        : null;

    const currentAccess = cached?.access ?? extracted.record.access;
    const currentRefresh = cached?.refresh ?? extracted.record.refresh;
    const currentExpires = cached?.expires ?? extracted.record.expires;

    if (currentRefresh && currentExpires !== undefined && Date.now() >= currentExpires - REFRESH_BUFFER_MS) {
      const refreshed = await refreshGoogleOAuthToken(
        currentRefresh,
        authPath,
        extracted.nestedKey,
        config,
        env,
        fetchImpl,
      );
      return {
        headers: {
          Authorization: `Bearer ${refreshed.access}`,
          ...(config.projectId ? { 'x-goog-user-project': config.projectId } : {}),
        },
        mode: 'oauth',
        source: formatHomePath(authPath),
        expiresAt: refreshed.expires,
      };
    }

    return {
      headers: {
        Authorization: `Bearer ${currentAccess}`,
        ...(config.projectId ? { 'x-goog-user-project': config.projectId } : {}),
      },
      mode: 'oauth',
      source: formatHomePath(authPath),
      expiresAt: currentExpires ?? null,
    };
  }

  if (env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return {
      headers: {
        Authorization: `Bearer ${env.GOOGLE_OAUTH_ACCESS_TOKEN}`,
        ...(config.projectId ? { 'x-goog-user-project': config.projectId } : {}),
      },
      mode: 'oauth',
      source: 'GOOGLE_OAUTH_ACCESS_TOKEN',
      expiresAt: null,
    };
  }

  throw new Error(
    'No Google OAuth credentials found in ~/.local/share/opencode/auth.json (run OpenCode Google OAuth login or set apiKey in ~/.config/openchamber/gemini-decisions-bridge.json).',
  );
}

// service/server.ts
import http from "node:http";
import { URL } from "node:url";

// service/auth.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var DEFAULT_UPSTREAM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
var DEFAULT_MODEL = "gemini-decision-1";
var DEFAULT_PROXY_PORT = 4006;
var REFRESH_BUFFER_MS = 5 * 60 * 1000;
var memoryTokenCache = null;
var refreshInFlight = null;
function expandHomePath(inputPath, homeDir = os.homedir()) {
  const trimmed = inputPath.trim();
  if (trimmed === "~")
    return homeDir;
  if (trimmed.startsWith("~/"))
    return path.join(homeDir, trimmed.slice(2));
  return trimmed;
}
function formatHomePath(targetPath, homeDir = os.homedir()) {
  const normalizedHome = homeDir.replace(/\/+$/, "");
  if (targetPath === normalizedHome)
    return "~";
  if (targetPath.startsWith(`${normalizedHome}/`)) {
    return `~/${targetPath.slice(normalizedHome.length + 1)}`;
  }
  return targetPath;
}
function resolveConfigFilePath(env = process.env) {
  if (env.BRIDGE_CONFIG_PATH) {
    return expandHomePath(env.BRIDGE_CONFIG_PATH);
  }
  return path.join(os.homedir(), ".config", "openchamber", "gemini-decisions-bridge.json");
}
function parsePort(raw) {
  if (!raw)
    return;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : undefined;
}
function getBridgeConfig(env = process.env) {
  const configFile = resolveConfigFilePath(env);
  let fileConfig = {};
  try {
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fileConfig = parsed;
      }
    }
  } catch (err) {
    console.warn("[gemini-decisions-bridge] Failed to parse config file:", err);
  }
  const proxyPort = (typeof fileConfig.proxyPort === "number" && Number.isInteger(fileConfig.proxyPort) ? fileConfig.proxyPort : undefined) ?? parsePort(env.BRIDGE_PORT) ?? parsePort(env.GEMINI_DECISIONS_PROXY_PORT) ?? DEFAULT_PROXY_PORT;
  const upstreamBaseUrl = (fileConfig.upstreamBaseUrl || env.GEMINI_DECISIONS_UPSTREAM_URL || DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, "");
  const defaultModel = fileConfig.defaultModel || env.GEMINI_DECISIONS_MODEL || DEFAULT_MODEL;
  const projectId = fileConfig.projectId || env.GOOGLE_PROJECT_ID || undefined;
  const oauthClientId = fileConfig.oauthClientId || env.GOOGLE_CLIENT_ID || undefined;
  const oauthClientSecret = fileConfig.oauthClientSecret || env.GOOGLE_CLIENT_SECRET || undefined;
  const oauthTokenPath = fileConfig.oauthTokenPath ? expandHomePath(fileConfig.oauthTokenPath) : env.GOOGLE_TOKEN_PATH ? expandHomePath(env.GOOGLE_TOKEN_PATH) : undefined;
  const apiKey = fileConfig.apiKey || env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || undefined;
  return {
    proxyPort,
    upstreamBaseUrl,
    defaultModel,
    ...projectId ? { projectId } : {},
    ...oauthClientId ? { oauthClientId } : {},
    ...oauthClientSecret ? { oauthClientSecret } : {},
    configFile,
    ...oauthTokenPath ? { oauthTokenPath } : {},
    ...apiKey ? { apiKey } : {}
  };
}
function updateBridgeConfigFile(updates, env = process.env) {
  const configFile = resolveConfigFilePath(env);
  let existing = {};
  try {
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = { ...parsed };
      }
    }
  } catch {
    existing = {};
  }
  const merged = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined)
      continue;
    if (value === null || value === "") {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const tmpFile = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(merged, null, 2)}
`, { encoding: "utf-8", mode: 384 });
  fs.renameSync(tmpFile, configFile);
  return getBridgeConfig(env);
}
function candidateOAuthPaths(config, env) {
  const home = os.homedir();
  const xdgData = env.XDG_DATA_HOME ? expandHomePath(env.XDG_DATA_HOME, home) : path.join(home, ".local", "share");
  const xdgConfig = env.XDG_CONFIG_HOME ? expandHomePath(env.XDG_CONFIG_HOME, home) : path.join(home, ".config");
  const rawCandidates = [
    config.oauthTokenPath,
    env.OPENCODE_AUTH_PATH ? expandHomePath(env.OPENCODE_AUTH_PATH, home) : undefined,
    path.join(xdgData, "opencode", "auth.json"),
    path.join(xdgConfig, "opencode", "auth.json"),
    path.join(home, ".local", "share", "opencode", "auth.json"),
    path.join(home, ".config", "opencode", "auth.json"),
    path.join(home, ".config", "litellm", "google-oauth-tokens.json")
  ].filter((entry) => Boolean(entry));
  return Array.from(new Set(rawCandidates));
}
function extractOAuthRecord(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const obj = parsed;
  for (const key of ["google", "google-oauth"]) {
    const candidate = obj[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const rec = candidate;
      if (typeof rec.access === "string" && rec.access.length > 0 && (rec.type === "oauth" || rec.type === undefined)) {
        return {
          nestedKey: key,
          record: {
            access: rec.access,
            ...typeof rec.refresh === "string" && rec.refresh.length > 0 ? { refresh: rec.refresh } : {},
            ...typeof rec.expires === "number" ? { expires: rec.expires } : {}
          }
        };
      }
    }
  }
  if (typeof obj.access === "string" && obj.access.length > 0) {
    return {
      nestedKey: null,
      record: {
        access: obj.access,
        ...typeof obj.refresh === "string" && obj.refresh.length > 0 ? { refresh: obj.refresh } : {},
        ...typeof obj.expires === "number" ? { expires: obj.expires } : {}
      }
    };
  }
  return null;
}
function persistRefreshedToken(authPath, nestedKey, updated) {
  try {
    if (!fs.existsSync(authPath))
      return;
    const raw = fs.readFileSync(authPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return;
    const root = { ...parsed };
    if (nestedKey) {
      const existingProvider = root[nestedKey] && typeof root[nestedKey] === "object" && !Array.isArray(root[nestedKey]) ? root[nestedKey] : { type: "oauth" };
      root[nestedKey] = {
        ...existingProvider,
        type: "oauth",
        access: updated.access,
        ...updated.refresh ? { refresh: updated.refresh } : {},
        expires: updated.expires
      };
    } else {
      root.access = updated.access;
      if (updated.refresh)
        root.refresh = updated.refresh;
      root.expires = updated.expires;
    }
    const tmpFile = `${authPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(root, null, 2)}
`, { encoding: "utf-8", mode: 384 });
    fs.renameSync(tmpFile, authPath);
  } catch (err) {
    console.warn("[gemini-decisions-bridge] Could not persist refreshed OAuth token to disk; keeping in memory:", err);
  }
}
async function refreshGoogleOAuthToken(refreshToken, sourcePath, nestedKey, config, env, fetchImpl) {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  const tokenUrl = env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token";
  const clientId = config.oauthClientId || env.GOOGLE_CLIENT_ID;
  const clientSecret = config.oauthClientSecret || env.GOOGLE_CLIENT_SECRET;
  if (!clientId) {
    throw new Error("Cannot refresh Google OAuth token: GOOGLE_CLIENT_ID (or oauthClientId in config) is not configured. Set GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET if applicable) or configure an API key (GEMINI_API_KEY / apiKey).");
  }
  const task = (async () => {
    const bodyParams = {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    };
    if (clientSecret) {
      bodyParams.client_secret = clientSecret;
    }
    const body = new URLSearchParams(bodyParams);
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Google OAuth token refresh failed (${response.status}): ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
      throw new Error("Google OAuth token refresh response did not contain access_token");
    }
    const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
    const nextState = {
      sourcePath,
      access: data.access_token,
      refresh: typeof data.refresh_token === "string" && data.refresh_token.length > 0 ? data.refresh_token : refreshToken,
      expires: Date.now() + expiresInSec * 1000
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
function inspectAuthStatus(config, env = process.env) {
  if (config.apiKey) {
    return {
      configured: true,
      mode: "api-key",
      source: env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY ? "environment" : formatHomePath(config.configFile),
      ...config.projectId ? { projectId: config.projectId } : {},
      expiresAt: null
    };
  }
  for (const authPath of candidateOAuthPaths(config, env)) {
    try {
      if (!fs.existsSync(authPath))
        continue;
      const extracted = extractOAuthRecord(JSON.parse(fs.readFileSync(authPath, "utf-8")));
      if (extracted) {
        const cached = memoryTokenCache?.sourcePath === authPath ? memoryTokenCache : null;
        return {
          configured: true,
          mode: "oauth",
          source: formatHomePath(authPath),
          ...config.projectId ? { projectId: config.projectId } : {},
          expiresAt: cached?.expires ?? extracted.record.expires ?? null
        };
      }
    } catch {}
  }
  if (env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return {
      configured: true,
      mode: "oauth",
      source: "GOOGLE_OAUTH_ACCESS_TOKEN",
      ...config.projectId ? { projectId: config.projectId } : {},
      expiresAt: null
    };
  }
  return {
    configured: false,
    mode: "missing",
    source: formatHomePath(path.join(os.homedir(), ".local", "share", "opencode", "auth.json")),
    ...config.projectId ? { projectId: config.projectId } : {},
    expiresAt: null
  };
}
async function resolveUpstreamAuthHeaders(config, env = process.env, fetchImpl = fetch) {
  if (config.apiKey) {
    return {
      headers: { "x-goog-api-key": config.apiKey },
      mode: "api-key",
      source: env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY ? "environment" : formatHomePath(config.configFile),
      expiresAt: null
    };
  }
  for (const authPath of candidateOAuthPaths(config, env)) {
    let extracted = null;
    try {
      if (!fs.existsSync(authPath))
        continue;
      extracted = extractOAuthRecord(JSON.parse(fs.readFileSync(authPath, "utf-8")));
    } catch {
      continue;
    }
    if (!extracted)
      continue;
    const cached = memoryTokenCache && memoryTokenCache.sourcePath === authPath && memoryTokenCache.expires > (extracted.record.expires ?? 0) ? memoryTokenCache : null;
    const currentAccess = cached?.access ?? extracted.record.access;
    const currentRefresh = cached?.refresh ?? extracted.record.refresh;
    const currentExpires = cached?.expires ?? extracted.record.expires;
    if (currentRefresh && currentExpires !== undefined && Date.now() >= currentExpires - REFRESH_BUFFER_MS) {
      const refreshed = await refreshGoogleOAuthToken(currentRefresh, authPath, extracted.nestedKey, config, env, fetchImpl);
      return {
        headers: {
          Authorization: `Bearer ${refreshed.access}`,
          ...config.projectId ? { "x-goog-user-project": config.projectId } : {}
        },
        mode: "oauth",
        source: formatHomePath(authPath),
        expiresAt: refreshed.expires
      };
    }
    return {
      headers: {
        Authorization: `Bearer ${currentAccess}`,
        ...config.projectId ? { "x-goog-user-project": config.projectId } : {}
      },
      mode: "oauth",
      source: formatHomePath(authPath),
      expiresAt: currentExpires ?? null
    };
  }
  if (env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return {
      headers: {
        Authorization: `Bearer ${env.GOOGLE_OAUTH_ACCESS_TOKEN}`,
        ...config.projectId ? { "x-goog-user-project": config.projectId } : {}
      },
      mode: "oauth",
      source: "GOOGLE_OAUTH_ACCESS_TOKEN",
      expiresAt: null
    };
  }
  throw new Error("No Google OAuth credentials found in ~/.local/share/opencode/auth.json (run OpenCode Google OAuth login or set apiKey in ~/.config/openchamber/gemini-decisions-bridge.json).");
}

// service/protocol.ts
import crypto from "node:crypto";
var INPUT_COST_PER_MILLION_USD = 0.1;

class ProtocolValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}
function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function clampProbability(value) {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, num));
}
function resolveUpstreamModel(requested, defaultModel) {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    return defaultModel;
  }
  const stripped = requested.trim().replace(/^google\//i, "").replace(/^models\//i, "");
  if (stripped.startsWith("gemini-decision")) {
    return stripped;
  }
  return defaultModel;
}
function mediaBlockKindFromMime(mimeType) {
  const normalized = mimeType.toLowerCase();
  if (normalized === "application/pdf")
    return "document";
  if (normalized.startsWith("image/"))
    return "image";
  if (normalized.startsWith("audio/"))
    return "audio";
  if (normalized.startsWith("video/"))
    return "video";
  throw new ProtocolValidationError(`Unsupported media MIME type for Gemini Decisions API: ${mimeType}`);
}
function parseDataUrlBlock(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match || !match[1] || !match[2]) {
    throw new ProtocolValidationError("Expected base64 data URL (data:<mime>;base64,...) for inline media.");
  }
  const mimeType = match[1].toLowerCase();
  return {
    type: mediaBlockKindFromMime(mimeType),
    mime_type: mimeType,
    data: match[2]
  };
}
function guessMimeFromUrl(url, fallback) {
  const pathname = url.split("?")[0]?.toLowerCase() ?? "";
  if (pathname.endsWith(".png"))
    return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg"))
    return "image/jpeg";
  if (pathname.endsWith(".webp"))
    return "image/webp";
  if (pathname.endsWith(".gif"))
    return "image/gif";
  if (pathname.endsWith(".pdf"))
    return "application/pdf";
  if (pathname.endsWith(".mp3"))
    return "audio/mp3";
  if (pathname.endsWith(".wav"))
    return "audio/wav";
  if (pathname.endsWith(".ogg"))
    return "audio/ogg";
  if (pathname.endsWith(".mp4"))
    return "video/mp4";
  if (pathname.endsWith(".webm"))
    return "video/webm";
  if (pathname.endsWith(".mov"))
    return "video/mov";
  return fallback;
}
function normalizeImageFormatMime(format) {
  const clean = format.trim().toLowerCase().replace(/^image\//, "");
  if (clean === "jpg")
    return "image/jpeg";
  return `image/${clean || "png"}`;
}
function normalizeAudioFormatMime(format) {
  const clean = format.trim().toLowerCase();
  if (clean.includes("/"))
    return clean;
  return `audio/${clean || "wav"}`;
}
function assetRefToBlock(asset) {
  if (!isPlainRecord(asset)) {
    throw new ProtocolValidationError("Invalid SystemOne asset entry.");
  }
  if (typeof asset.data_base64 === "string") {
    const mimeType = normalizeImageFormatMime(typeof asset.format === "string" ? asset.format : "png");
    return {
      type: mediaBlockKindFromMime(mimeType),
      mime_type: mimeType,
      data: asset.data_base64
    };
  }
  throw new ProtocolValidationError("SystemOne asset entry is missing data_base64.");
}
function stateItemToBlock(item, assets) {
  if (typeof item === "string") {
    if (assets && Object.hasOwn(assets, item)) {
      return assetRefToBlock(assets[item]);
    }
    return { type: "text", text: item };
  }
  if (isPlainRecord(item)) {
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    if ((item.type === "image" || item.type === "audio" || item.type === "video" || item.type === "document") && typeof item.mime_type === "string" && (typeof item.data === "string" || typeof item.uri === "string")) {
      const resolution = item.resolution;
      return {
        type: item.type,
        mime_type: item.mime_type.toLowerCase(),
        ...typeof item.data === "string" ? { data: item.data } : {},
        ...typeof item.uri === "string" ? { uri: item.uri } : {},
        ...resolution === "low" || resolution === "medium" || resolution === "high" || resolution === "ultra_high" ? { resolution } : {}
      };
    }
    if (item.type === "image_url" && isPlainRecord(item.image_url) && typeof item.image_url.url === "string") {
      const url = item.image_url.url;
      if (url.startsWith("data:"))
        return parseDataUrlBlock(url);
      return { type: "image", mime_type: guessMimeFromUrl(url, "image/jpeg"), uri: url };
    }
    if (item.type === "video_url" && isPlainRecord(item.video_url) && typeof item.video_url.url === "string") {
      const url = item.video_url.url;
      if (url.startsWith("data:"))
        return parseDataUrlBlock(url);
      return { type: "video", mime_type: guessMimeFromUrl(url, "video/mp4"), uri: url };
    }
    if (item.type === "input_audio" && isPlainRecord(item.input_audio) && typeof item.input_audio.data === "string") {
      const format = typeof item.input_audio.format === "string" ? item.input_audio.format : "wav";
      return {
        type: "audio",
        mime_type: normalizeAudioFormatMime(format),
        data: item.input_audio.data
      };
    }
    return { type: "text", text: JSON.stringify(item) };
  }
  return { type: "text", text: JSON.stringify(item ?? null) };
}
function separateAdjacentTextBlocks(blocks) {
  return blocks.map((block, index) => {
    const prev = index > 0 ? blocks[index - 1] : undefined;
    if (block.type === "text" && prev?.type === "text" && !block.text.startsWith(`
`)) {
      return { type: "text", text: `
${block.text}` };
    }
    return block;
  });
}
function extractStateBlocks(body) {
  const assets = isPlainRecord(body.assets) ? body.assets : undefined;
  const blocks = [];
  if (body.state !== undefined) {
    const state = body.state;
    if (typeof state === "string") {
      blocks.push(stateItemToBlock(state, assets));
    } else if (Array.isArray(state)) {
      for (const item of state) {
        blocks.push(stateItemToBlock(item, assets));
      }
    } else if (isPlainRecord(state) && Array.isArray(state.messages)) {
      for (const msg of state.messages) {
        if (isPlainRecord(msg) && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            blocks.push(stateItemToBlock(part, assets));
          }
        } else if (isPlainRecord(msg) && typeof msg.content === "string") {
          blocks.push({ type: "text", text: msg.content });
        } else {
          blocks.push({ type: "text", text: JSON.stringify(msg) });
        }
      }
    } else {
      blocks.push({ type: "text", text: JSON.stringify(state) });
    }
  } else if (body.input !== undefined) {
    const input = body.input;
    if (typeof input === "string") {
      blocks.push({ type: "text", text: input });
    } else if (Array.isArray(input)) {
      for (const item of input) {
        blocks.push(stateItemToBlock(item, assets));
      }
    } else {
      blocks.push(stateItemToBlock(input, assets));
    }
  } else {
    throw new ProtocolValidationError("Decision request requires either `state` or `input`.");
  }
  for (const rootField of ["images", "audio", "videos"]) {
    const mediaList = body[rootField];
    if (Array.isArray(mediaList)) {
      for (const entry of mediaList) {
        if (typeof entry === "string") {
          if (entry.startsWith("data:")) {
            blocks.push(parseDataUrlBlock(entry));
          } else {
            const fallbackMime = rootField === "images" ? "image/jpeg" : rootField === "audio" ? "audio/wav" : "video/mp4";
            const mimeType = guessMimeFromUrl(entry, fallbackMime);
            blocks.push({
              type: mediaBlockKindFromMime(mimeType),
              mime_type: mimeType,
              uri: entry
            });
          }
        }
      }
    }
  }
  const normalized = separateAdjacentTextBlocks(blocks);
  if (normalized.length === 0) {
    throw new ProtocolValidationError("Decision input cannot be empty.");
  }
  if (normalized.length === 1 && normalized[0]?.type === "text" && normalized[0].text.length === 0) {
    return [{ type: "text", text: " " }];
  }
  return normalized;
}
function normalizeInstructions(raw, questionKey) {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const parts = raw.map((entry) => {
      if (typeof entry === "string")
        return entry;
      if (isPlainRecord(entry) && typeof entry.text === "string")
        return entry.text;
      return "";
    }).filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts.join(`

`);
    }
  }
  throw new ProtocolValidationError(`Question "${questionKey}" is missing non-empty text instructions.`);
}
function translateQuestion(questionKey, raw) {
  if (!isPlainRecord(raw)) {
    throw new ProtocolValidationError(`Question "${questionKey}" must be an object.`);
  }
  const instructions = normalizeInstructions(raw.instructions, questionKey);
  const type = raw.type;
  if (type === "noul" || type === "predicate") {
    const rawCriteria = isPlainRecord(raw.criteria) ? raw.criteria : undefined;
    const trueDesc = typeof rawCriteria?.true_description === "string" ? rawCriteria.true_description : typeof rawCriteria?.true === "string" ? rawCriteria.true : undefined;
    const falseDesc = typeof rawCriteria?.false_description === "string" ? rawCriteria.false_description : typeof rawCriteria?.false === "string" ? rawCriteria.false : undefined;
    const criteria = trueDesc !== undefined || falseDesc !== undefined ? {
      ...trueDesc !== undefined ? { true_description: trueDesc } : {},
      ...falseDesc !== undefined ? { false_description: falseDesc } : {}
    } : undefined;
    return {
      type: "noul",
      instructions,
      ...criteria ? { criteria } : {}
    };
  }
  if (type === "choice") {
    if (!isPlainRecord(raw.criteria)) {
      throw new ProtocolValidationError(`Choice question "${questionKey}" requires a criteria object.`);
    }
    const entries = Object.entries(raw.criteria);
    if (entries.length < 2) {
      throw new ProtocolValidationError(`Choice question "${questionKey}" requires at least 2 options.`);
    }
    const criteria = {};
    for (const [optKey, desc] of entries) {
      criteria[optKey] = typeof desc === "string" ? desc : desc === null || desc === undefined ? "" : String(desc);
    }
    return {
      type: "choice",
      instructions,
      criteria
    };
  }
  if (type === "score") {
    if (!Array.isArray(raw.criteria) || raw.criteria.length < 2) {
      throw new ProtocolValidationError(`Score question "${questionKey}" requires a criteria array with >= 2 levels.`);
    }
    return {
      type: "score",
      instructions,
      criteria: raw.criteria.map((level) => String(level))
    };
  }
  throw new ProtocolValidationError(`Unsupported question type "${String(type)}" on "${questionKey}".`);
}
function translateSystemOneToGoogle(rawBody, defaultModel = "gemini-decision-1") {
  if (!isPlainRecord(rawBody)) {
    throw new ProtocolValidationError("Request body must be a JSON object.");
  }
  if (!isPlainRecord(rawBody.questions) || Object.keys(rawBody.questions).length === 0) {
    throw new ProtocolValidationError("Request body requires a non-empty `questions` map.");
  }
  const model = resolveUpstreamModel(rawBody.model, defaultModel);
  const input = extractStateBlocks(rawBody);
  const questions = {};
  for (const [key, qVal] of Object.entries(rawBody.questions)) {
    questions[key] = translateQuestion(key, qVal);
  }
  const labels = isPlainRecord(rawBody.labels) && Object.values(rawBody.labels).every((v) => typeof v === "string") ? rawBody.labels : undefined;
  return {
    model,
    input,
    questions,
    ...labels ? { labels } : {}
  };
}
function normalizeNativeGoogleDecisionRequest(rawBody, defaultModel = "gemini-decision-1") {
  if (!isPlainRecord(rawBody)) {
    throw new ProtocolValidationError("Request body must be a JSON object.");
  }
  if (rawBody.input === undefined) {
    throw new ProtocolValidationError("Native Google Decisions request requires `input`.");
  }
  if (!isPlainRecord(rawBody.questions) || Object.keys(rawBody.questions).length === 0) {
    throw new ProtocolValidationError("Native Google Decisions request requires a non-empty `questions` map.");
  }
  return {
    ...rawBody,
    model: resolveUpstreamModel(rawBody.model, defaultModel)
  };
}
function normalizeAnswerProbabilities(answer) {
  const type = answer.type;
  if (type === "noul") {
    const noul = clampProbability(answer.noul);
    const confidence = typeof answer.confidence === "number" ? clampProbability(answer.confidence) : Math.max(noul, 1 - noul);
    return {
      ...answer,
      type: "noul",
      noul,
      confidence
    };
  }
  if (type === "choice" || type === "score") {
    const rawProbs = isPlainRecord(answer.probabilities) ? answer.probabilities : {};
    const probabilities = {};
    for (const [key, val] of Object.entries(rawProbs)) {
      probabilities[key] = clampProbability(val);
    }
    return {
      ...answer,
      probabilities,
      confidence: clampProbability(answer.confidence)
    };
  }
  return answer;
}
function translateGoogleToSystemOne(googleResponse, modelId) {
  if (!isPlainRecord(googleResponse) || !isPlainRecord(googleResponse.answers)) {
    throw new Error("Upstream Google Decisions response is missing `answers`.");
  }
  const answers = {};
  for (const [key, rawAns] of Object.entries(googleResponse.answers)) {
    if (isPlainRecord(rawAns)) {
      answers[key] = normalizeAnswerProbabilities(rawAns);
    }
  }
  const rawUsage = isPlainRecord(googleResponse.usage) ? googleResponse.usage : undefined;
  const inputTokens = typeof rawUsage?.total_input_tokens === "number" ? rawUsage.total_input_tokens : 0;
  const outputTokens = typeof rawUsage?.total_output_tokens === "number" ? rawUsage.total_output_tokens : 0;
  const totalTokens = typeof rawUsage?.total_tokens === "number" ? rawUsage.total_tokens : inputTokens + outputTokens;
  const cost = Number((inputTokens * INPUT_COST_PER_MILLION_USD / 1e6).toFixed(9));
  return {
    id: `gdec_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    model: modelId,
    provider: "google",
    answers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cost,
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      ...Array.isArray(rawUsage?.input_tokens_by_modality) ? { input_tokens_by_modality: rawUsage.input_tokens_by_modality } : {}
    }
  };
}
function summarizeAnswers(answers) {
  const parts = [];
  for (const [key, ans] of Object.entries(answers)) {
    if (ans.type === "choice" && typeof ans.choice === "string") {
      const pct = typeof ans.confidence === "number" ? ` ${Math.round(ans.confidence * 100)}%` : "";
      parts.push(`${key}=${ans.choice}${pct}`);
    } else if (ans.type === "noul" && typeof ans.noul === "number") {
      parts.push(`${key}=${ans.noul.toFixed(2)}`);
    } else if (ans.type === "score" && typeof ans.score === "number") {
      parts.push(`${key}=${ans.score.toFixed(2)}`);
    }
  }
  return parts.join(", ").slice(0, 120);
}

// service/server.ts
var MAX_BODY_BYTES = 64 * 1024 * 1024;
var MAX_LATENCY_HISTORY = 60;
var MAX_RECENT_TRACES = 20;
var PROBE_PAYLOAD = {
  state: { request: "Which of these is a colour: blue or table?" },
  questions: {
    probe: {
      type: "choice",
      instructions: "Pick the word that names a colour.",
      criteria: {
        blue: "A colour.",
        table: "A piece of furniture."
      }
    }
  }
};
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new ProtocolValidationError("Request payload exceeds maximum allowed size (64 MiB)."));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}
function listenLoopback(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
function closeHttpServer(server) {
  if (!server)
    return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
async function createBridgeServers(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const initialConfig = getBridgeConfig(env);
  const desiredProxyPort = options.proxyPortOverride ?? initialConfig.proxyPort;
  const serviceToken = env.OPENCHAMBER_SERVICE_TOKEN;
  const desiredServicePort = options.servicePortOverride !== undefined ? options.servicePortOverride : env.OPENCHAMBER_SERVICE_PORT ? Number.parseInt(env.OPENCHAMBER_SERVICE_PORT, 10) : null;
  const metrics = {
    requests: 0,
    successful: 0,
    failed: 0,
    totalDurationMs: 0,
    lastDurationMs: 0,
    totalInputTokens: 0,
    healthy: true,
    lastSummary: "",
    lastError: "",
    latencyHistory: [],
    traces: []
  };
  let boundProxyPort = desiredProxyPort;
  function recordOutcome(params) {
    metrics.requests += 1;
    metrics.lastDurationMs = params.durationMs;
    if (params.status >= 200 && params.status < 300) {
      metrics.successful += 1;
      metrics.totalDurationMs += params.durationMs;
      metrics.totalInputTokens += params.inputTokens;
      metrics.healthy = true;
      metrics.lastError = "";
      if (params.summary) {
        metrics.lastSummary = params.summary;
      }
      metrics.latencyHistory = [...metrics.latencyHistory.slice(-(MAX_LATENCY_HISTORY - 1)), params.durationMs];
    } else {
      metrics.failed += 1;
      if (params.status >= 500 || params.status === 401 || params.status === 403) {
        metrics.healthy = false;
      }
      if (params.error) {
        metrics.lastError = params.error.slice(0, 160);
      }
    }
    const trace = {
      id: `${Date.now()}-${metrics.requests}`,
      timestamp: new Date().toISOString(),
      protocol: params.protocol,
      durationMs: params.durationMs,
      status: params.status,
      questionCount: params.questionCount,
      inputTokens: params.inputTokens,
      summary: params.summary,
      ...params.error ? { error: params.error.slice(0, 160) } : {}
    };
    metrics.traces = [trace, ...metrics.traces.slice(0, MAX_RECENT_TRACES - 1)];
  }
  async function executeSystemOneDecision(rawPayload, protocolLabel) {
    const t0 = Date.now();
    const currentConfig = getBridgeConfig(env);
    const googlePayload = translateSystemOneToGoogle(rawPayload, currentConfig.defaultModel);
    const questionCount = Object.keys(googlePayload.questions).length;
    let authHeaders;
    try {
      const resolvedAuth = await resolveUpstreamAuthHeaders(currentConfig, env, fetchImpl);
      authHeaders = resolvedAuth.headers;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : "Authentication failed";
      recordOutcome({
        protocol: protocolLabel,
        durationMs,
        status: 401,
        questionCount,
        inputTokens: 0,
        summary: "",
        error: message
      });
      return {
        status: 401,
        body: { error: { code: "unauthorized", message } },
        durationMs
      };
    }
    const upstreamRes = await fetchImpl(`${currentConfig.upstreamBaseUrl}/decisions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders
      },
      body: JSON.stringify(googlePayload)
    });
    const durationMs = Date.now() - t0;
    const rawText = await upstreamRes.text();
    let parsedUpstream = {};
    try {
      parsedUpstream = rawText ? JSON.parse(rawText) : {};
    } catch {
      parsedUpstream = { error: { message: rawText.slice(0, 200) || "Invalid upstream JSON response" } };
    }
    if (!upstreamRes.ok) {
      const errMsg = parsedUpstream && typeof parsedUpstream === "object" && "error" in parsedUpstream && parsedUpstream.error && typeof parsedUpstream.error === "object" && "message" in parsedUpstream.error && typeof parsedUpstream.error.message === "string" ? parsedUpstream.error.message : `Upstream HTTP ${upstreamRes.status}`;
      recordOutcome({
        protocol: protocolLabel,
        durationMs,
        status: upstreamRes.status,
        questionCount,
        inputTokens: 0,
        summary: "",
        error: errMsg
      });
      return {
        status: upstreamRes.status,
        body: parsedUpstream && typeof parsedUpstream === "object" && !Array.isArray(parsedUpstream) ? parsedUpstream : { error: { message: errMsg } },
        durationMs
      };
    }
    const systemOneRes = translateGoogleToSystemOne(parsedUpstream, googlePayload.model);
    const summary = summarizeAnswers(systemOneRes.answers);
    recordOutcome({
      protocol: protocolLabel,
      durationMs,
      status: 200,
      questionCount,
      inputTokens: systemOneRes.usage.input_tokens,
      summary
    });
    return { status: 200, body: systemOneRes, durationMs };
  }
  async function executeNativeGoogleDecision(rawPayload) {
    const t0 = Date.now();
    const currentConfig = getBridgeConfig(env);
    const normalizedPayload = normalizeNativeGoogleDecisionRequest(rawPayload, currentConfig.defaultModel);
    const questionCount = normalizedPayload.questions && typeof normalizedPayload.questions === "object" ? Object.keys(normalizedPayload.questions).length : 0;
    let authHeaders;
    try {
      const resolvedAuth = await resolveUpstreamAuthHeaders(currentConfig, env, fetchImpl);
      authHeaders = resolvedAuth.headers;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : "Authentication failed";
      recordOutcome({
        protocol: "google",
        durationMs,
        status: 401,
        questionCount,
        inputTokens: 0,
        summary: "",
        error: message
      });
      return {
        status: 401,
        body: { error: { code: "unauthorized", message } },
        durationMs
      };
    }
    const upstreamRes = await fetchImpl(`${currentConfig.upstreamBaseUrl}/decisions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders
      },
      body: JSON.stringify(normalizedPayload)
    });
    const durationMs = Date.now() - t0;
    const rawText = await upstreamRes.text();
    let parsedUpstream = {};
    try {
      const parsed = rawText ? JSON.parse(rawText) : {};
      parsedUpstream = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { data: parsed };
    } catch {
      parsedUpstream = { error: { message: rawText.slice(0, 200) || "Invalid upstream JSON response" } };
    }
    if (!upstreamRes.ok) {
      const errObj = parsedUpstream.error;
      const errMsg = errObj && typeof errObj === "object" && "message" in errObj && typeof errObj.message === "string" ? errObj.message : `Upstream HTTP ${upstreamRes.status}`;
      recordOutcome({
        protocol: "google",
        durationMs,
        status: upstreamRes.status,
        questionCount,
        inputTokens: 0,
        summary: "",
        error: errMsg
      });
      return { status: upstreamRes.status, body: parsedUpstream, durationMs };
    }
    const rawAnswers = parsedUpstream.answers && typeof parsedUpstream.answers === "object" && !Array.isArray(parsedUpstream.answers) ? parsedUpstream.answers : {};
    const rawUsage = parsedUpstream.usage && typeof parsedUpstream.usage === "object" && !Array.isArray(parsedUpstream.usage) ? parsedUpstream.usage : {};
    const inputTokens = typeof rawUsage.total_input_tokens === "number" ? rawUsage.total_input_tokens : 0;
    recordOutcome({
      protocol: "google",
      durationMs,
      status: 200,
      questionCount,
      inputTokens,
      summary: summarizeAnswers(rawAnswers)
    });
    return { status: 200, body: parsedUpstream, durationMs };
  }
  function buildGuestStatusView() {
    const currentConfig = getBridgeConfig(env);
    const auth = inspectAuthStatus(currentConfig, env);
    const avgMs = metrics.successful > 0 ? Math.round(metrics.totalDurationMs / metrics.successful) : 0;
    const badgeTone = auth.configured ? "success" : "error";
    const badgeLabel = auth.mode === "oauth" ? "OAuth" : auth.mode === "api-key" ? "API Key" : "No Auth";
    const modelLabel = currentConfig.defaultModel.slice(0, 200) || "gemini-decision-1";
    const requestSummary = metrics.requests === 0 ? "0 processed" : metrics.failed > 0 ? `${metrics.successful} ok · ${metrics.failed} err` : `${metrics.successful} ok`;
    const requestTooltip = metrics.requests > 0 ? `${metrics.requests} total (${metrics.successful} ok${metrics.failed > 0 ? `, ${metrics.failed} err` : ""})${metrics.successful > 0 ? ` · avg ${avgMs}ms` : ""}` : "No decisions processed yet";
    const rows = [
      {
        kind: "line",
        id: "decisions-endpoint",
        label: "Bridge",
        dot: auth.configured && metrics.healthy ? "success" : auth.configured ? "warning" : "error",
        badge: { label: badgeLabel, tone: badgeTone },
        value: `:${boundProxyPort}`,
        tooltip: `127.0.0.1:${boundProxyPort} -> ${modelLabel}`.slice(0, 200)
      },
      {
        kind: "line",
        id: "decisions-model",
        label: "Model",
        content: {
          kind: "text",
          text: modelLabel
        },
        tooltip: modelLabel
      },
      {
        kind: "line",
        id: "decisions-requests",
        label: "Decisions",
        dot: metrics.failed > 0 ? "warning" : "default",
        value: requestSummary,
        tooltip: requestTooltip.slice(0, 200)
      }
    ];
    if (metrics.latencyHistory.length >= 2) {
      rows.push({
        kind: "line",
        id: "decisions-latency",
        label: "Latency",
        content: {
          kind: "chart",
          values: metrics.latencyHistory,
          unit: "count",
          tone: "accent"
        },
        value: `${avgMs}ms`,
        tooltip: `Avg ${avgMs}ms · Last ${metrics.lastDurationMs}ms (${metrics.latencyHistory.length} samples)`.slice(0, 200)
      });
    }
    rows.push({
      kind: "note",
      id: "auth-source",
      text: (auth.projectId ? `Auth: ${auth.source} (${auth.projectId})` : `Auth: ${auth.source}`).slice(0, 200),
      tone: auth.configured ? "muted" : "warning"
    });
    if (metrics.lastSummary) {
      rows.push({
        kind: "note",
        id: "last-decision",
        text: `Last: ${metrics.lastSummary} (${metrics.lastDurationMs}ms)`.slice(0, 200),
        tone: "info"
      });
    }
    if (metrics.lastError) {
      rows.push({
        kind: "note",
        id: "last-error",
        text: `Last error: ${metrics.lastError}`.slice(0, 200),
        tone: "error"
      });
    }
    return {
      rows,
      controls: [
        {
          kind: "button",
          id: "probe",
          label: "Test"
        }
      ]
    };
  }
  function buildPanelStateSnapshot() {
    const currentConfig = getBridgeConfig(env);
    const auth = inspectAuthStatus(currentConfig, env);
    const avgDurationMs = metrics.successful > 0 ? Math.round(metrics.totalDurationMs / metrics.successful) : 0;
    return {
      proxyPort: boundProxyPort,
      systemOneUrl: `http://127.0.0.1:${boundProxyPort}/v1/systemone`,
      googleDecisionsUrl: `http://127.0.0.1:${boundProxyPort}/v1beta/decisions`,
      opencodeBaseUrl: `http://127.0.0.1:${boundProxyPort}/v1`,
      defaultModel: currentConfig.defaultModel,
      upstreamBaseUrl: currentConfig.upstreamBaseUrl,
      configFile: formatHomePath(currentConfig.configFile),
      auth,
      stats: {
        requests: metrics.requests,
        successful: metrics.successful,
        failed: metrics.failed,
        totalInputTokens: metrics.totalInputTokens,
        lastDurationMs: metrics.lastDurationMs,
        avgDurationMs,
        healthy: metrics.healthy,
        lastSummary: metrics.lastSummary,
        lastError: metrics.lastError,
        latencyHistory: metrics.latencyHistory
      },
      traces: metrics.traces
    };
  }
  const proxyServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${boundProxyPort}`);
    const pathname = reqUrl.pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key, TypeSafe-Danger-Zone-Images"
      });
      res.end();
      return;
    }
    try {
      if (req.method === "GET" && pathname === "/health") {
        const currentConfig = getBridgeConfig(env);
        sendJson(res, 200, {
          status: "ok",
          service: "gemini-decisions-bridge",
          proxyPort: boundProxyPort,
          upstreamBaseUrl: currentConfig.upstreamBaseUrl,
          defaultModel: currentConfig.defaultModel,
          auth: inspectAuthStatus(currentConfig, env),
          healthy: metrics.healthy,
          configFile: formatHomePath(currentConfig.configFile)
        });
        return;
      }
      if (req.method === "GET" && pathname === "/config") {
        const currentConfig = getBridgeConfig(env);
        sendJson(res, 200, {
          proxyPort: currentConfig.proxyPort,
          upstreamBaseUrl: currentConfig.upstreamBaseUrl,
          defaultModel: currentConfig.defaultModel,
          projectId: currentConfig.projectId ?? null,
          oauthTokenPath: currentConfig.oauthTokenPath ? formatHomePath(currentConfig.oauthTokenPath) : null,
          hasApiKey: Boolean(currentConfig.apiKey),
          hasOauthClientId: Boolean(currentConfig.oauthClientId),
          configFile: formatHomePath(currentConfig.configFile)
        });
        return;
      }
      if (req.method === "POST" && pathname === "/config") {
        const raw = await readRequestBody(req);
        const updates = raw ? JSON.parse(raw) : {};
        const updated = updateBridgeConfigFile(updates, env);
        sendJson(res, 200, {
          ok: true,
          proxyPort: updated.proxyPort,
          upstreamBaseUrl: updated.upstreamBaseUrl,
          defaultModel: updated.defaultModel,
          projectId: updated.projectId ?? null,
          hasApiKey: Boolean(updated.apiKey),
          hasOauthClientId: Boolean(updated.oauthClientId),
          configFile: formatHomePath(updated.configFile)
        });
        return;
      }
      if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
        const currentConfig = getBridgeConfig(env);
        sendJson(res, 200, {
          object: "list",
          data: [
            {
              id: currentConfig.defaultModel,
              object: "model",
              owned_by: "google",
              type: "decision",
              context_length: 262144
            }
          ]
        });
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/v1beta/models")) {
        const currentConfig = getBridgeConfig(env);
        const resolvedAuth = await resolveUpstreamAuthHeaders(currentConfig, env, fetchImpl);
        const suffix = pathname.slice("/v1beta".length);
        const upstreamRes = await fetchImpl(`${currentConfig.upstreamBaseUrl}${suffix}`, {
          method: "GET",
          headers: resolvedAuth.headers
        });
        const rawText = await upstreamRes.text();
        res.writeHead(upstreamRes.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(rawText);
        return;
      }
      if (req.method === "POST" && (pathname === "/v1/systemone" || pathname === "/systemone")) {
        const raw = await readRequestBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const outcome = await executeSystemOneDecision(parsed, "systemone");
        sendJson(res, outcome.status, outcome.body);
        return;
      }
      if (req.method === "POST" && (pathname === "/v1beta/decisions" || pathname === "/v1/decisions" || pathname === "/decisions")) {
        const raw = await readRequestBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const outcome = await executeNativeGoogleDecision(parsed);
        sendJson(res, outcome.status, outcome.body);
        return;
      }
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: `Unknown route ${req.method} ${pathname}. Use POST /v1/systemone or POST /v1beta/decisions.`
        }
      });
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof ProtocolValidationError) {
        sendJson(res, 400, {
          error: {
            code: "invalid_request",
            message: err.message
          }
        });
        return;
      }
      const message = err instanceof Error ? err.message : "Internal bridge error";
      metrics.failed += 1;
      metrics.lastError = message.slice(0, 160);
      sendJson(res, 500, {
        error: {
          code: "internal_error",
          message
        }
      });
    }
  });
  boundProxyPort = await listenLoopback(proxyServer, desiredProxyPort);
  let serviceServer = null;
  let boundServicePort = null;
  if (desiredServicePort !== null && Number.isInteger(desiredServicePort)) {
    serviceServer = http.createServer(async (req, res) => {
      if (serviceToken && req.headers.authorization !== `Bearer ${serviceToken}`) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = reqUrl.pathname;
      try {
        if (req.method === "GET" && pathname === "/health") {
          sendJson(res, 200, { status: "ok", healthy: metrics.healthy });
          return;
        }
        if (req.method === "GET" && pathname === "/status") {
          sendJson(res, 200, buildGuestStatusView());
          return;
        }
        if (req.method === "POST" && pathname === "/status") {
          const raw = await readRequestBody(req);
          const action = raw ? JSON.parse(raw) : {};
          if (action.id === "probe") {
            const outcome = await executeSystemOneDecision(PROBE_PAYLOAD, "playground");
            if (outcome.status >= 200 && outcome.status < 300) {
              sendJson(res, 200, { ok: true, durationMs: outcome.durationMs });
            } else {
              const errBody = outcome.body;
              sendJson(res, outcome.status, {
                message: errBody.error?.message || `Probe failed (${outcome.status})`
              });
            }
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === "GET" && pathname === "/state") {
          sendJson(res, 200, buildPanelStateSnapshot());
          return;
        }
        if (req.method === "POST" && pathname === "/probe") {
          const outcome = await executeSystemOneDecision(PROBE_PAYLOAD, "playground");
          sendJson(res, outcome.status, {
            ok: outcome.status >= 200 && outcome.status < 300,
            durationMs: outcome.durationMs,
            response: outcome.body
          });
          return;
        }
        if (req.method === "POST" && pathname === "/evaluate") {
          const raw = await readRequestBody(req);
          const payload = raw ? JSON.parse(raw) : {};
          const outcome = await executeSystemOneDecision(payload, "playground");
          sendJson(res, outcome.status, {
            ok: outcome.status >= 200 && outcome.status < 300,
            durationMs: outcome.durationMs,
            response: outcome.body
          });
          return;
        }
        sendJson(res, 404, { error: "Not Found" });
      } catch (err) {
        if (err instanceof SyntaxError || err instanceof ProtocolValidationError) {
          sendJson(res, 400, { message: err.message, error: err.message });
          return;
        }
        const message = err instanceof Error ? err.message : "Service error";
        sendJson(res, 500, { message, error: message });
      }
    });
    boundServicePort = await listenLoopback(serviceServer, desiredServicePort);
  }
  return {
    proxyServer,
    proxyPort: boundProxyPort,
    serviceServer,
    servicePort: boundServicePort,
    close: async () => {
      await Promise.all([closeHttpServer(serviceServer), closeHttpServer(proxyServer)]);
    }
  };
}

// service/main.ts
var running = await createBridgeServers();
console.log(`[gemini-decisions-bridge] Local Decisions proxy listening on 127.0.0.1:${running.proxyPort}` + (running.servicePort !== null ? ` | Guest service on 127.0.0.1:${running.servicePort}` : ""));
var shutdown = async () => {
  await running.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  shutdown();
});
process.on("SIGTERM", () => {
  shutdown();
});

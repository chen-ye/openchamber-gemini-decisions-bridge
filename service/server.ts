import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import {
  formatHomePath,
  getBridgeConfig,
  inspectAuthStatus,
  resolveUpstreamAuthHeaders,
  updateBridgeConfigFile,
  type BridgeConfigFile,
} from './auth.ts';
import {
  normalizeNativeGoogleDecisionRequest,
  ProtocolValidationError,
  summarizeAnswers,
  translateGoogleToSystemOne,
  translateSystemOneToGoogle,
  type SystemOneResponse,
} from './protocol.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_LATENCY_HISTORY = 60;
const MAX_RECENT_TRACES = 20;

export interface DecisionTraceEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly protocol: 'systemone' | 'google' | 'playground';
  readonly durationMs: number;
  readonly status: number;
  readonly questionCount: number;
  readonly inputTokens: number;
  readonly summary: string;
  readonly error?: string;
}

interface RuntimeMetrics {
  requests: number;
  successful: number;
  failed: number;
  totalDurationMs: number;
  lastDurationMs: number;
  totalInputTokens: number;
  healthy: boolean;
  lastSummary: string;
  lastError: string;
  latencyHistory: number[];
  traces: DecisionTraceEntry[];
}

export interface BridgeServersOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly proxyPortOverride?: number;
  readonly servicePortOverride?: number | null;
}

export interface RunningBridgeServers {
  readonly proxyServer: http.Server;
  readonly proxyPort: number;
  readonly serviceServer: http.Server | null;
  readonly servicePort: number | null;
  readonly close: () => Promise<void>;
}

const PROBE_PAYLOAD = {
  state: { request: 'Which of these is a colour: blue or table?' },
  questions: {
    probe: {
      type: 'choice',
      instructions: 'Pick the word that names a colour.',
      criteria: {
        blue: 'A colour.',
        table: 'A piece of furniture.',
      },
    },
  },
} as const;

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new ProtocolValidationError('Request payload exceeds maximum allowed size (64 MiB).'));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

function listenLoopback(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address() as AddressInfo | null;
      resolve(addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeHttpServer(server: http.Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Starts both the OpenChamber guest service server (when configured) and the local Decisions proxy server. */
export async function createBridgeServers(options: BridgeServersOptions = {}): Promise<RunningBridgeServers> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  const initialConfig = getBridgeConfig(env);
  const desiredProxyPort = options.proxyPortOverride ?? initialConfig.proxyPort;
  const serviceToken = env.OPENCHAMBER_SERVICE_TOKEN;
  const desiredServicePort =
    options.servicePortOverride !== undefined
      ? options.servicePortOverride
      : env.OPENCHAMBER_SERVICE_PORT
        ? Number.parseInt(env.OPENCHAMBER_SERVICE_PORT, 10)
        : null;

  const metrics: RuntimeMetrics = {
    requests: 0,
    successful: 0,
    failed: 0,
    totalDurationMs: 0,
    lastDurationMs: 0,
    totalInputTokens: 0,
    healthy: true,
    lastSummary: '',
    lastError: '',
    latencyHistory: [],
    traces: [],
  };

  let boundProxyPort = desiredProxyPort;

  function recordOutcome(params: {
    protocol: 'systemone' | 'google' | 'playground';
    durationMs: number;
    status: number;
    questionCount: number;
    inputTokens: number;
    summary: string;
    error?: string;
  }): void {
    metrics.requests += 1;
    metrics.lastDurationMs = params.durationMs;

    if (params.status >= 200 && params.status < 300) {
      metrics.successful += 1;
      metrics.totalDurationMs += params.durationMs;
      metrics.totalInputTokens += params.inputTokens;
      metrics.healthy = true;
      metrics.lastError = '';
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

    const trace: DecisionTraceEntry = {
      id: `${Date.now()}-${metrics.requests}`,
      timestamp: new Date().toISOString(),
      protocol: params.protocol,
      durationMs: params.durationMs,
      status: params.status,
      questionCount: params.questionCount,
      inputTokens: params.inputTokens,
      summary: params.summary,
      ...(params.error ? { error: params.error.slice(0, 160) } : {}),
    };
    metrics.traces = [trace, ...metrics.traces.slice(0, MAX_RECENT_TRACES - 1)];
  }

  async function executeSystemOneDecision(
    rawPayload: unknown,
    protocolLabel: 'systemone' | 'playground',
  ): Promise<{ status: number; body: SystemOneResponse | Record<string, unknown>; durationMs: number }> {
    const t0 = Date.now();
    const currentConfig = getBridgeConfig(env);
    const googlePayload = translateSystemOneToGoogle(rawPayload, currentConfig.defaultModel);
    const questionCount = Object.keys(googlePayload.questions).length;

    let authHeaders: Readonly<Record<string, string>>;
    try {
      const resolvedAuth = await resolveUpstreamAuthHeaders(currentConfig, env, fetchImpl);
      authHeaders = resolvedAuth.headers;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : 'Authentication failed';
      recordOutcome({
        protocol: protocolLabel,
        durationMs,
        status: 401,
        questionCount,
        inputTokens: 0,
        summary: '',
        error: message,
      });
      return {
        status: 401,
        body: { error: { code: 'unauthorized', message } },
        durationMs,
      };
    }

    const upstreamRes = await fetchImpl(`${currentConfig.upstreamBaseUrl}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(googlePayload),
    });

    const durationMs = Date.now() - t0;
    const rawText = await upstreamRes.text();
    let parsedUpstream: unknown = {};
    try {
      parsedUpstream = rawText ? JSON.parse(rawText) : {};
    } catch {
      parsedUpstream = { error: { message: rawText.slice(0, 200) || 'Invalid upstream JSON response' } };
    }

    if (!upstreamRes.ok) {
      const errMsg =
        parsedUpstream &&
        typeof parsedUpstream === 'object' &&
        'error' in parsedUpstream &&
        parsedUpstream.error &&
        typeof parsedUpstream.error === 'object' &&
        'message' in parsedUpstream.error &&
        typeof parsedUpstream.error.message === 'string'
          ? parsedUpstream.error.message
          : `Upstream HTTP ${upstreamRes.status}`;

      recordOutcome({
        protocol: protocolLabel,
        durationMs,
        status: upstreamRes.status,
        questionCount,
        inputTokens: 0,
        summary: '',
        error: errMsg,
      });

      return {
        status: upstreamRes.status,
        body:
          parsedUpstream && typeof parsedUpstream === 'object' && !Array.isArray(parsedUpstream)
            ? (parsedUpstream as Record<string, unknown>)
            : { error: { message: errMsg } },
        durationMs,
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
      summary,
    });

    return { status: 200, body: systemOneRes, durationMs };
  }

  async function executeNativeGoogleDecision(
    rawPayload: unknown,
  ): Promise<{ status: number; body: Record<string, unknown>; durationMs: number }> {
    const t0 = Date.now();
    const currentConfig = getBridgeConfig(env);
    const normalizedPayload = normalizeNativeGoogleDecisionRequest(rawPayload, currentConfig.defaultModel);
    const questionCount =
      normalizedPayload.questions && typeof normalizedPayload.questions === 'object'
        ? Object.keys(normalizedPayload.questions).length
        : 0;

    let authHeaders: Readonly<Record<string, string>>;
    try {
      const resolvedAuth = await resolveUpstreamAuthHeaders(currentConfig, env, fetchImpl);
      authHeaders = resolvedAuth.headers;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : 'Authentication failed';
      recordOutcome({
        protocol: 'google',
        durationMs,
        status: 401,
        questionCount,
        inputTokens: 0,
        summary: '',
        error: message,
      });
      return {
        status: 401,
        body: { error: { code: 'unauthorized', message } },
        durationMs,
      };
    }

    const upstreamRes = await fetchImpl(`${currentConfig.upstreamBaseUrl}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(normalizedPayload),
    });

    const durationMs = Date.now() - t0;
    const rawText = await upstreamRes.text();
    let parsedUpstream: Record<string, unknown> = {};
    try {
      const parsed: unknown = rawText ? JSON.parse(rawText) : {};
      parsedUpstream =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { data: parsed };
    } catch {
      parsedUpstream = { error: { message: rawText.slice(0, 200) || 'Invalid upstream JSON response' } };
    }

    if (!upstreamRes.ok) {
      const errObj = parsedUpstream.error;
      const errMsg =
        errObj && typeof errObj === 'object' && 'message' in errObj && typeof errObj.message === 'string'
          ? errObj.message
          : `Upstream HTTP ${upstreamRes.status}`;

      recordOutcome({
        protocol: 'google',
        durationMs,
        status: upstreamRes.status,
        questionCount,
        inputTokens: 0,
        summary: '',
        error: errMsg,
      });
      return { status: upstreamRes.status, body: parsedUpstream, durationMs };
    }

    const rawAnswers =
      parsedUpstream.answers && typeof parsedUpstream.answers === 'object' && !Array.isArray(parsedUpstream.answers)
        ? (parsedUpstream.answers as Record<string, Record<string, unknown>>)
        : {};
    const rawUsage =
      parsedUpstream.usage && typeof parsedUpstream.usage === 'object' && !Array.isArray(parsedUpstream.usage)
        ? (parsedUpstream.usage as Record<string, unknown>)
        : {};
    const inputTokens = typeof rawUsage.total_input_tokens === 'number' ? rawUsage.total_input_tokens : 0;

    recordOutcome({
      protocol: 'google',
      durationMs,
      status: 200,
      questionCount,
      inputTokens,
      summary: summarizeAnswers(rawAnswers),
    });

    return { status: 200, body: parsedUpstream, durationMs };
  }

  function buildGuestStatusView() {
    const currentConfig = getBridgeConfig(env);
    const auth = inspectAuthStatus(currentConfig, env);
    const avgMs = metrics.successful > 0 ? Math.round(metrics.totalDurationMs / metrics.successful) : 0;

    const badgeTone = auth.configured ? 'success' : 'error';
    const badgeLabel = auth.mode === 'oauth' ? 'OAuth' : auth.mode === 'api-key' ? 'API Key' : 'No Auth';
    const modelLabel = currentConfig.defaultModel.slice(0, 200) || 'gemini-decision-1';
    const requestSummary =
      metrics.requests === 0
        ? '0 processed'
        : metrics.failed > 0
          ? `${metrics.successful} ok · ${metrics.failed} err`
          : `${metrics.successful} ok`;
    const requestTooltip =
      metrics.requests > 0
        ? `${metrics.requests} total (${metrics.successful} ok${metrics.failed > 0 ? `, ${metrics.failed} err` : ''})${metrics.successful > 0 ? ` · avg ${avgMs}ms` : ''}`
        : 'No decisions processed yet';

    const rows: Array<Record<string, unknown>> = [
      {
        kind: 'line',
        id: 'decisions-endpoint',
        label: 'Bridge',
        dot: auth.configured && metrics.healthy ? 'success' : auth.configured ? 'warning' : 'error',
        badge: { label: badgeLabel, tone: badgeTone },
        value: `:${boundProxyPort}`,
        tooltip: `127.0.0.1:${boundProxyPort} -> ${modelLabel}`.slice(0, 200),
      },
      {
        kind: 'line',
        id: 'decisions-model',
        label: 'Model',
        content: {
          kind: 'text',
          text: modelLabel,
        },
        tooltip: modelLabel,
      },
      {
        kind: 'line',
        id: 'decisions-requests',
        label: 'Decisions',
        dot: metrics.failed > 0 ? 'warning' : 'default',
        value: requestSummary,
        tooltip: requestTooltip.slice(0, 200),
      },
    ];

    if (metrics.latencyHistory.length >= 2) {
      rows.push({
        kind: 'line',
        id: 'decisions-latency',
        label: 'Latency',
        content: {
          kind: 'chart',
          values: metrics.latencyHistory,
          unit: 'count',
          tone: 'accent',
        },
        value: `${avgMs}ms`,
        tooltip: `Avg ${avgMs}ms · Last ${metrics.lastDurationMs}ms (${metrics.latencyHistory.length} samples)`.slice(0, 200),
      });
    }

    rows.push({
      kind: 'note',
      id: 'auth-source',
      text: (auth.projectId ? `Auth: ${auth.source} (${auth.projectId})` : `Auth: ${auth.source}`).slice(0, 200),
      tone: auth.configured ? 'muted' : 'warning',
    });

    if (metrics.lastSummary) {
      rows.push({
        kind: 'note',
        id: 'last-decision',
        text: `Last: ${metrics.lastSummary} (${metrics.lastDurationMs}ms)`.slice(0, 200),
        tone: 'info',
      });
    }

    if (metrics.lastError) {
      rows.push({
        kind: 'note',
        id: 'last-error',
        text: `Last error: ${metrics.lastError}`.slice(0, 200),
        tone: 'error',
      });
    }

    return {
      rows,
      controls: [
        {
          kind: 'button',
          id: 'probe',
          label: 'Test',
        },
      ],
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
        latencyHistory: metrics.latencyHistory,
      },
      traces: metrics.traces,
    };
  }

  // 1. Standalone Local Decisions Bridge Proxy (127.0.0.1:4006 by default)
  const proxyServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${boundProxyPort}`);
    const pathname = reqUrl.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-goog-api-key, TypeSafe-Danger-Zone-Images',
      });
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/health') {
        const currentConfig = getBridgeConfig(env);
        sendJson(res, 200, {
          status: 'ok',
          service: 'gemini-decisions-bridge',
          proxyPort: boundProxyPort,
          upstreamBaseUrl: currentConfig.upstreamBaseUrl,
          defaultModel: currentConfig.defaultModel,
          auth: inspectAuthStatus(currentConfig, env),
          healthy: metrics.healthy,
          configFile: formatHomePath(currentConfig.configFile),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/config') {
        const currentConfig = getBridgeConfig(env);
        sendJson(res, 200, {
          proxyPort: currentConfig.proxyPort,
          upstreamBaseUrl: currentConfig.upstreamBaseUrl,
          defaultModel: currentConfig.defaultModel,
          projectId: currentConfig.projectId ?? null,
          oauthTokenPath: currentConfig.oauthTokenPath ? formatHomePath(currentConfig.oauthTokenPath) : null,
          hasApiKey: Boolean(currentConfig.apiKey),
          hasOauthClientId: Boolean(currentConfig.oauthClientId),
          configFile: formatHomePath(currentConfig.configFile),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/config') {
        const raw = await readRequestBody(req);
        const updates = (raw ? JSON.parse(raw) : {}) as BridgeConfigFile;
        const updated = updateBridgeConfigFile(updates, env);
        sendJson(res, 200, {
          ok: true,
          proxyPort: updated.proxyPort,
          upstreamBaseUrl: updated.upstreamBaseUrl,
          defaultModel: updated.defaultModel,
          projectId: updated.projectId ?? null,
          hasApiKey: Boolean(updated.apiKey),
          hasOauthClientId: Boolean(updated.oauthClientId),
          configFile: formatHomePath(updated.configFile),
        });
        return;
      }

      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        const currentConfig = getBridgeConfig(env);
        sendJson(res, 200, {
          object: 'list',
          data: [
            {
              id: currentConfig.defaultModel,
              object: 'model',
              owned_by: 'google',
              type: 'decision',
              context_length: 262144,
            },
          ],
        });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/v1beta/models')) {
        const currentConfig = getBridgeConfig(env);
        const resolvedAuth = await resolveUpstreamAuthHeaders(currentConfig, env, fetchImpl);
        const suffix = pathname.slice('/v1beta'.length);
        const upstreamRes = await fetchImpl(`${currentConfig.upstreamBaseUrl}${suffix}`, {
          method: 'GET',
          headers: resolvedAuth.headers,
        });
        const rawText = await upstreamRes.text();
        res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(rawText);
        return;
      }

      if (req.method === 'POST' && (pathname === '/v1/systemone' || pathname === '/systemone')) {
        const raw = await readRequestBody(req);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const outcome = await executeSystemOneDecision(parsed, 'systemone');
        sendJson(res, outcome.status, outcome.body);
        return;
      }

      if (
        req.method === 'POST' &&
        (pathname === '/v1beta/decisions' || pathname === '/v1/decisions' || pathname === '/decisions')
      ) {
        const raw = await readRequestBody(req);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const outcome = await executeNativeGoogleDecision(parsed);
        sendJson(res, outcome.status, outcome.body);
        return;
      }

      sendJson(res, 404, {
        error: {
          code: 'not_found',
          message: `Unknown route ${req.method} ${pathname}. Use POST /v1/systemone or POST /v1beta/decisions.`,
        },
      });
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof ProtocolValidationError) {
        sendJson(res, 400, {
          error: {
            code: 'invalid_request',
            message: err.message,
          },
        });
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal bridge error';
      metrics.failed += 1;
      metrics.lastError = message.slice(0, 160);
      sendJson(res, 500, {
        error: {
          code: 'internal_error',
          message,
        },
      });
    }
  });

  boundProxyPort = await listenLoopback(proxyServer, desiredProxyPort);

  // 2. OpenChamber Guest Service Host (bearer-authenticated)
  let serviceServer: http.Server | null = null;
  let boundServicePort: number | null = null;

  if (desiredServicePort !== null && Number.isInteger(desiredServicePort)) {
    serviceServer = http.createServer(async (req, res) => {
      if (serviceToken && req.headers.authorization !== `Bearer ${serviceToken}`) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;

      try {
        if (req.method === 'GET' && pathname === '/health') {
          sendJson(res, 200, { status: 'ok', healthy: metrics.healthy });
          return;
        }

        if (req.method === 'GET' && pathname === '/status') {
          sendJson(res, 200, buildGuestStatusView());
          return;
        }

        if (req.method === 'POST' && pathname === '/status') {
          const raw = await readRequestBody(req);
          const action = (raw ? JSON.parse(raw) : {}) as { id?: string };
          if (action.id === 'probe') {
            const outcome = await executeSystemOneDecision(PROBE_PAYLOAD, 'playground');
            if (outcome.status >= 200 && outcome.status < 300) {
              sendJson(res, 200, { ok: true, durationMs: outcome.durationMs });
            } else {
              const errBody = outcome.body as { error?: { message?: string } };
              sendJson(res, outcome.status, {
                message: errBody.error?.message || `Probe failed (${outcome.status})`,
              });
            }
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'GET' && pathname === '/state') {
          sendJson(res, 200, buildPanelStateSnapshot());
          return;
        }

        if (req.method === 'POST' && pathname === '/probe') {
          const outcome = await executeSystemOneDecision(PROBE_PAYLOAD, 'playground');
          sendJson(res, outcome.status, {
            ok: outcome.status >= 200 && outcome.status < 300,
            durationMs: outcome.durationMs,
            response: outcome.body,
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/evaluate') {
          const raw = await readRequestBody(req);
          const payload: unknown = raw ? JSON.parse(raw) : {};
          const outcome = await executeSystemOneDecision(payload, 'playground');
          sendJson(res, outcome.status, {
            ok: outcome.status >= 200 && outcome.status < 300,
            durationMs: outcome.durationMs,
            response: outcome.body,
          });
          return;
        }

        sendJson(res, 404, { error: 'Not Found' });
      } catch (err) {
        if (err instanceof SyntaxError || err instanceof ProtocolValidationError) {
          sendJson(res, 400, { message: err.message, error: err.message });
          return;
        }
        const message = err instanceof Error ? err.message : 'Service error';
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
    },
  };
}

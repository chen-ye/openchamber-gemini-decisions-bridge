import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { guestStatusViewSchema } from '@openchamber/sdk/schemas';
import { clearAuthCacheForTests } from '../service/auth.ts';
import { createBridgeServers, type RunningBridgeServers } from '../service/server.ts';

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

describe('gemini-decisions-bridge behavioral e2e suite', () => {
  let tempDir: string;
  let authPath: string;
  let configPath: string;
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let recordedUpstream: RecordedRequest[];
  let tokenRefreshCount: number;
  let bridge: RunningBridgeServers | null = null;

  beforeEach(async () => {
    clearAuthCacheForTests();
    recordedUpstream = [];
    tokenRefreshCount = 0;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-decisions-bridge-test-'));
    authPath = path.join(tempDir, 'auth.json');
    configPath = path.join(tempDir, 'gemini-decisions-bridge.json');

    fs.writeFileSync(
      authPath,
      JSON.stringify(
        {
          anthropic: { type: 'key', key: 'keep-me-intact' },
          google: {
            type: 'oauth',
            access: 'ya29.initial-token',
            refresh: '1//refresh-token',
            expires: Date.now() + 3600 * 1000,
          },
        },
        null,
        2,
      ),
    );

    upstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (req.url === '/token' && req.method === 'POST') {
          tokenRefreshCount += 1;
          const params = Object.fromEntries(new URLSearchParams(raw).entries());
          recordedUpstream.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: params,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'ya29.refreshed-token',
              expires_in: 3600,
            }),
          );
          return;
        }

        const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        recordedUpstream.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: parsed,
        });

        if (req.url === '/v1beta/decisions' && req.method === 'POST') {
          const questions = (parsed?.questions ?? {}) as Record<string, Record<string, unknown>>;
          const answers: Record<string, unknown> = {};

          for (const [key, q] of Object.entries(questions)) {
            if (q.type === 'noul') {
              answers[key] = { type: 'noul', noul: 0.94, confidence: 0.94 };
            } else if (q.type === 'choice') {
              const criteria = (q.criteria ?? {}) as Record<string, string>;
              const keys = Object.keys(criteria);
              const winner = keys[0] ?? 'default';
              const probs: Record<string, number> = {};
              keys.forEach((k, idx) => {
                probs[k] = idx === 0 ? 0.92 : Number((0.08 / Math.max(1, keys.length - 1)).toFixed(4));
              });
              answers[key] = {
                type: 'choice',
                choice: winner,
                confidence: 0.92,
                probabilities: probs,
              };
            } else if (q.type === 'score') {
              const criteria = (q.criteria ?? []) as string[];
              const legend: Record<string, string> = {};
              const probs: Record<string, number> = {};
              criteria.forEach((desc, idx) => {
                legend[String(idx)] = desc;
                probs[String(idx)] = idx === 1 ? 0.8 : 0.2 / Math.max(1, criteria.length - 1);
              });
              answers[key] = {
                type: 'score',
                score: 1.15,
                confidence: 0.8,
                probabilities: probs,
                legend,
              };
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              answers,
              usage: {
                total_input_tokens: 120,
                total_output_tokens: 0,
                total_tokens: 120,
                input_tokens_by_modality: [{ modality: 'text', tokens: 120 }],
              },
            }),
          );
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
      });
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        upstreamPort = (upstreamServer.address() as AddressInfo).port;
        resolve();
      });
    });

    bridge = await createBridgeServers({
      proxyPortOverride: 0,
      servicePortOverride: 0,
      env: {
        ...process.env,
        OPENCODE_AUTH_PATH: authPath,
        BRIDGE_CONFIG_PATH: configPath,
        GEMINI_DECISIONS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1beta`,
        GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${upstreamPort}/token`,
        GOOGLE_PROJECT_ID: 'test-gcp-project',
        GOOGLE_CLIENT_ID: 'test-oauth-client-id',
        GOOGLE_CLIENT_SECRET: 'test-oauth-client-secret',
        OPENCHAMBER_SERVICE_TOKEN: 'test-service-secret',
      },
    });
  });

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = null;
    }
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    clearAuthCacheForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('translates OpenChamber turn-end Jev requests (array instructions + true/false criteria) to Google /v1beta/decisions', async () => {
    const res = await fetch(`http://127.0.0.1:${bridge!.proxyPort}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'torchcast-decision-4b',
        state: {
          history: [],
          request: 'Fix the race condition',
          answer: 'Fixed the lock order and ran tests.',
        },
        questions: {
          review_ready: {
            type: 'noul',
            instructions: ['Turn context header.', 'Did the agent edit code in this turn?'],
            criteria: {
              true: 'The agent modified project files.',
              false: 'The agent only explained or investigated.',
            },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.model).toBe('gemini-decision-1');
    expect((data.answers as Record<string, Record<string, unknown>>).review_ready?.noul).toBe(0.94);

    expect(recordedUpstream.length).toBe(1);
    const upstreamReq = recordedUpstream[0]!;
    expect(upstreamReq.headers.authorization).toBe('Bearer ya29.initial-token');
    expect(upstreamReq.headers['x-goog-user-project']).toBe('test-gcp-project');
    expect(upstreamReq.body?.model).toBe('gemini-decision-1');

    const sentQuestions = upstreamReq.body?.questions as Record<string, Record<string, unknown>>;
    expect(sentQuestions.review_ready?.instructions).toBe('Turn context header.\n\nDid the agent edit code in this turn?');
    expect(sentQuestions.review_ready?.criteria).toEqual({
      true_description: 'The agent modified project files.',
      false_description: 'The agent only explained or investigated.',
    });
  });

  it('translates OpenCode SystemOne multimodal assets, choice null descriptions, and usage fields accurately', async () => {
    const res = await fetch(`http://127.0.0.1:${bridge!.proxyPort}/v1/systemone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer local',
        'TypeSafe-Danger-Zone-Images': 'true',
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: ['Customer ticket:', { id: 8821 }, '<image-1>'],
        assets: {
          '<image-1>': {
            type: 'image',
            format: 'jpg',
            data_base64: 'YWJjMTIz',
          },
        },
        questions: {
          route: {
            type: 'choice',
            instructions: 'Pick a queue.',
            criteria: {
              billing: 'Invoices and charges.',
              other: null,
            },
          },
          severity: {
            type: 'score',
            instructions: 'Rate severity.',
            criteria: ['Low', 'Medium', 'High'],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      answers: Record<string, Record<string, unknown>>;
      usage: { input_tokens: number; output_tokens: number; cost: number };
    };
    expect(body.model).toBe('gemini-decision-1');
    expect(body.answers.route?.choice).toBe('billing');
    expect(body.answers.severity?.score).toBe(1.15);
    expect(body.usage.input_tokens).toBe(120);
    expect(body.usage.output_tokens).toBe(0);
    expect(body.usage.cost).toBeCloseTo(0.000012, 9);

    const sent = recordedUpstream[0]!;
    expect(sent.headers['typesafe-danger-zone-images']).toBeUndefined();
    expect(sent.body?.input).toEqual([
      { type: 'text', text: 'Customer ticket:' },
      { type: 'text', text: '\n{"id":8821}' },
      { type: 'image', mime_type: 'image/jpeg', data: 'YWJjMTIz' },
    ]);
    const sentRoute = (sent.body?.questions as Record<string, Record<string, unknown>>).route;
    expect(sentRoute?.criteria).toEqual({
      billing: 'Invoices and charges.',
      other: '',
    });
  });

  it('refreshes expired Google OAuth tokens automatically while preserving sibling auth.json providers', async () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify(
        {
          anthropic: { type: 'key', key: 'keep-me-intact' },
          google: {
            type: 'oauth',
            access: 'ya29.expired-token',
            refresh: '1//refresh-token',
            expires: Date.now() - 60_000,
          },
        },
        null,
        2,
      ),
    );

    const res = await fetch(`http://127.0.0.1:${bridge!.proxyPort}/v1beta/decisions?key=DUMMY_KEY`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'DUMMY_KEY',
      },
      body: JSON.stringify({
        model: 'gemini-decision-1',
        input: 'Cracked screen on arrival.',
        questions: {
          damaged: {
            type: 'noul',
            instructions: 'Is the item damaged?',
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(tokenRefreshCount).toBe(1);
    const tokenCall = recordedUpstream.find((r) => r.url === '/token');
    expect(tokenCall?.body).toEqual({
      client_id: 'test-oauth-client-id',
      client_secret: 'test-oauth-client-secret',
      refresh_token: '1//refresh-token',
      grant_type: 'refresh_token',
    });
    const decisionCall = recordedUpstream.find((r) => r.url === '/v1beta/decisions');
    expect(decisionCall?.headers.authorization).toBe('Bearer ya29.refreshed-token');
    expect(decisionCall?.headers['x-goog-api-key']).toBeUndefined();

    const persisted = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(persisted.anthropic).toEqual({ type: 'key', key: 'keep-me-intact' });
    expect(persisted.google?.access).toBe('ya29.refreshed-token');
  });

  it('enforces service bearer auth and serves a schema-valid GuestStatusView on /status', async () => {
    const unauth = await fetch(`http://127.0.0.1:${bridge!.servicePort}/health`);
    expect(unauth.status).toBe(401);

    const authHeaders = { Authorization: 'Bearer test-service-secret' };
    const healthRes = await fetch(`http://127.0.0.1:${bridge!.servicePort}/health`, { headers: authHeaders });
    expect(healthRes.status).toBe(200);

    // Run two probes so the latency sparkline chart is also populated and schema-checked
    for (let i = 0; i < 2; i++) {
      const probeRes = await fetch(`http://127.0.0.1:${bridge!.servicePort}/status`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'probe' }),
      });
      expect(probeRes.status).toBe(200);
    }

    const statusRes = await fetch(`http://127.0.0.1:${bridge!.servicePort}/status`, { headers: authHeaders });
    expect(statusRes.status).toBe(200);
    const statusJson: unknown = await statusRes.json();
    const parsedStatus = guestStatusViewSchema.safeParse(statusJson);
    expect(parsedStatus.success).toBe(true);
    if (parsedStatus.success) {
      expect(parsedStatus.data.controls).toEqual([{ kind: 'button', id: 'probe', label: 'Test' }]);
      const endpointRow = parsedStatus.data.rows.find((r) => r.id === 'decisions-endpoint');
      const modelRow = parsedStatus.data.rows.find((r) => r.id === 'decisions-model');
      const requestsRow = parsedStatus.data.rows.find((r) => r.id === 'decisions-requests');
      const latencyRow = parsedStatus.data.rows.find((r) => r.id === 'decisions-latency');
      expect(endpointRow?.kind).toBe('line');
      if (endpointRow?.kind === 'line') {
        expect(endpointRow.value).toBe(`:${bridge!.proxyPort}`);
        expect(endpointRow.actions).toBeUndefined();
      }
      expect(modelRow?.kind).toBe('line');
      expect(requestsRow?.kind).toBe('line');
      if (requestsRow?.kind === 'line') {
        expect(requestsRow.value).toBe('2 ok');
        expect(requestsRow.content).toBeUndefined();
      }
      expect(latencyRow?.kind).toBe('line');
      if (latencyRow?.kind === 'line') {
        expect(latencyRow.content?.kind).toBe('chart');
        expect(latencyRow.value).toMatch(/^\d+ms$/);
      }
    }
  });

  it('throws a clear error on token refresh when GOOGLE_CLIENT_ID is unset', async () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        google: {
          type: 'oauth',
          access: 'ya29.expired-token',
          refresh: '1//refresh-token',
          expires: Date.now() - 60_000,
        },
      }),
    );

    const noClientBridge = await createBridgeServers({
      proxyPortOverride: 0,
      servicePortOverride: null,
      env: {
        OPENCODE_AUTH_PATH: authPath,
        BRIDGE_CONFIG_PATH: configPath,
        GEMINI_DECISIONS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1beta`,
        GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${upstreamPort}/token`,
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${noClientBridge.proxyPort}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: 'test',
          questions: { q: { type: 'noul', instructions: 'Yes or no?' } },
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain('GOOGLE_CLIENT_ID');
    } finally {
      await noClientBridge.close();
    }
  });

  it('omits x-goog-user-project when projectId is unset and supports config-file OAuth client credentials without clientSecret', async () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        google: {
          type: 'oauth',
          access: 'ya29.expired-token',
          refresh: '1//refresh-token',
          expires: Date.now() - 60_000,
        },
      }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        oauthClientId: 'config-client-id',
      }),
    );

    const noProjectBridge = await createBridgeServers({
      proxyPortOverride: 0,
      servicePortOverride: 0,
      env: {
        OPENCODE_AUTH_PATH: authPath,
        BRIDGE_CONFIG_PATH: configPath,
        GEMINI_DECISIONS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1beta`,
        GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${upstreamPort}/token`,
        OPENCHAMBER_SERVICE_TOKEN: 'test-service-secret',
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${noProjectBridge.proxyPort}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: 'hello',
          questions: { q: { type: 'noul', instructions: 'Yes or no?' } },
        }),
      });
      expect(res.status).toBe(200);

      const tokenCall = recordedUpstream.find((r) => r.url === '/token');
      expect(tokenCall?.body).toEqual({
        client_id: 'config-client-id',
        refresh_token: '1//refresh-token',
        grant_type: 'refresh_token',
      });
      const decisionCall = recordedUpstream.find((r) => r.url === '/v1beta/decisions');
      expect(decisionCall?.headers['x-goog-user-project']).toBeUndefined();

      const statusRes = await fetch(`http://127.0.0.1:${noProjectBridge.servicePort}/status`, {
        headers: { Authorization: 'Bearer test-service-secret' },
      });
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as { rows: Array<{ id: string; text?: string }> };
      const authNote = statusJson.rows.find((r) => r.id === 'auth-source');
      expect(authNote?.text).not.toContain('undefined');
      expect(authNote?.text).not.toContain('()');
    } finally {
      await noProjectBridge.close();
    }
  });
});

import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSelect,
  mountTabs,
  mountTextField,
  type BadgeHandle,
  type ButtonHandle,
  type SelectOption,
  type TabsHandle,
  type TextFieldHandle,
} from '@openchamber/sdk/ui';

interface PanelStateSnapshot {
  proxyPort: number;
  systemOneUrl: string;
  googleDecisionsUrl: string;
  opencodeBaseUrl: string;
  defaultModel: string;
  upstreamBaseUrl: string;
  configFile: string;
  auth: {
    configured: boolean;
    mode: 'oauth' | 'api-key' | 'missing';
    source: string;
    projectId?: string;
    expiresAt: number | null;
  };
  stats: {
    requests: number;
    successful: number;
    failed: number;
    totalInputTokens: number;
    lastDurationMs: number;
    avgDurationMs: number;
    healthy: boolean;
    lastSummary: string;
    lastError: string;
    latencyHistory: number[];
  };
  traces: Array<{
    id: string;
    timestamp: string;
    protocol: 'systemone' | 'google' | 'playground';
    durationMs: number;
    status: number;
    questionCount: number;
    inputTokens: number;
    summary: string;
    error?: string;
  }>;
}

interface AnswerPayload {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

interface EvaluationResult {
  durationMs: number;
  response: {
    model?: string;
    answers?: Record<string, AnswerPayload>;
    usage?: {
      input_tokens?: number;
      cost?: number;
    };
    error?: { message?: string };
  };
}

interface PresetItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly inputText: string;
  readonly questionsJson: string;
}

const PRESETS: ReadonlyArray<PresetItem> = [
  {
    id: 'triage',
    label: 'Multi-question triage',
    hint: 'noul + choice + score',
    inputText: 'Audio cuts out on the left earcup of my Gold-tier order #8821. Fix it today or I cancel my membership.',
    questionsJson: JSON.stringify(
      {
        is_defect: {
          type: 'noul',
          instructions: 'Does the customer message report a physical or hardware defect?',
          criteria: {
            true: 'Broken hardware, audio failure, or damaged part.',
            false: 'Billing, sizing, or preference complaint.',
          },
        },
        department: {
          type: 'choice',
          instructions: 'Which resolution path fits best?',
          criteria: {
            replacement_shipment: 'Ship a replacement unit for a confirmed hardware fault.',
            troubleshooting_flow: 'Minor setup question the user can solve themselves.',
            human_escalation: 'High churn risk or VIP escalation.',
          },
        },
        churn_risk: {
          type: 'score',
          instructions: 'How likely is the customer to churn if unresolved now?',
          criteria: ['No churn signal', 'Mild frustration', 'Mentions alternatives', 'Explicitly threatens to cancel'],
        },
      },
      null,
      2,
    ),
  },
  {
    id: 'routing',
    label: 'Agent model routing',
    hint: 'choice',
    inputText: 'Track down why concurrent WebSocket reconnects deadlock the session actor under packet loss.',
    questionsJson: JSON.stringify(
      {
        category: {
          type: 'choice',
          instructions: 'Select the engineering routing tier for this user prompt.',
          criteria: {
            trivial: 'Typos, renames, formatting, or one-line edits.',
            research: 'Read and explain code or docs without modifying files.',
            implement: 'Bounded feature, bug fix, refactor, or test.',
            hard: 'Concurrency invariants, unknown-cause bugs, or multi-system architecture.',
          },
        },
      },
      null,
      2,
    ),
  },
  {
    id: 'safety',
    label: 'Permission safety gate',
    hint: 'noul',
    inputText: JSON.stringify({
      permission: {
        type: 'bash',
        patterns: ['git push --force origin main'],
      },
    }),
    questionsJson: JSON.stringify(
      {
        ask: {
          type: 'noul',
          instructions: 'Should this command require explicit human confirmation before running?',
          criteria: {
            true: 'Mutates shared remote history, deletes data, or affects production state.',
            false: 'Read-only inspection or safe local build/test command.',
          },
        },
      },
      null,
      2,
    ),
  },
];

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let activeTab: 'playground' | 'status' | 'setup' = 'playground';
let selectedPresetId = PRESETS[0]!.id;
let draftInput = PRESETS[0]!.inputText;
let draftQuestions = PRESETS[0]!.questionsJson;
let draftJsonError: string | undefined;
let lastRequestedOrder: string[] = [];

let snapshot: PanelStateSnapshot | null = null;
let lastEval: EvaluationResult | null = null;
let evalError: string | null = null;
let isProbing = false;
let isEvaluating = false;
let shellMounted = false;

let authBadgeHandle: BadgeHandle | null = null;
let probeBtnHandle: ButtonHandle | null = null;
let tabsHandle: TabsHandle | null = null;
let inputFieldHandle: TextFieldHandle | null = null;
let questionsFieldHandle: TextFieldHandle | null = null;
let evaluateBtnHandle: ButtonHandle | null = null;
let tabBodyEl: HTMLElement | null = null;
let resultsContainerEl: HTMLElement | null = null;

function clearElement(el: Element): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

async function copySnippet(label: string, text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // Host toast below always offers a reliable Copy button inside the sandboxed frame.
  }
  try {
    await host.toast({
      kind: 'success',
      message: `${label} ready to copy`,
      copy: { text },
    });
  } catch {
    // Ignore when previewed outside OpenChamber host
  }
}

async function refreshState(): Promise<void> {
  try {
    const res = await host.serviceRequest({ method: 'GET', path: '/state' });
    if (res.status >= 200 && res.status < 300 && res.body) {
      snapshot = JSON.parse(res.body) as PanelStateSnapshot;
      syncHeaderState();
      if (activeTab !== 'playground') {
        renderActiveTab();
      }
    }
  } catch {
    // Keep existing UI state when previewed standalone
  }
}

async function runProbe(): Promise<void> {
  if (isProbing) return;
  isProbing = true;
  syncHeaderState();
  try {
    const res = await host.serviceRequest({ method: 'POST', path: '/probe', body: '{}' });
    const parsed = res.body ? (JSON.parse(res.body) as { ok?: boolean; durationMs?: number; error?: string }) : {};
    if (res.status >= 200 && res.status < 300 && parsed.ok) {
      await host.toast({
        kind: 'success',
        message: `gemini-decision-1 responded in ${parsed.durationMs ?? 0}ms`,
      });
    } else {
      await host.toast({
        kind: 'error',
        message: parsed.error || `Probe failed (${res.status})`,
      });
    }
  } catch (err) {
    try {
      await host.toast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Probe request failed',
      });
    } catch {
      // Ignore outside host
    }
  } finally {
    isProbing = false;
    await refreshState();
    syncHeaderState();
  }
}

async function runPlaygroundEvaluation(): Promise<void> {
  if (isEvaluating) return;
  let parsedQuestions: unknown;
  try {
    parsedQuestions = JSON.parse(draftQuestions);
    draftJsonError = undefined;
    questionsFieldHandle?.update({ error: undefined });
  } catch (err) {
    draftJsonError = err instanceof Error ? err.message : 'Invalid JSON in Questions';
    questionsFieldHandle?.update({ error: draftJsonError });
    return;
  }

  lastRequestedOrder =
    parsedQuestions && typeof parsedQuestions === 'object' && !Array.isArray(parsedQuestions)
      ? Object.keys(parsedQuestions as Record<string, unknown>)
      : [];

  isEvaluating = true;
  evalError = null;
  evaluateBtnHandle?.update({ loading: true, disabled: true });

  try {
    const res = await host.serviceRequest({
      method: 'POST',
      path: '/evaluate',
      body: JSON.stringify({
        state: draftInput,
        questions: parsedQuestions,
      }),
    });
    const parsed = res.body ? (JSON.parse(res.body) as EvaluationResult & { message?: string }) : null;
    if (res.status >= 200 && res.status < 300 && parsed?.response?.answers) {
      lastEval = parsed;
      evalError = null;
    } else {
      evalError = parsed?.response?.error?.message || parsed?.message || `Evaluation failed (${res.status})`;
    }
  } catch (err) {
    evalError = err instanceof Error ? err.message : 'Could not reach Gemini Decisions service';
  } finally {
    isEvaluating = false;
    evaluateBtnHandle?.update({ loading: false, disabled: false });
    renderPlaygroundResults();
    void refreshState();
  }
}

function syncHeaderState(): void {
  if (authBadgeHandle) {
    if (!snapshot) {
      authBadgeHandle.update({ label: 'Connecting', tone: 'neutral' });
    } else if (snapshot.auth.configured) {
      authBadgeHandle.update({
        label: snapshot.auth.mode === 'oauth' ? 'OAuth' : 'API Key',
        tone: snapshot.stats.healthy ? 'success' : 'warning',
      });
    } else {
      authBadgeHandle.update({ label: 'No Auth', tone: 'error' });
    }
  }

  probeBtnHandle?.update({ loading: isProbing, disabled: isProbing });
  tabsHandle?.update({
    items: [
      { id: 'playground', label: 'Playground' },
      { id: 'status', label: 'Status', ...(snapshot ? { count: snapshot.stats.requests } : {}) },
      { id: 'setup', label: 'Connect' },
    ],
    activeId: activeTab,
  });
}

function appendProbRow(
  parent: HTMLElement,
  label: string,
  prob: number,
  opts: { winner?: boolean; tone?: 'success' } = {},
): void {
  const row = document.createElement('div');
  row.className = 'gd-prob-row';

  const meta = document.createElement('div');
  meta.className = 'gd-prob-meta';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'gd-prob-name';
  nameSpan.textContent = label;
  nameSpan.title = label;
  if (opts.winner) nameSpan.dataset.winner = 'true';

  const numSpan = document.createElement('span');
  numSpan.className = 'gd-prob-num';
  numSpan.textContent = `${(prob * 100).toFixed(1)}%`;
  if (opts.winner) numSpan.dataset.winner = 'true';

  meta.appendChild(nameSpan);
  meta.appendChild(numSpan);

  const track = document.createElement('div');
  track.className = 'gd-prob-track';
  const fill = document.createElement('div');
  fill.className = 'gd-prob-fill';
  const pct = Math.max(0, Math.min(100, prob * 100));
  fill.style.width = pct > 0 && pct < 1 ? '2px' : `${pct.toFixed(2)}%`;
  if (opts.winner) fill.dataset.winner = 'true';
  if (opts.tone) fill.dataset.tone = opts.tone;
  track.appendChild(fill);

  row.appendChild(meta);
  row.appendChild(track);
  parent.appendChild(row);
}

function renderPlaygroundResults(): void {
  if (!resultsContainerEl) return;
  clearElement(resultsContainerEl);

  if (evalError) {
    const bannerWrap = document.createElement('div');
    resultsContainerEl.appendChild(bannerWrap);
    mountBanner(bannerWrap, {
      tone: 'error',
      title: 'Evaluation failed',
      body: evalError,
    });
    return;
  }

  const answers = lastEval?.response?.answers;
  if (!lastEval || !answers) {
    return;
  }

  const entries = Object.entries(answers).sort(([a], [b]) => {
    const ia = lastRequestedOrder.indexOf(a);
    const ib = lastRequestedOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const metaLabel = document.createElement('p');
  metaLabel.className = 'gd-subtle';
  const tokens = lastEval.response.usage?.input_tokens ?? 0;
  const qCount = entries.length;
  metaLabel.textContent = `${qCount} ${qCount === 1 ? 'question' : 'questions'} · ${lastEval.durationMs}ms · ${tokens} input tokens`;
  resultsContainerEl.appendChild(metaLabel);

  for (const [key, ans] of entries) {
    const card = document.createElement('div');
    card.className = 'gd-surface';

    const header = document.createElement('div');
    header.className = 'gd-answer-header';

    const keyEl = document.createElement('span');
    keyEl.className = 'gd-answer-key';
    keyEl.textContent = key;
    header.appendChild(keyEl);

    const badgeSlot = document.createElement('span');
    header.appendChild(badgeSlot);

    const probList = document.createElement('div');
    probList.className = 'gd-prob-list';

    if (ans.type === 'noul') {
      const pYes = ans.noul ?? 0;
      const yesWins = pYes >= 0.5;
      mountBadge(badgeSlot, {
        label: yesWins ? 'YES' : 'NO',
        tone: yesWins ? 'success' : 'neutral',
      });
      card.appendChild(header);
      appendProbRow(probList, 'true (yes)', pYes, {
        winner: yesWins,
        ...(yesWins ? { tone: 'success' } : {}),
      });
      appendProbRow(probList, 'false (no)', 1 - pYes, {
        winner: !yesWins,
      });
      card.appendChild(probList);
    } else if (ans.type === 'choice') {
      const conf = ans.confidence ?? 0;
      mountBadge(badgeSlot, {
        label: ans.choice ?? 'choice',
        tone: conf >= 0.7 ? 'primary' : 'warning',
      });
      card.appendChild(header);

      const sorted = Object.entries(ans.probabilities ?? {}).sort(([, a], [, b]) => b - a);
      for (const [optKey, prob] of sorted) {
        appendProbRow(probList, optKey, prob, { winner: optKey === ans.choice });
      }
      card.appendChild(probList);
    } else if (ans.type === 'score') {
      const scoreVal = ans.score ?? 0;
      mountBadge(badgeSlot, {
        label: `Score ${scoreVal.toFixed(2)}`,
        tone: 'info',
      });
      card.appendChild(header);

      const scoreEntries = Object.entries(ans.probabilities ?? {}).sort(([a], [b]) => Number(a) - Number(b));
      const maxProb = scoreEntries.reduce((acc, [, p]) => Math.max(acc, p), -1);
      for (const [idx, prob] of scoreEntries) {
        const desc = ans.legend?.[idx];
        const rowLabel = desc ? `[${idx}] ${desc}` : `Level ${idx}`;
        appendProbRow(probList, rowLabel, prob, { winner: prob === maxProb && maxProb > 0 });
      }
      card.appendChild(probList);
    }

    resultsContainerEl.appendChild(card);
  }
}

function renderPlaygroundTab(container: HTMLElement): void {
  const formCard = document.createElement('div');
  formCard.className = 'gd-surface';

  const presetSlot = document.createElement('div');
  const options: SelectOption[] = PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
  }));

  const selectHandle = mountSelect(presetSlot, {
    label: 'Preset scenario',
    value: selectedPresetId,
    options,
    onChange: (nextId) => {
      selectedPresetId = nextId;
      selectHandle.update({ value: nextId });
      const found = PRESETS.find((p) => p.id === nextId);
      if (found) {
        draftInput = found.inputText;
        draftQuestions = found.questionsJson;
        draftJsonError = undefined;
        inputFieldHandle?.update({ value: draftInput });
        questionsFieldHandle?.update({ value: draftQuestions, error: undefined });
      }
    },
  });
  formCard.appendChild(presetSlot);

  const inputSlot = document.createElement('div');
  inputFieldHandle = mountTextField(inputSlot, {
    label: 'Shared input context',
    value: draftInput,
    multiline: true,
    rows: 3,
    onChange: (val) => {
      draftInput = val;
    },
  });
  formCard.appendChild(inputSlot);

  const questionsSlot = document.createElement('div');
  questionsFieldHandle = mountTextField(questionsSlot, {
    label: 'Questions map (noul, choice, score)',
    value: draftQuestions,
    multiline: true,
    rows: 8,
    mono: true,
    error: draftJsonError,
    onChange: (val) => {
      draftQuestions = val;
      if (draftJsonError) {
        draftJsonError = undefined;
        questionsFieldHandle?.update({ error: undefined });
      }
    },
  });
  formCard.appendChild(questionsSlot);

  const actionRow = document.createElement('div');
  actionRow.className = 'gd-action-row';
  const note = document.createElement('p');
  note.className = 'gd-subtle';
  note.textContent = 'Single forward pass · $0.10 / 1M input tok';
  const evalBtnSlot = document.createElement('div');
  evaluateBtnHandle = mountButton(evalBtnSlot, {
    label: 'Evaluate',
    variant: 'default',
    size: 'sm',
    loading: isEvaluating,
    disabled: isEvaluating,
    onClick: () => {
      void runPlaygroundEvaluation();
    },
  });
  actionRow.appendChild(note);
  actionRow.appendChild(evalBtnSlot);
  formCard.appendChild(actionRow);

  container.appendChild(formCard);

  resultsContainerEl = document.createElement('div');
  resultsContainerEl.className = 'gd-stack';
  container.appendChild(resultsContainerEl);
  renderPlaygroundResults();
}

function renderStatusTab(container: HTMLElement): void {
  if (!snapshot) {
    const emptySlot = document.createElement('div');
    mountEmpty(emptySlot, {
      title: 'Waiting for bridge service',
      body: 'Approve the extension service in OpenChamber to start the local proxy on 127.0.0.1:4006.',
      action: {
        label: 'Retry',
        onClick: () => {
          void refreshState();
        },
      },
    });
    container.appendChild(emptySlot);
    return;
  }

  if (!snapshot.auth.configured) {
    const warnSlot = document.createElement('div');
    mountBanner(warnSlot, {
      tone: 'warning',
      title: 'Google OAuth credentials not found',
      body: `Expected credentials at ${snapshot.auth.source}. Authenticate Google in OpenCode or set apiKey in ${snapshot.configFile}.`,
    });
    container.appendChild(warnSlot);
  } else if (snapshot.stats.lastError) {
    const errSlot = document.createElement('div');
    mountBanner(errSlot, {
      tone: 'error',
      title: 'Latest upstream error',
      body: snapshot.stats.lastError,
    });
    container.appendChild(errSlot);
  }

  const metricsCard = document.createElement('div');
  metricsCard.className = 'gd-surface';
  const grid = document.createElement('div');
  grid.className = 'gd-kv-grid';

  const statsItems: Array<{ label: string; value: string; mono?: boolean; wide?: boolean }> = [
    { label: 'Local Proxy', value: `127.0.0.1:${snapshot.proxyPort}`, mono: true },
    { label: 'Model', value: snapshot.defaultModel, mono: true },
    { label: 'Requests', value: `${snapshot.stats.requests} (${snapshot.stats.successful} ok)` },
    { label: 'Avg Latency', value: snapshot.stats.successful > 0 ? `${snapshot.stats.avgDurationMs}ms` : '—' },
    { label: 'Input Tokens', value: snapshot.stats.totalInputTokens.toLocaleString() },
    { label: 'Project', value: snapshot.auth.projectId || '(unset)', mono: true },
    { label: 'Auth Source', value: snapshot.auth.source, mono: true, wide: true },
  ];

  for (const item of statsItems) {
    const tile = document.createElement('div');
    tile.className = 'gd-stat';
    if (item.wide) tile.dataset.wide = 'true';
    const l = document.createElement('div');
    l.className = 'gd-stat-label';
    l.textContent = item.label;
    const v = document.createElement('div');
    v.className = 'gd-stat-value';
    if (item.mono) v.dataset.mono = 'true';
    v.textContent = item.value;
    v.title = item.value;
    tile.appendChild(l);
    tile.appendChild(v);
    grid.appendChild(tile);
  }
  metricsCard.appendChild(grid);
  container.appendChild(metricsCard);

  const tracesCard = document.createElement('div');
  tracesCard.className = 'gd-surface';
  const traceTitle = document.createElement('div');
  traceTitle.className = 'gd-section-title';
  traceTitle.textContent = 'Recent Decisions';
  tracesCard.appendChild(traceTitle);

  if (snapshot.traces.length === 0) {
    const emptySlot = document.createElement('div');
    mountEmpty(emptySlot, {
      title: 'No decisions recorded yet',
      body: 'Run a test probe or evaluate a question in the Playground tab.',
      action: {
        label: 'Run Probe',
        onClick: () => {
          void runProbe();
        },
      },
    });
    tracesCard.appendChild(emptySlot);
  } else {
    const traceList = document.createElement('div');
    traceList.className = 'gd-trace-list';

    for (const t of snapshot.traces) {
      const row = document.createElement('div');
      row.className = 'gd-trace-row';

      const top = document.createElement('div');
      top.className = 'gd-trace-top';

      const summary = document.createElement('span');
      summary.className = 'gd-trace-summary';
      const summaryText = t.summary || t.error || `${t.questionCount} question(s)`;
      summary.textContent = summaryText;
      summary.title = summaryText;

      const right = document.createElement('span');
      right.className = 'gd-trace-right';
      if (t.status >= 400) {
        const errBadgeSlot = document.createElement('span');
        mountBadge(errBadgeSlot, { label: String(t.status), tone: 'error' });
        right.appendChild(errBadgeSlot);
      }
      const ms = document.createElement('span');
      ms.className = 'gd-trace-ms';
      ms.textContent = `${t.durationMs}ms`;
      right.appendChild(ms);

      top.appendChild(summary);
      top.appendChild(right);

      const sub = document.createElement('div');
      sub.className = 'gd-trace-sub';
      sub.textContent = `${t.protocol} · ${t.inputTokens} tok · ${new Date(t.timestamp).toLocaleTimeString()}`;

      row.appendChild(top);
      row.appendChild(sub);
      traceList.appendChild(row);
    }

    tracesCard.appendChild(traceList);
  }

  container.appendChild(tracesCard);
}

function renderSetupTab(container: HTMLElement): void {
  const port = snapshot?.proxyPort ?? 4006;
  const model = snapshot?.defaultModel ?? 'gemini-decision-1';
  const systemOneUrl = `http://127.0.0.1:${port}/v1/systemone`;
  const googleUrl = `http://127.0.0.1:${port}/v1beta/decisions`;

  const opencodeSnippet = JSON.stringify(
    {
      providers: {
        'gemini-decisions': {
          name: 'Gemini Decisions Bridge (OAuth)',
          settings: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            apiKey: 'local',
          },
          models: {
            [model]: {
              name: 'Gemini Decision 1 (OAuth)',
              modelID: model,
              type: 'decision',
              package: '@opencode/ai/providers/typesafe-ai/decisions',
            },
          },
        },
      },
    },
    null,
    2,
  );

  const sections = [
    {
      title: '1. OpenChamber Classification',
      desc: 'Settings → Providers → Classification providers → Custom endpoint (routes prompts, permission checks, turn-end hints, and goal audits):',
      code: `URL:   ${systemOneUrl}\nModel: ${model}`,
      btnLabel: 'Copy URL',
      copyLabel: 'SystemOne URL',
      copyValue: systemOneUrl,
    },
    {
      title: '2. OpenCode Decision Provider',
      desc: 'Add to ~/.config/opencode/opencode.jsonc (OpenCode v2.2.7+; allow "gemini-decisions" in policies):',
      code: opencodeSnippet,
      btnLabel: 'Copy JSON',
      copyLabel: 'OpenCode config',
      copyValue: opencodeSnippet,
    },
    {
      title: '3. Google Decisions API',
      desc: 'Direct v1beta/decisions passthrough with automatic OAuth Bearer + x-goog-user-project injection:',
      code: `POST ${googleUrl}`,
      btnLabel: 'Copy URL',
      copyLabel: 'Google Decisions URL',
      copyValue: googleUrl,
    },
  ];

  for (const sec of sections) {
    const card = document.createElement('div');
    card.className = 'gd-surface';

    const top = document.createElement('div');
    top.className = 'gd-card-header';
    const heading = document.createElement('span');
    heading.className = 'gd-section-title';
    heading.textContent = sec.title;
    const btnSlot = document.createElement('div');
    mountButton(btnSlot, {
      label: sec.btnLabel,
      size: 'xs',
      variant: 'outline',
      onClick: () => {
        void copySnippet(sec.copyLabel, sec.copyValue);
      },
    });
    top.appendChild(heading);
    top.appendChild(btnSlot);
    card.appendChild(top);

    const p = document.createElement('p');
    p.className = 'gd-subtle';
    p.textContent = sec.desc;
    card.appendChild(p);

    const pre = document.createElement('pre');
    pre.className = 'gd-code';
    pre.textContent = sec.code;
    card.appendChild(pre);

    container.appendChild(card);
  }
}

function renderActiveTab(): void {
  if (!tabBodyEl) return;
  inputFieldHandle = null;
  questionsFieldHandle = null;
  evaluateBtnHandle = null;
  resultsContainerEl = null;
  clearElement(tabBodyEl);

  if (activeTab === 'playground') {
    renderPlaygroundTab(tabBodyEl);
  } else if (activeTab === 'status') {
    renderStatusTab(tabBodyEl);
  } else {
    renderSetupTab(tabBodyEl);
  }
}

function mountShell(): void {
  if (shellMounted) return;
  shellMounted = true;

  const header = document.createElement('div');
  header.className = 'gd-header';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'gd-title-group';
  const title = document.createElement('h1');
  title.className = 'gd-title';
  title.textContent = 'Gemini Decisions';
  const badgeSlot = document.createElement('span');
  authBadgeHandle = mountBadge(badgeSlot, { label: 'Connecting', tone: 'neutral' });
  titleGroup.appendChild(title);
  titleGroup.appendChild(badgeSlot);

  const actions = document.createElement('div');
  actions.className = 'gd-actions';
  const probeSlot = document.createElement('span');
  probeBtnHandle = mountButton(probeSlot, {
    label: 'Test',
    size: 'xs',
    variant: 'outline',
    onClick: () => {
      void runProbe();
    },
  });
  const refreshSlot = document.createElement('span');
  mountButton(refreshSlot, {
    label: 'Refresh',
    size: 'xs',
    variant: 'ghost',
    onClick: () => {
      void refreshState();
    },
  });
  actions.appendChild(probeSlot);
  actions.appendChild(refreshSlot);

  header.appendChild(titleGroup);
  header.appendChild(actions);
  root.appendChild(header);

  const tabsSlot = document.createElement('div');
  tabsHandle = mountTabs(tabsSlot, {
    items: [
      { id: 'playground', label: 'Playground' },
      { id: 'status', label: 'Status' },
      { id: 'setup', label: 'Connect' },
    ],
    activeId: activeTab,
    trackBackground: true,
    onChange: (nextId) => {
      if (nextId === 'playground' || nextId === 'status' || nextId === 'setup') {
        activeTab = nextId;
        syncHeaderState();
        renderActiveTab();
      }
    },
  });
  root.appendChild(tabsSlot);

  tabBodyEl = document.createElement('div');
  tabBodyEl.className = 'gd-stack';
  root.appendChild(tabBodyEl);

  renderActiveTab();
  void refreshState();
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  mountShell();
});

if (window.parent === window) {
  mountShell();
}

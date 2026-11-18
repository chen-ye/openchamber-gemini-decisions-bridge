import crypto from 'node:crypto';

const INPUT_COST_PER_MILLION_USD = 0.1;

export type GoogleContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image' | 'audio' | 'video' | 'document';
      readonly mime_type: string;
      readonly data?: string;
      readonly uri?: string;
      readonly resolution?: 'low' | 'medium' | 'high' | 'ultra_high';
    };

export type GoogleQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: string;
      readonly criteria?: {
        readonly true_description?: string;
        readonly false_description?: string;
      };
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      readonly criteria: ReadonlyArray<string>;
    };

export interface GoogleDecisionRequest {
  readonly model: string;
  readonly input: ReadonlyArray<GoogleContentBlock> | string;
  readonly questions: Readonly<Record<string, GoogleQuestion>>;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface GoogleDecisionUsage {
  readonly total_input_tokens?: number;
  readonly total_output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_by_modality?: ReadonlyArray<{ readonly modality: string; readonly tokens: number }>;
}

export interface GoogleDecisionResponse {
  readonly answers: Readonly<Record<string, Record<string, unknown>>>;
  readonly usage?: GoogleDecisionUsage;
}

export interface SystemOneResponse {
  readonly id: string;
  readonly model: string;
  readonly provider: 'google';
  readonly answers: Readonly<Record<string, Record<string, unknown>>>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
    readonly cost: number;
    readonly total_input_tokens: number;
    readonly total_output_tokens: number;
    readonly input_tokens_by_modality?: ReadonlyArray<{ readonly modality: string; readonly tokens: number }>;
  };
}

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampProbability(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, num));
}

/** Resolves caller model aliases (`jev-*`, `torchcast-*`, `google/...`, `models/...`) to a valid Gemini Decisions model ID. */
export function resolveUpstreamModel(requested: unknown, defaultModel: string): string {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return defaultModel;
  }
  const stripped = requested
    .trim()
    .replace(/^google\//i, '')
    .replace(/^models\//i, '');

  if (
    stripped.startsWith('gemini-decision')
  ) {
    return stripped;
  }
  return defaultModel;
}

function mediaBlockKindFromMime(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'application/pdf') return 'document';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  throw new ProtocolValidationError(`Unsupported media MIME type for Gemini Decisions API: ${mimeType}`);
}

function parseDataUrlBlock(dataUrl: string): GoogleContentBlock {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match || !match[1] || !match[2]) {
    throw new ProtocolValidationError('Expected base64 data URL (data:<mime>;base64,...) for inline media.');
  }
  const mimeType = match[1].toLowerCase();
  return {
    type: mediaBlockKindFromMime(mimeType),
    mime_type: mimeType,
    data: match[2],
  };
}

function guessMimeFromUrl(url: string, fallback: string): string {
  const pathname = url.split('?')[0]?.toLowerCase() ?? '';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.pdf')) return 'application/pdf';
  if (pathname.endsWith('.mp3')) return 'audio/mp3';
  if (pathname.endsWith('.wav')) return 'audio/wav';
  if (pathname.endsWith('.ogg')) return 'audio/ogg';
  if (pathname.endsWith('.mp4')) return 'video/mp4';
  if (pathname.endsWith('.webm')) return 'video/webm';
  if (pathname.endsWith('.mov')) return 'video/mov';
  return fallback;
}

function normalizeImageFormatMime(format: string): string {
  const clean = format.trim().toLowerCase().replace(/^image\//, '');
  if (clean === 'jpg') return 'image/jpeg';
  return `image/${clean || 'png'}`;
}

function normalizeAudioFormatMime(format: string): string {
  const clean = format.trim().toLowerCase();
  if (clean.includes('/')) return clean;
  return `audio/${clean || 'wav'}`;
}

function assetRefToBlock(asset: unknown): GoogleContentBlock {
  if (!isPlainRecord(asset)) {
    throw new ProtocolValidationError('Invalid SystemOne asset entry.');
  }
  if (typeof asset.data_base64 === 'string') {
    const mimeType = normalizeImageFormatMime(typeof asset.format === 'string' ? asset.format : 'png');
    return {
      type: mediaBlockKindFromMime(mimeType),
      mime_type: mimeType,
      data: asset.data_base64,
    };
  }
  throw new ProtocolValidationError('SystemOne asset entry is missing data_base64.');
}

function stateItemToBlock(item: unknown, assets: Record<string, unknown> | undefined): GoogleContentBlock {
  if (typeof item === 'string') {
    if (assets && Object.hasOwn(assets, item)) {
      return assetRefToBlock(assets[item]);
    }
    return { type: 'text', text: item };
  }

  if (isPlainRecord(item)) {
    if (item.type === 'text' && typeof item.text === 'string') {
      return { type: 'text', text: item.text };
    }

    if (
      (item.type === 'image' || item.type === 'audio' || item.type === 'video' || item.type === 'document') &&
      typeof item.mime_type === 'string' &&
      (typeof item.data === 'string' || typeof item.uri === 'string')
    ) {
      const resolution = item.resolution;
      return {
        type: item.type,
        mime_type: item.mime_type.toLowerCase(),
        ...(typeof item.data === 'string' ? { data: item.data } : {}),
        ...(typeof item.uri === 'string' ? { uri: item.uri } : {}),
        ...(resolution === 'low' || resolution === 'medium' || resolution === 'high' || resolution === 'ultra_high'
          ? { resolution }
          : {}),
      };
    }

    if (item.type === 'image_url' && isPlainRecord(item.image_url) && typeof item.image_url.url === 'string') {
      const url = item.image_url.url;
      if (url.startsWith('data:')) return parseDataUrlBlock(url);
      return { type: 'image', mime_type: guessMimeFromUrl(url, 'image/jpeg'), uri: url };
    }

    if (item.type === 'video_url' && isPlainRecord(item.video_url) && typeof item.video_url.url === 'string') {
      const url = item.video_url.url;
      if (url.startsWith('data:')) return parseDataUrlBlock(url);
      return { type: 'video', mime_type: guessMimeFromUrl(url, 'video/mp4'), uri: url };
    }

    if (
      item.type === 'input_audio' &&
      isPlainRecord(item.input_audio) &&
      typeof item.input_audio.data === 'string'
    ) {
      const format = typeof item.input_audio.format === 'string' ? item.input_audio.format : 'wav';
      return {
        type: 'audio',
        mime_type: normalizeAudioFormatMime(format),
        data: item.input_audio.data,
      };
    }

    return { type: 'text', text: JSON.stringify(item) };
  }

  return { type: 'text', text: JSON.stringify(item ?? null) };
}

/** Inserts a leading newline between adjacent text blocks because Google concatenates text blocks without a separator. */
export function separateAdjacentTextBlocks(
  blocks: ReadonlyArray<GoogleContentBlock>,
): ReadonlyArray<GoogleContentBlock> {
  return blocks.map((block, index) => {
    const prev = index > 0 ? blocks[index - 1] : undefined;
    if (block.type === 'text' && prev?.type === 'text' && !block.text.startsWith('\n')) {
      return { type: 'text', text: `\n${block.text}` };
    }
    return block;
  });
}

function extractStateBlocks(body: Record<string, unknown>): ReadonlyArray<GoogleContentBlock> {
  const assets = isPlainRecord(body.assets) ? body.assets : undefined;
  const blocks: GoogleContentBlock[] = [];

  if (body.state !== undefined) {
    const state = body.state;
    if (typeof state === 'string') {
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
        } else if (isPlainRecord(msg) && typeof msg.content === 'string') {
          blocks.push({ type: 'text', text: msg.content });
        } else {
          blocks.push({ type: 'text', text: JSON.stringify(msg) });
        }
      }
    } else {
      blocks.push({ type: 'text', text: JSON.stringify(state) });
    }
  } else if (body.input !== undefined) {
    const input = body.input;
    if (typeof input === 'string') {
      blocks.push({ type: 'text', text: input });
    } else if (Array.isArray(input)) {
      for (const item of input) {
        blocks.push(stateItemToBlock(item, assets));
      }
    } else {
      blocks.push(stateItemToBlock(input, assets));
    }
  } else {
    throw new ProtocolValidationError('Decision request requires either `state` or `input`.');
  }

  for (const rootField of ['images', 'audio', 'videos'] as const) {
    const mediaList = body[rootField];
    if (Array.isArray(mediaList)) {
      for (const entry of mediaList) {
        if (typeof entry === 'string') {
          if (entry.startsWith('data:')) {
            blocks.push(parseDataUrlBlock(entry));
          } else {
            const fallbackMime =
              rootField === 'images' ? 'image/jpeg' : rootField === 'audio' ? 'audio/wav' : 'video/mp4';
            const mimeType = guessMimeFromUrl(entry, fallbackMime);
            blocks.push({
              type: mediaBlockKindFromMime(mimeType),
              mime_type: mimeType,
              uri: entry,
            });
          }
        }
      }
    }
  }

  const normalized = separateAdjacentTextBlocks(blocks);
  if (normalized.length === 0) {
    throw new ProtocolValidationError('Decision input cannot be empty.');
  }
  if (normalized.length === 1 && normalized[0]?.type === 'text' && normalized[0].text.length === 0) {
    return [{ type: 'text', text: ' ' }];
  }
  return normalized;
}

function normalizeInstructions(raw: unknown, questionKey: string): string {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const parts = raw
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (isPlainRecord(entry) && typeof entry.text === 'string') return entry.text;
        return '';
      })
      .filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  }
  throw new ProtocolValidationError(`Question "${questionKey}" is missing non-empty text instructions.`);
}

function translateQuestion(questionKey: string, raw: unknown): GoogleQuestion {
  if (!isPlainRecord(raw)) {
    throw new ProtocolValidationError(`Question "${questionKey}" must be an object.`);
  }

  const instructions = normalizeInstructions(raw.instructions, questionKey);
  const type = raw.type;

  if (type === 'noul' || type === 'predicate') {
    const rawCriteria = isPlainRecord(raw.criteria) ? raw.criteria : undefined;
    const trueDesc =
      typeof rawCriteria?.true_description === 'string'
        ? rawCriteria.true_description
        : typeof rawCriteria?.true === 'string'
          ? rawCriteria.true
          : undefined;
    const falseDesc =
      typeof rawCriteria?.false_description === 'string'
        ? rawCriteria.false_description
        : typeof rawCriteria?.false === 'string'
          ? rawCriteria.false
          : undefined;

    const criteria =
      trueDesc !== undefined || falseDesc !== undefined
        ? {
            ...(trueDesc !== undefined ? { true_description: trueDesc } : {}),
            ...(falseDesc !== undefined ? { false_description: falseDesc } : {}),
          }
        : undefined;

    return {
      type: 'noul',
      instructions,
      ...(criteria ? { criteria } : {}),
    };
  }

  if (type === 'choice') {
    if (!isPlainRecord(raw.criteria)) {
      throw new ProtocolValidationError(`Choice question "${questionKey}" requires a criteria object.`);
    }
    const entries = Object.entries(raw.criteria);
    if (entries.length < 2) {
      throw new ProtocolValidationError(`Choice question "${questionKey}" requires at least 2 options.`);
    }
    const criteria: Record<string, string> = {};
    for (const [optKey, desc] of entries) {
      criteria[optKey] = typeof desc === 'string' ? desc : desc === null || desc === undefined ? '' : String(desc);
    }
    return {
      type: 'choice',
      instructions,
      criteria,
    };
  }

  if (type === 'score') {
    if (!Array.isArray(raw.criteria) || raw.criteria.length < 2) {
      throw new ProtocolValidationError(`Score question "${questionKey}" requires a criteria array with >= 2 levels.`);
    }
    return {
      type: 'score',
      instructions,
      criteria: raw.criteria.map((level) => String(level)),
    };
  }

  throw new ProtocolValidationError(`Unsupported question type "${String(type)}" on "${questionKey}".`);
}

/** Translates a SystemOne / OpenChamber Jev request payload into a Google `/v1beta/decisions` payload. */
export function translateSystemOneToGoogle(
  rawBody: unknown,
  defaultModel: string = 'gemini-decision-1',
): GoogleDecisionRequest {
  if (!isPlainRecord(rawBody)) {
    throw new ProtocolValidationError('Request body must be a JSON object.');
  }

  if (!isPlainRecord(rawBody.questions) || Object.keys(rawBody.questions).length === 0) {
    throw new ProtocolValidationError('Request body requires a non-empty `questions` map.');
  }

  const model = resolveUpstreamModel(rawBody.model, defaultModel);
  const input = extractStateBlocks(rawBody);
  const questions: Record<string, GoogleQuestion> = {};

  for (const [key, qVal] of Object.entries(rawBody.questions)) {
    questions[key] = translateQuestion(key, qVal);
  }

  const labels =
    isPlainRecord(rawBody.labels) && Object.values(rawBody.labels).every((v) => typeof v === 'string')
      ? (rawBody.labels as Record<string, string>)
      : undefined;

  return {
    model,
    input,
    questions,
    ...(labels ? { labels } : {}),
  };
}

/** Normalizes a native Google `/v1beta/decisions` request payload while preserving native fields. */
export function normalizeNativeGoogleDecisionRequest(
  rawBody: unknown,
  defaultModel: string = 'gemini-decision-1',
): Record<string, unknown> {
  if (!isPlainRecord(rawBody)) {
    throw new ProtocolValidationError('Request body must be a JSON object.');
  }
  if (rawBody.input === undefined) {
    throw new ProtocolValidationError('Native Google Decisions request requires `input`.');
  }
  if (!isPlainRecord(rawBody.questions) || Object.keys(rawBody.questions).length === 0) {
    throw new ProtocolValidationError('Native Google Decisions request requires a non-empty `questions` map.');
  }

  return {
    ...rawBody,
    model: resolveUpstreamModel(rawBody.model, defaultModel),
  };
}

function normalizeAnswerProbabilities(answer: Record<string, unknown>): Record<string, unknown> {
  const type = answer.type;
  if (type === 'noul') {
    const noul = clampProbability(answer.noul);
    const confidence =
      typeof answer.confidence === 'number' ? clampProbability(answer.confidence) : Math.max(noul, 1 - noul);
    return {
      ...answer,
      type: 'noul',
      noul,
      confidence,
    };
  }

  if (type === 'choice' || type === 'score') {
    const rawProbs = isPlainRecord(answer.probabilities) ? answer.probabilities : {};
    const probabilities: Record<string, number> = {};
    for (const [key, val] of Object.entries(rawProbs)) {
      probabilities[key] = clampProbability(val);
    }
    return {
      ...answer,
      probabilities,
      confidence: clampProbability(answer.confidence),
    };
  }

  return answer;
}

/** Translates a Google `/v1beta/decisions` response into a strict SystemOne response for OpenChamber and OpenCode. */
export function translateGoogleToSystemOne(
  googleResponse: unknown,
  modelId: string,
): SystemOneResponse {
  if (!isPlainRecord(googleResponse) || !isPlainRecord(googleResponse.answers)) {
    throw new Error('Upstream Google Decisions response is missing `answers`.');
  }

  const answers: Record<string, Record<string, unknown>> = {};
  for (const [key, rawAns] of Object.entries(googleResponse.answers)) {
    if (isPlainRecord(rawAns)) {
      answers[key] = normalizeAnswerProbabilities(rawAns);
    }
  }

  const rawUsage = isPlainRecord(googleResponse.usage) ? (googleResponse.usage as GoogleDecisionUsage) : undefined;
  const inputTokens = typeof rawUsage?.total_input_tokens === 'number' ? rawUsage.total_input_tokens : 0;
  const outputTokens = typeof rawUsage?.total_output_tokens === 'number' ? rawUsage.total_output_tokens : 0;
  const totalTokens = typeof rawUsage?.total_tokens === 'number' ? rawUsage.total_tokens : inputTokens + outputTokens;
  const cost = Number(((inputTokens * INPUT_COST_PER_MILLION_USD) / 1_000_000).toFixed(9));

  return {
    id: `gdec_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    model: modelId,
    provider: 'google',
    answers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cost,
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      ...(Array.isArray(rawUsage?.input_tokens_by_modality)
        ? { input_tokens_by_modality: rawUsage.input_tokens_by_modality }
        : {}),
    },
  };
}

/** Formats a compact human-readable summary of evaluated answers for status rows and trace logs. */
export function summarizeAnswers(answers: Readonly<Record<string, Record<string, unknown>>>): string {
  const parts: string[] = [];
  for (const [key, ans] of Object.entries(answers)) {
    if (ans.type === 'choice' && typeof ans.choice === 'string') {
      const pct = typeof ans.confidence === 'number' ? ` ${Math.round(ans.confidence * 100)}%` : '';
      parts.push(`${key}=${ans.choice}${pct}`);
    } else if (ans.type === 'noul' && typeof ans.noul === 'number') {
      parts.push(`${key}=${ans.noul.toFixed(2)}`);
    } else if (ans.type === 'score' && typeof ans.score === 'number') {
      parts.push(`${key}=${ans.score.toFixed(2)}`);
    }
  }
  return parts.join(', ').slice(0, 120);
}

/**
 * Client HTTP OmniRoute — surface **OpenAI Chat Completions** (`POST
 * {baseUrl}/v1/chat/completions`).
 *
 * C'est le cœur d'ACC-2105 : ne plus passer par la traduction Anthropic
 * Messages, pour que `reasoning_effort`, `cache_control_points` et les options
 * fournisseur partent vraiment à la passerelle.
 *
 * Points mesurés sur l'instance de l'agence, à ne pas régresser :
 *
 * 1. **OmniRoute exige `Authorization: Bearer`.** `x-api-key` est refusé (401).
 * 2. **Le flux est du SSE OpenAI** (`data: {…}` puis `data: [DONE]`), avec des
 *    chunks parfois vides. `stream_options.include_usage` fait arriver l'usage
 *    sur un chunk dédié, souvent sans `choices`.
 * 3. La fabrication du corps et la projection des chunks vivent dans
 *    `chat-completions.ts` (pur, testé) ; ce fichier ne fait que du HTTP+SSE.
 */
import { calculateModelCostUsd } from './pricing.js';
import {
  asCost,
  buildChatCompletionsPayload,
  projectChunk,
  toPaperclipUsage,
  type ChatCompletionsChunk,
  type ReasoningEffort,
} from './chat-completions.js';
import { classifyGatewayError, type ClassifiedGatewayError } from './errors.js';
import type { UsageTotals, WireMessage, WireToolSpec } from './wire.js';

export type { WireContentBlock, WireMessage, WireToolSpec, UsageTotals } from './wire.js';

export interface StreamCallbacks {
  /** Texte de l'assistant, au fil de l'eau. */
  onTextDelta?(text: string): void;
  /** Raisonnement étendu, au fil de l'eau. */
  onThinkingDelta?(text: string): void;
  /** Appel d'outil complet (les `input` ne sont exploitables qu'à ce moment). */
  onToolUse?(block: { id: string; name: string; input: unknown }): void;
}

export interface StreamResult {
  content: import('./wire.js').WireContentBlock[];
  stopReason: string | null;
  usage: UsageTotals;
  model: string | null;
  /** Valeur de `X-OmniRoute-*` : routage et coût estimé côté passerelle. */
  gatewayHeaders: Record<string, string>;
  /** Coût USD du tour : `usage.cost` du flux, sinon barème officiel ; `null` si inconnu. */
  costUsd: number | null;
  /** Provenance comptable : rapporté directement par la passerelle ou calculé via barème officiel. */
  costSource?: 'provider_reported' | 'rate_card';
}

/** Erreur portant la classification Paperclip, pour ne pas re-deviner plus haut. */
export class OmniRouteError extends Error {
  readonly classified: ClassifiedGatewayError;
  readonly status: number | null;

  constructor(message: string, classified: ClassifiedGatewayError, status: number | null) {
    super(message);
    this.name = 'OmniRouteError';
    this.classified = classified;
    this.status = status;
  }
}

/**
 * Lot 18b — surveillance d'un flux figé. Sans elle, un flux muet (socket
 * ouvert, plus rien) ou qui n'envoie que des keepalives bloquait le run jusqu'à
 * son délai global (1 h depuis le lot 7).
 * - inactivité : aucun octet reçu pendant ce délai → erreur transitoire ;
 * - progression : rien d'utile (texte, raisonnement, outil, fin, usage) pendant
 *   ce délai, keepalives compris → erreur transitoire. OmniRoute envoie des
 *   keepalives `{"model":"keepalive"}` pendant qu'un combo essaie ses cibles.
 * Une erreur transitoire déclenche le repli `fallbackModel` s'il est réglé.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3 * 60_000;
export const DEFAULT_STREAM_PROGRESS_TIMEOUT_MS = 10 * 60_000;
/** Nom de modèle des chunks de maintien de connexion d'OmniRoute. */
const KEEPALIVE_MODEL = 'keepalive';

export interface OmniRouteClientOptions {
  /** Lot 18b : délai sans aucun octet reçu (défaut 3 min). */
  streamIdleTimeoutMs?: number;
  /** Lot 18b : délai sans progression utile, keepalives compris (défaut 10 min). */
  streamProgressTimeoutMs?: number;
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
}

const OBSERVABILITY_HEADER_PREFIX = 'x-omniroute-';

/**
 * Marge conservée au-delà de la deadline globale, pour que l'erreur remontée
 * soit bien celle de la passerelle (503 amont) et non une coupure de socket
 * locale. Volontairement courte : 3 s.
 */
const DEADLINE_GRACE_MS = 3_000;

export class OmniRouteClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly streamWatchdog: StreamWatchdog;

  constructor(options: OmniRouteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.streamWatchdog = {
      idleMs: options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      progressMs: options.streamProgressTimeoutMs ?? DEFAULT_STREAM_PROGRESS_TIMEOUT_MS,
    };
  }

  /** `GET /v1/models` (surface OpenAI, toujours présente). */
  async listModelSpecs(signal?: AbortSignal): Promise<Array<{ id: string; contextLength?: number }>> {
    const response = await this.request('GET', '/v1/models', undefined, signal, 10_000);
    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const specs: Array<{ id: string; contextLength?: number }> = [];
    for (const entry of body.data ?? []) {
      if (typeof entry?.id === 'string' && entry.id.trim().length > 0) {
        const id = entry.id.trim();
        const ctxRaw = entry['context_length'] ?? entry['max_input_tokens'];
        const contextLength = typeof ctxRaw === 'number' && Number.isFinite(ctxRaw) && ctxRaw > 0 ? ctxRaw : undefined;
        specs.push({ id, contextLength });
      }
    }
    return specs;
  }

  /**
   * Lot 18c — `GET /v1/combos` (propre à OmniRoute) : noms des combos de
   * l'opérateur (AC-*). Mesuré le 31/10 : 84 ms et 11 Ko, quand `/v1/models`
   * répond 503 après 8 s.
   */
  async listComboNames(signal?: AbortSignal): Promise<string[]> {
    const response = await this.request('GET', '/v1/combos', undefined, signal, 5_000);
    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const names: string[] = [];
    for (const entry of body.data ?? []) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (name) names.push(name);
    }
    return names;
  }

  /** Lot 22 — en-têtes standard vers OmniRoute : User-Agent reconnu, anti-compression. */
  buildRequestHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      'User-Agent': 'omniroute-native/1.0 (sdk-cli; Paperclip-Agent)',
      'x-omniroute-compression': 'off',
      'x-omniroute-no-memory': 'true',
      authorization: `Bearer ${this.apiKey}`,
      ...(extraHeaders ?? {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const specs = await this.listModelSpecs(signal);
    return specs.map((s) => s.id);
  }

  /**
   * Appel Chat Completions en streaming, avec `reasoning_effort` et
   * `cache_control_points` quand la config les fournit.
   */
  async streamMessage(
    params: {
      model: string;
      system: string;
      messages: WireMessage[];
      tools: WireToolSpec[];
      maxTokens: number;
      reasoningEffort: ReasoningEffort;
      cacheControlPoints?: unknown;
      sessionId?: string;
      parallelToolCalls?: boolean;
      toolChoice?: 'auto' | 'none';
    },
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    const payload = buildChatCompletionsPayload({
      model: params.model,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      maxTokens: params.maxTokens,
      reasoningEffort: params.reasoningEffort,
      cacheControlPoints: params.cacheControlPoints,
      sessionId: params.sessionId,
      parallelToolCalls: params.parallelToolCalls,
      toolChoice: params.toolChoice,
    });

    const extraHeaders: Record<string, string> = {
      'x-omniroute-no-memory': 'true',
    };
    if (params.sessionId) {
      extraHeaders['X-Session-Id'] = params.sessionId;
    }

    const response = await this.request(
      'POST',
      '/v1/chat/completions',
      payload,
      signal,
      this.requestTimeoutMs,
      extraHeaders,
    );
    return consumeChatCompletionsSse(response, callbacks, signal, this.streamWatchdog);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    // Le délai de cette requête ne peut pas dépasser le délai **restant** du
    // run : sinon une requête lancée tardivement dépasserait la deadline
    // globale, qui est justement ce qu'on veut empêcher.
    //
    // On garde toutefois une petite marge au-delà de la deadline : couper le
    // socket exactement à l'échéance priverait Paperclip du vrai message
    // d'erreur de la passerelle (on verrait une annulation locale au lieu
    // d'une 503 amont). La marge est courte et le signal de deadline reste
    // armé : au pire, l'annulation et la coupure de socket coïncident.
    let effectiveTimeoutMs = timeoutMs;
    if (signal) {
      const remaining = remainingMs(signal);
      if (remaining !== null) {
        if (remaining <= 0) {
          throw new OmniRouteError(
            `Délai du run dépassé avant l'appel ${path}.`,
            classifyGatewayError({ message: 'deadline exceeded' }),
            null,
          );
        }
        effectiveTimeoutMs = Math.min(effectiveTimeoutMs, remaining + DEADLINE_GRACE_MS);
      }
    }

    const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const headers: Record<string, string> = {
      ...this.buildRequestHeaders(extraHeaders),
      accept: method === 'GET' ? 'application/json' : 'text/event-stream',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OmniRouteError(
        `OmniRoute injoignable (${this.baseUrl}${path}) : ${message}`,
        classifyGatewayError({ message }),
        null,
      );
    }

    if (!response.ok) {
      throw await toOmniRouteError(response, this.baseUrl, path);
    }
    return response;
  }
}

async function toOmniRouteError(
  response: Response,
  baseUrl: string,
  path: string,
): Promise<OmniRouteError> {
  const raw = await response.text().catch(() => '');
  let code: string | undefined;
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown; type?: unknown; code?: unknown } };
    const err = parsed.error;
    if (err) {
      if (typeof err.message === 'string') message = err.message;
      const machineCode = err.type ?? err.code;
      if (typeof machineCode === 'string') code = machineCode;
    }
  } catch {
    // Corps non-JSON : on garde le texte brut comme message.
  }
  return new OmniRouteError(
    `OmniRoute ${path} a répondu ${response.status} : ${message}`,
    classifyGatewayError({
      status: response.status,
      message,
      code,
      // La passerelle peut dire « réessaie à tel instant ». On lit ce header
      // ici : le calculait déjà (`computeRetryNotBefore`), mais personne ne
      // le transmettait, donc `retryNotBefore` restait toujours nul et
      // Paperclip ne suspendait jamais le run proprement.
      retryAfterSec: parseRetryAfterHeader(response.headers.get('retry-after')),
    }),
    response.status,
  );
}

/**
 * Lit un header `Retry-After` et le ramène en secondes.
 *
 * Deux formes sont admises par la RFC 9110 : un délai en secondes, ou une
 * date HTTP absolue. On ne renvoie que ce qui est exploitable et borné.
 */
export function parseRetryAfterHeader(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  // Forme « délai en secondes ».
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }

  // Forme « date HTTP absolue ».
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const delta = Math.ceil((when - Date.now()) / 1000);
  return delta > 0 ? delta : undefined;
}

/**
 * Consomme un flux SSE Chat Completions.
 *
 * Les tool_calls arrivent en fragments (`arguments` coupés en morceaux) : on
 * accumule par index de tool_call et on n'émet `onToolUse` qu'une fois les
 * arguments JSON complets (au `finish_reason` ou à la fin du flux).
 */
interface StreamWatchdog {
  idleMs: number;
  progressMs: number;
}

async function consumeChatCompletionsSse(
  response: Response,
  callbacks: StreamCallbacks,
  signal: AbortSignal | undefined,
  watchdog: StreamWatchdog = { idleMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS, progressMs: DEFAULT_STREAM_PROGRESS_TIMEOUT_MS },
): Promise<StreamResult> {
  const body = response.body;
  if (!body) {
    throw new OmniRouteError(
      'OmniRoute a renvoyé un flux vide.',
      classifyGatewayError({ message: 'empty stream' }),
      response.status,
    );
  }

  const gatewayHeaders = collectObservabilityHeaders(response.headers);
  const content: import('./wire.js').WireContentBlock[] = [];
  let textBuffer = '';
  let reasoningBuffer = '';
  let stopReason: string | null = null;
  let model: string | null = null;
  const usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let cacheWriteInPrompt = false;

  interface ToolCallAccumulator {
    id: string;
    name: string;
    argumentsBuffer: string;
  }
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let costUsd: number | null = null;

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  // Le flux n'est complet que s'il s'est terminé par `[DONE]` ou a donné un
  // `finish_reason`. Une fin de socket avant cela (proxy, coupure amont) livrait
  // jusqu'ici un texte ou un appel d'outil partiel comme s'il était complet.
  let sawDone = false;
  let lastProgressAt = Date.now();
  const stalled = (message: string): OmniRouteError =>
    new OmniRouteError(
      message,
      classifyGatewayError({ message: `stream stalled: ${message}`, code: 'upstream_error' }),
      response.status,
    );
  try {
    let done = false;
    while (!done) {
      if (signal?.aborted) break;
      // Lot 18b : chaque lecture est bornée par le délai d'inactivité et par
      // le temps restant avant le délai de progression.
      const progressLeft = watchdog.progressMs - (Date.now() - lastProgressAt);
      if (progressLeft <= 0) {
        throw stalled(
          `Flux OmniRoute sans progression depuis ${Math.round(watchdog.progressMs / 1000)} s (keepalives seulement) : abandon de l'appel.`,
        );
      }
      const waitMs = Math.min(watchdog.idleMs, progressLeft);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitMs);
      });
      const read = await Promise.race([reader.read(), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (read === 'timeout') {
        if (waitMs >= watchdog.idleMs) {
          throw stalled(
            `Flux OmniRoute inactif : aucune donnée reçue depuis ${Math.round(watchdog.idleMs / 1000)} s (flux figé).`,
          );
        }
        continue; // le délai de progression est vérifié en tête de boucle
      }
      const { done: streamDone, value } = read;
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data.length === 0) continue;
        if (data === '[DONE]') {
          // La sentinelle `[DONE]` **termine** le flux. On sort de la boucle
          // de lecture : sans cela, on attendait la fermeture du socket, qui
          // peut ne jamais venir, et le run restait bloqué après la réponse.
          sawDone = true;
          done = true;
          break;
        }
        let chunk: ChatCompletionsChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionsChunk;
        } catch {
          continue;
        }
        const effects = projectChunk(chunk);
        if (!effects) continue;
        const isKeepalive = chunk.model === KEEPALIVE_MODEL;
        if (
          !isKeepalive &&
          (effects.text || effects.reasoning || effects.toolCallDeltas?.length || effects.finishReason || effects.usage || effects.error)
        ) {
          lastProgressAt = Date.now();
        }

        // Une erreur émise dans le flux est une VRAIE erreur : la réponse HTTP
        // était 200, mais le fournisseur a signalé l'échec dans le corps. On
        // lève donc, sinon l'hôte recevrait un run « réussi » sans texte ni
        // outil — un échec silencieux.
        if (effects.error) {
          throw new OmniRouteError(
            `OmniRoute a émis une erreur dans le flux : ${effects.error.message}`,
            classifyGatewayError({
              message: effects.error.message,
              ...(effects.error.code ? { code: effects.error.code } : {}),
            }),
            response.status,
          );
        }

        if (effects.model && effects.model !== KEEPALIVE_MODEL) model = effects.model;
        if (effects.text) {
          textBuffer += effects.text;
          callbacks.onTextDelta?.(effects.text);
        }
        if (effects.reasoning) {
          reasoningBuffer += effects.reasoning;
          callbacks.onThinkingDelta?.(effects.reasoning);
        }
        for (const delta of effects.toolCallDeltas ?? []) {
          const { index, id, name, argumentsFragment } = delta;
          const acc = toolCalls.get(index) ?? { id: `call_${index}`, name: '', argumentsBuffer: '' };
          if (id) acc.id = id;
          if (name) acc.name = name;
          if (argumentsFragment) acc.argumentsBuffer += argumentsFragment;
          toolCalls.set(index, acc);
        }
        if (effects.finishReason) stopReason = effects.finishReason;
        if (effects.usage) {
          usage.inputTokens = Math.max(usage.inputTokens, effects.usage.inputTokens);
          usage.outputTokens = Math.max(usage.outputTokens, effects.usage.outputTokens);
          usage.cacheReadTokens = Math.max(usage.cacheReadTokens, effects.usage.cacheReadTokens);
          usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, effects.usage.cacheWriteTokens);
          if (effects.usage.cacheWriteInPrompt) cacheWriteInPrompt = true;
          if (effects.usage.costUsd !== null) costUsd = effects.usage.costUsd;
        }
      }
    }
  } finally {
    // On annule la lecture avant de rendre le verrou : un flux abandonné
    // (annulation, erreur dans le flux) ne doit pas laisser le socket ouvert.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (!signal?.aborted && !sawDone && stopReason === null) {
    throw new OmniRouteError(
      'Flux OmniRoute incomplet : fin de connexion sans finish_reason ni [DONE].',
      classifyGatewayError({ message: 'stream incomplete: connection reset before completion', code: 'upstream_error' }),
      response.status,
    );
  }

  // Ordre de restitution : raisonnement (UI repliable) puis texte, puis outils.
  if (reasoningBuffer.length > 0) {
    content.push({ type: 'thinking', thinking: reasoningBuffer });
  }
  if (textBuffer.length > 0) {
    content.push({ type: 'text', text: textBuffer });
  }
  for (const acc of [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
    const block = {
      type: 'tool_use' as const,
      id: acc.id,
      name: acc.name,
      input: parseJsonBuffer(acc.argumentsBuffer),
    };
    content.push(block);
    callbacks.onToolUse?.({ id: block.id, name: block.name, input: block.input });
  }

  const headerCost = asCost(gatewayHeaders['x-omniroute-response-cost']);
  // Convention Paperclip : lectures du cache hors de `inputTokens` (lot 10).
  const normalized = toPaperclipUsage({
    promptTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheWriteInPrompt,
  });
  // Lot 22 — coût calculé via le barème officiel si OmniRoute ne l'a pas renvoyé.
  // Attention à ne pas facturer deux fois les écritures de cache :
  // promptTokens brut (usage.inputTokens) est l'entrée avant toPaperclipUsage.
  let resolvedCost = costUsd ?? headerCost;
  let costSource: 'provider_reported' | 'rate_card' | undefined;
  if (resolvedCost !== null) {
    costSource = 'provider_reported';
  } else if (model) {
    resolvedCost = calculateModelCostUsd(model, {
      promptTokens: usage.inputTokens,
      inputTokens: normalized.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: normalized.cacheReadTokens,
      cacheWriteTokens: normalized.cacheWriteTokens,
      cacheWriteInPrompt,
    });
    if (resolvedCost !== null) costSource = 'rate_card';
  }

  return {
    content,
    stopReason,
    usage: { ...usage, ...normalized },
    model,
    gatewayHeaders,
    costUsd: resolvedCost,
    ...(costSource ? { costSource } : {}),
  };
}

/**
 * Clé posée sur l'entrée d'un appel dont les arguments ne sont pas du JSON
 * valide. L'entrée reste sérialisable (elle est rejouée au modèle), mais la
 * boucle refuse d'exécuter l'outil (audit A8).
 */
export const INVALID_ARGUMENTS_KEY = '_raw';

function parseJsonBuffer(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { [INVALID_ARGUMENTS_KEY]: trimmed };
  }
}

function collectObservabilityHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith(OBSERVABILITY_HEADER_PREFIX)) out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Combine le signal d'annulation de l'hôte avec le signal de deadline.
 *
 * `AbortSignal.any()` ne propage pas notre marqueur d'échéance : sans cela,
 * le client ne verrait pas le temps restant et bornerait chaque requête par
 * le délai complet — ce qu'on veut précisément éviter.
 */
export function combineWithDeadline(hostSignal: AbortSignal, deadlineSignal: AbortSignal): AbortSignal {
  const combined = AbortSignal.any([hostSignal, deadlineSignal]);
  const deadlineAt = (deadlineSignal as unknown as { __deadlineAt?: number }).__deadlineAt;
  if (typeof deadlineAt === 'number') {
    (combined as unknown as { __deadlineAt?: number }).__deadlineAt = deadlineAt;
  }
  return combined;
}

/**
 * Millisecondes restantes avant l'échéance d'un signal, ou `null` si le
 * signal n'a pas d'échéance connue.
 *
 * `AbortSignal.timeout()` ne rend pas son échéance lisible. On la transporte
 * donc par un marqueur posé à la création du signal de deadline
 * (`withDeadline`), ce qui évite de/deviner.
 */
export function remainingMs(signal: AbortSignal): number | null {
  const deadlineAt = (signal as unknown as { __deadlineAt?: number }).__deadlineAt;
  if (typeof deadlineAt !== 'number') return null;
  return deadlineAt - Date.now();
}

/**
 * Crée un signal de deadline globale, et porte son échéance dans un
 * marqueur pour que le client puisse borner chaque requête par le temps
 * restant.
 */
export function withDeadline(timeoutMs: number): AbortSignal {
  const signal = AbortSignal.timeout(timeoutMs);
  (signal as unknown as { __deadlineAt?: number }).__deadlineAt = Date.now() + timeoutMs;
  return signal;
}

/**
 * Surface OpenAI Chat Completions — le point d'ACC-2105.
 *
 * OmniRoute expose `/v1/chat/completions` (OpenAI) **et** `/v1/messages`
 * (Anthropic). L'adaptateur historique `omniroute-paperclip-adapter` parlait
 * Anthropic : les extensions OmniRoute (`reasoning_effort`, `cache_control_points`,
 * options fournisseur) étaient invisibles côté client. Ici on parle la surface
 * native, sans traduction.
 *
 * Ce module est **pur** (aucun fetch, aucun I/O) : c'est ce qui le rend
 * testable sans shims ni passerelle factice. `client.ts` ne fait qu'empaqueter
 * ces fonctions dans du HTTP+SSE.
 */
import type { WireContentBlock, WireMessage, WireToolSpec } from './wire.js';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface ChatCompletionsParams {
  model: string;
  system: string;
  messages: WireMessage[];
  tools: WireToolSpec[];
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
  /** Extensions OmniRoute/MiniMax : points de cache, passés tels quels si fournis. */
  cacheControlPoints?: unknown;
  sessionId?: string;
  parallelToolCalls?: boolean;
  /** `none` : le modèle ne peut pas appeler d'outil (tour de synthèse finale). */
  toolChoice?: 'auto' | 'none';
}

/**
 * Construit le corps `POST /v1/chat/completions`.
 *
 * Choix de forme, tous mesurés sur la spec OpenAI + extensions OmniRoute :
 * - `system` est un message `role: "system"` en tête, pas un champ dédié ;
 * - `stream: true` + `stream_options.include_usage` pour récupérer les tokens
 *   même quand le dernier chunk n'a pas de contenu ;
 * - `reasoning_effort` n'est émis que s'il est explicite (`none` = champ absent,
 *   pas `"none"` — certains amonts refusent la valeur littérale) ;
 * - `cache_control_points` est un tableau vide omis, une valeur fournie passée
 *   telle quelle (extension, pas de normalisation inventée).
 */
export function buildChatCompletionsPayload(params: ChatCompletionsParams): Record<string, unknown> {
  const messages = wireMessagesToOpenAi(params.messages);
  if (params.system.trim().length > 0) {
    messages.unshift({ role: 'system', content: params.system });
  }

  // Lot 22 — Marqueur de cache sur le DERNIER message de la conversation
  // (`user` ou `tool`) : avec l'User-Agent `sdk-cli`, OmniRoute préserve ce
  // marqueur et Anthropic relit tout l'historique en cache dès le tour suivant
  // (99,9 % de réutilisation mesuré en direct).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg['role'] === 'user' || msg['role'] === 'tool') {
      msg['cache_control'] = { type: 'ephemeral' };
      break;
    }
  }

  const payload: Record<string, unknown> = {
    model: params.model,
    messages,
    max_tokens: params.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (params.tools.length > 0) {
    payload['tools'] = params.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  if (typeof params.parallelToolCalls === 'boolean') {
    payload['parallel_tool_calls'] = params.parallelToolCalls;
  }

  // Les outils restent déclarés (l'historique contient des appels d'outil,
  // certains fournisseurs exigent leur définition) mais sont interdits.
  if (params.toolChoice && params.tools.length > 0) {
    payload['tool_choice'] = params.toolChoice;
  }

  if (params.reasoningEffort !== 'none') {
    payload['reasoning_effort'] = params.reasoningEffort;
  }

  const points = params.cacheControlPoints;
  if (Array.isArray(points) && points.length > 0) {
    payload['cache_control_points'] = points;
  } else if (points !== undefined && points !== null && !Array.isArray(points)) {
    payload['cache_control_points'] = points;
  }

    if (params.sessionId) {
    payload['user'] = params.sessionId;
  }

  return payload;
}

/** Un message OpenAI : le seul modèle de sortie de `wireMessagesToOpenAi`. */
export type OpenAiMessage = Record<string, unknown>;

/**
 * Convertit le fil interne (blocs Anthropic-like, pratique pour la boucle
 * d'outils) en messages OpenAI.
 *
 * Différences de protocole assumées :
 * - le `thinking` n'est **pas** rejoué vers l'amont Chat Completions : la
 *   surface OpenAI n'attend ni `thinking` ni `signature` dans l'historique ;
 *   il reste dans le transcript local pour l'UI ;
 * - un `tool_use` devient un `tool_calls[]` sur le message assistant ;
 * - un `tool_result` devient un message `role: "tool"` (un par appel, l'ordre
 *   suit l'ordre des blocs).
 */
export function wireMessagesToOpenAi(messages: WireMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block): block is Extract<WireContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const toolCalls = message.content
        .filter((block): block is Extract<WireContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));

      const assistant: OpenAiMessage = { role: 'assistant', content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) assistant['tool_calls'] = toolCalls;
      out.push(assistant);
      continue;
    }

    // user : soit du texte, soit des tool_result (jamais mélangés dans la boucle).
    const text = message.content
      .filter((block): block is Extract<WireContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolResults = message.content.filter(
      (block): block is Extract<WireContentBlock, { type: 'tool_result' }> => block.type === 'tool_result',
    );

    if (toolResults.length > 0) {
      for (const result of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: result.content,
        });
      }
      continue;
    }

    out.push({ role: 'user', content: text });
  }

  return out;
}

/**
 * Une ligne `data:` du flux Chat Completions, déjà parsée.
 * Entrée tolérante : les fournisseurs agrégés par OmniRoute dérivent parfois
 * (`reasoning` / `reasoning_content`, `tool_calls` fragmentés).
 */
export interface ChatCompletionsChunk {
  model?: string;
  /** Erreur émise dans le corps d'un flux SSE (HTTP 200). */
  error?: { message?: unknown; code?: unknown; type?: unknown };
  choices?: Array<{
    index?: number;
    delta?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_creation_in_prompt?: unknown };
    /** Extension OmniRoute (fournisseurs Anthropic) : lecture et écriture du cache. */
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    /** Coût USD posé par OmniRoute dans le chunk d'usage (seule source en streaming). */
    cost?: unknown;
  };
}

export interface ChunkEffects {
  text?: string;
  reasoning?: string;
  /**
   * Deltas d'appels d'outils. Un tableau : un même chunk peut en contenir
   * plusieurs, et ne garder que le dernier écraserait silencieusement les
   * autres — l'agent perdrait un appel sans aucun signe.
   */
  toolCallDeltas?: Array<{ index: number; id?: string; name?: string; argumentsFragment?: string }>;
  /**
   * Erreur portée par le chunk lui-même.
   *
   * Une passerelle peut répondre HTTP 200 puis émettre un chunk `error` :
   * sans ce traitement, l'échec devenait un succès silencieux (aucun texte,
   * aucun outil, `exitCode: 0`).
   */
  error?: { message: string; code?: string; type?: string };
  finishReason?: string;
  model?: string;
  usage?: {
    /** `prompt_tokens` brut : entrée non cachée + lectures du cache. */
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    /** Écritures du cache (`cache_creation_input_tokens`). */
    cacheWriteTokens: number;
    /** Les écritures sont-elles déjà comptées dans `prompt_tokens` ? */
    cacheWriteInPrompt: boolean;
    costUsd: number | null;
  };
}

/**
 * Lot 10 — convertit l'usage OpenAI/OmniRoute en convention Paperclip
 * (`adapter-utils/src/types.ts`, UsageSummary) : `inputTokens` = entrée non
 * cachée + écritures du cache, **sans** les lectures du cache, qui vont dans
 * `cachedInputTokens`. Total = input + cached + output.
 *
 * Mesuré le 31/10/2026 sur OmniRoute (AC-pro-coding → claude-opus-5-5) :
 * - 1er appel : `prompt_tokens: 13`, `cache_creation_input_tokens: 16826`,
 *   `cache_creation_in_prompt: false` → les écritures sont hors `prompt_tokens` ;
 * - 2e appel : `prompt_tokens: 16839` dont `cached_tokens: 16826` → les
 *   lectures sont dans `prompt_tokens`.
 * Avant ce correctif, `prompt_tokens` était rapporté tel quel : les lectures
 * du cache étaient comptées deux fois (run 7ca692c0 : 426 194 « entrée » au
 * lieu de 54 260, pour 405 329 lus dans le cache).
 */
export function toPaperclipUsage(raw: {
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWriteInPrompt: boolean;
}): { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const uncached = Math.max(0, raw.promptTokens - raw.cacheReadTokens);
  return {
    inputTokens: uncached + (raw.cacheWriteInPrompt ? 0 : raw.cacheWriteTokens),
    cacheReadTokens: raw.cacheReadTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
  };
}

/**
 * Projette un chunk OpenAI en effets sur l'accumulateur. Retourne `null` pour
 * un chunk sans information (heartbeat, objet vide).
 */
export function projectChunk(chunk: ChatCompletionsChunk): ChunkEffects | null {
  const effects: ChunkEffects = {};
  let meaningful = false;

  // Une erreur émise dans le flux prime sur tout le reste du chunk : on la
  // remonte immédiatement, sinon l'hôte verrait un run « réussi » sans
  // texte et sans outil.
  if (chunk.error) {
    const message = asString(chunk.error.message) ?? 'Erreur inconnue émise par la passerelle.';
    const code = asString(chunk.error.code);
    const type = asString(chunk.error.type);
    effects.error = { message, ...(code ? { code } : {}), ...(type ? { type } : {}) };
    return effects;
  }

  if (typeof chunk.model === 'string' && chunk.model.length > 0) {
    effects.model = chunk.model;
    meaningful = true;
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
    const text = asString(delta.content);
    if (text !== null && text.length > 0) {
      effects.text = text;
      meaningful = true;
    }
    // Les fournisseurs OpenRouter/MiniMax nomment le raisonnement `reasoning`
    // ou `reasoning_content` — on accepte les deux.
    const reasoning = asString(delta.reasoning) ?? asString(delta.reasoning_content);
    if (reasoning !== null && reasoning.length > 0) {
      effects.reasoning = reasoning;
      meaningful = true;
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      // On collecte **tous** les appels du chunk : ne garder que le dernier
      // ferait perdre un appel sans laisser de trace.
      const deltas: NonNullable<ChunkEffects['toolCallDeltas']> = [];
      for (const call of delta.tool_calls) {
        const index = typeof call.index === 'number' ? call.index : deltas.length;
        const id = asString(call.id);
        const name = asString(call.function?.name);
        const args = asString(call.function?.arguments);
        if (id !== null || name !== null || args !== null) {
          deltas.push({
            index,
            ...(id !== null ? { id } : {}),
            ...(name !== null ? { name } : {}),
            ...(args !== null ? { argumentsFragment: args } : {}),
          });
        }
      }
      if (deltas.length > 0) {
        effects.toolCallDeltas = deltas;
        meaningful = true;
      }
    }
  }

  const finish = asString(choice?.finish_reason);
  if (finish !== null) {
    effects.finishReason = finish;
    meaningful = true;
  }

  if (chunk.usage) {
    const cachedDetail = asCount(chunk.usage.prompt_tokens_details?.cached_tokens);
    effects.usage = {
      inputTokens: asCount(chunk.usage.prompt_tokens),
      outputTokens: asCount(chunk.usage.completion_tokens),
      cacheReadTokens: cachedDetail > 0 ? cachedDetail : asCount(chunk.usage.cache_read_input_tokens),
      cacheWriteTokens: asCount(chunk.usage.cache_creation_input_tokens),
      cacheWriteInPrompt: chunk.usage.prompt_tokens_details?.cache_creation_in_prompt === true,
      // `x-omniroute-response-cost` n'existe qu'en non-streaming (API_REFERENCE,
      // « Cost telemetry headers ») : en SSE, le coût n'arrive que dans `usage.cost`.
      costUsd: asCost(chunk.usage.cost),
    };
    meaningful = true;
  }

  return meaningful ? effects : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Coût USD : nombre fini ≥ 0, sinon inconnu (`null`, jamais 0 inventé). */
export function asCost(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

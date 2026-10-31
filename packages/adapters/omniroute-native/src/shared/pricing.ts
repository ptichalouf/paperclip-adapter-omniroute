/**
 * Lot 22 — Barème tarifaire et calcul du coût réel d'un appel ou d'un run.
 *
 * Source : tarification officielle OmniRoute publiée sur `/v1/models/{id}`
 * (prix par million de tokens : prompt, completion, cache_read, cache_write).
 *
 * En mode streaming, OmniRoute ne renvoie pas `usage.cost` ni l'en-tête de coût
 * pour Claude Opus. L'adaptateur calcule donc le coût en multipliant ces
 * tarifs unitaires par les compteurs de tokens normalisés du flux.
 */

export interface ModelPricing {
  /** Coût par token d'entrée hors cache (ex. 0.000004 pour 4 $/M). */
  promptPerToken: number;
  /** Coût par token de sortie (ex. 0.000020 pour 20 $/M). */
  completionPerToken: number;
  /** Coût par token de lecture du cache (ex. 0.0000002 pour 0,20 $/M). */
  cacheReadPerToken: number;
  /** Coût par token d'écriture dans le cache (ex. 0.000005 pour 5 $/M). */
  cacheWritePerToken: number;
}

/** Tarifs connus en $ / million de tokens. */
function perMillion(prompt: number, completion: number, cacheRead: number, cacheWrite: number): ModelPricing {
  return {
    promptPerToken: prompt / 1_000_000,
    completionPerToken: completion / 1_000_000,
    cacheReadPerToken: cacheRead / 1_000_000,
    cacheWritePerToken: cacheWrite / 1_000_000,
  };
}

export const KNOWN_MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Opus (utilisé par AC-pro-coding)
  'claude/claude-opus-5-5': perMillion(4, 20, 0.2, 5),
  'claude-opus-5-5': perMillion(4, 20, 0.2, 5),
  'claude-3-opus': perMillion(15, 75, 1.5, 18.75),

  // Claude Sonnet (utilisé par AC-code / AC-main)
  'claude/claude-sonnet-4-5': perMillion(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5': perMillion(3, 15, 0.3, 3.75),
  'claude-3-5-sonnet': perMillion(3, 15, 0.3, 3.75),

  // Claude Haiku
  'claude/claude-haiku-5-5': perMillion(0.8, 4, 0.08, 1),
  'claude-haiku-5-5': perMillion(0.8, 4, 0.08, 1),
  'claude-3-5-haiku': perMillion(0.8, 4, 0.08, 1),

  // OpenAI / Codex
  'openai/gpt-4o': perMillion(2.5, 10, 1.25, 2.5),
  'openai/gpt-4o-mini': perMillion(0.15, 0.6, 0.075, 0.15),
  'openai/o1': perMillion(15, 60, 7.5, 15),

  // DeepSeek
  'deepseek/deepseek-chat': perMillion(0.14, 0.28, 0.014, 0.14),
  'deepseek/deepseek-reasoner': perMillion(0.55, 2.19, 0.14, 0.55),

  // MiniMax
  'minimax/minimax-m3.1': perMillion(0.2, 1.1, 0.05, 0.25),
  'minimax/minimax-m3': perMillion(0.2, 1.1, 0.05, 0.25),
};

/** Cache en mémoire des tarifs résolus dynamiquement via `/v1/models/{id}`. */
const dynamicPricingCache = new Map<string, ModelPricing>();

/** Vide le cache dynamique de tarification (pour les tests). */
export function clearPricingCache(): void {
  dynamicPricingCache.clear();
}

/**
 * Enregistre un tarif dynamique (par exemple après un appel GET /v1/models/{id}).
 */
export function registerModelPricing(modelId: string, pricing: ModelPricing): void {
  dynamicPricingCache.set(modelId, pricing);
}

/**
 * Trouve le barème d'un modèle (catalogue statique ou cache dynamique).
 * Gère la présence ou l'absence du préfixe fournisseur (ex. `claude/`).
 */
export function findModelPricing(modelId: string): ModelPricing | null {
  const direct = dynamicPricingCache.get(modelId) ?? KNOWN_MODEL_PRICING[modelId];
  if (direct) return direct;

  // Tentative sans préfixe
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const unPrefixed = modelId.slice(slash + 1);
    const hit = dynamicPricingCache.get(unPrefixed) ?? KNOWN_MODEL_PRICING[unPrefixed];
    if (hit) return hit;
  } else {
    // Tentative avec préfixes connus
    for (const prefix of ['claude/', 'openai/', 'deepseek/', 'minimax/']) {
      const prefixed = `${prefix}${modelId}`;
      const hit = dynamicPricingCache.get(prefixed) ?? KNOWN_MODEL_PRICING[prefixed];
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * Charge dynamiquement le barème d'un modèle auprès d'OmniRoute via `GET /v1/models/{id}`.
 */
export async function loadRemoteModelPricing(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ModelPricing | null> {
  const cached = findModelPricing(modelId);
  if (cached) return cached;

  const candidates = [modelId];
  if (!modelId.includes('/')) {
    candidates.push(`claude/${modelId}`, `openai/${modelId}`, `deepseek/${modelId}`, `minimax/${modelId}`);
  }

  for (const candidate of candidates) {
    const encoded = encodeURIComponent(candidate);
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/models/${encoded}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          'User-Agent': 'omniroute-native/1.0 (sdk-cli; Paperclip-Agent)',
        },
        signal: signal ?? AbortSignal.timeout(5_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { pricing?: Record<string, unknown> };
      const raw = body.pricing;
      if (raw && typeof raw === 'object') {
        const prompt = Number(raw['prompt'] ?? raw['input']);
        const completion = Number(raw['completion'] ?? raw['output']);
        const cacheRead = Number(raw['input_cache_read'] ?? raw['cached']);
        const cacheWrite = Number(raw['input_cache_write'] ?? raw['cache_creation']);
        if (Number.isFinite(prompt) && Number.isFinite(completion)) {
          const p = prompt >= 0.01 ? prompt / 1_000_000 : prompt;
          const c = completion >= 0.01 ? completion / 1_000_000 : completion;
          const cr = Number.isFinite(cacheRead) ? (cacheRead >= 0.01 ? cacheRead / 1_000_000 : cacheRead) : 0;
          const cw = Number.isFinite(cacheWrite) ? (cacheWrite >= 0.01 ? cacheWrite / 1_000_000 : cacheWrite) : 0;
          const pricing: ModelPricing = {
            promptPerToken: p,
            completionPerToken: c,
            cacheReadPerToken: cr,
            cacheWritePerToken: cw,
          };
          registerModelPricing(modelId, pricing);
          registerModelPricing(candidate, pricing);
          return pricing;
        }
      }
    } catch {
      // Échec réseau : continue vers le candidat suivant
    }
  }
  return null;
}

export interface TokenUsageForPricing {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Tokens prompt bruts si disponibles. */
  promptTokens?: number;
  /** Vrai si cache_creation_input_tokens était déjà compté dans promptTokens. */
  cacheWriteInPrompt?: boolean;
}

/**
 * Calcule le coût en dollars USD pour un usage donné sur un modèle.
 * Renvoie `null` si le modèle n'a pas de tarif connu ou est gratuit.
 *
 * Évite rigoureusement la double facturation des écritures de cache :
 * `toPaperclipUsage` regroupe toutes les écritures et l'entrée dans `inputTokens`,
 * mais les écritures de cache doivent être facturées à `cacheWritePerToken`,
 * et l'entrée fraîche à `promptPerToken`.
 */
export function calculateModelCostUsd(
  modelId: string,
  usage: TokenUsageForPricing,
): number | null {
  const pricing = findModelPricing(modelId);
  if (!pricing) return null;

  // Quantité facturable en entrée fraîche (non mise en cache) :
  // Si promptTokens brut est fourni :
  //   promptTokens - cacheReadTokens - (cacheWriteInPrompt ? cacheWriteTokens : 0)
  // Si seul inputTokens (convention Paperclip) est fourni :
  //   inputTokens - cacheWriteTokens
  const freshInputTokens = Math.max(
    0,
    typeof usage.promptTokens === 'number'
      ? usage.promptTokens - usage.cacheReadTokens - (usage.cacheWriteInPrompt ? usage.cacheWriteTokens : 0)
      : usage.inputTokens - usage.cacheWriteTokens,
  );

  const cost =
    freshInputTokens * pricing.promptPerToken +
    usage.outputTokens * pricing.completionPerToken +
    usage.cacheReadTokens * pricing.cacheReadPerToken +
    usage.cacheWriteTokens * pricing.cacheWritePerToken;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

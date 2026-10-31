/**
 * Module context-window.ts (v1.3)
 *
 * Découverte dynamique de la taille de contexte via GET /v1/models/{id}.
 * Dimensionnement dynamique de l'historique et de la boucle d'agent.
 */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ModelContextSpec {
  modelId: string;
  contextTokens: number;
  maxOutputTokens?: number;
  source: 'remote_api' | 'memory_cache' | 'disk_cache' | 'known_catalog' | 'default_fallback';
  fetchedAt?: number;
}

/** Offline context hints for direct models, never deployment-specific routing combos. */
export const KNOWN_MODEL_CONTEXTS: Record<string, number> = {
  // Modèles amonts directs
  'claude/claude-opus-5-5': 200_000,
  'claude-opus-5-5': 200_000,
  'claude/claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,

  'openai/gpt-4o': 128_000,
  'openai/gpt-4o-mini': 128_000,
  'openai/o1': 200_000,

  'deepseek/deepseek-chat': 64_000,
  'deepseek/deepseek-reasoner': 64_000,

  'minimax/minimax-m3.1': 1_000_000,
  'minimax/minimax-m3': 1_000_000,

  // Modèles locaux DGX Spark
  'qwen/qwen2.5-coder-32b': 32_768,
  'qwen2.5-coder-32b': 32_768,
  'meta/muse-spark-1.3': 32_768,
};

/** Valeur par défaut prudente en cas d'échec total de résolution. */
export const SAFE_DEFAULT_CONTEXT_TOKENS = 128_000;
export const LOCAL_MODEL_DEFAULT_CONTEXT_TOKENS = 32_768;

/** Cache en mémoire des contextes de modèles résolus. */
const memoryContextCache = new Map<string, ModelContextSpec>();
export const MODEL_CONTEXT_CACHE_TTL_MS = 60 * 60 * 1_000;

function gatewayScope(baseUrl: string, apiKey: string): string {
  // Credentials are hashed, never persisted in plaintext. Scope includes the gateway path.
  return createHash('sha256').update(JSON.stringify([baseUrl.replace(/\/+$/, ''), apiKey])).digest('hex');
}

function fresh(spec: ModelContextSpec): boolean {
  return Number.isFinite(spec.contextTokens) && spec.contextTokens > 0 &&
    typeof spec.fetchedAt === 'number' && Number.isFinite(spec.fetchedAt) &&
    Date.now() >= spec.fetchedAt && Date.now() - spec.fetchedAt < MODEL_CONTEXT_CACHE_TTL_MS;
}

function cachedModelContext(modelId: string, scope: string): ModelContextSpec | null {
  const key = JSON.stringify([scope, modelId]);
  const hit = memoryContextCache.get(key);
  if (!hit) return null;
  if (!fresh(hit)) { memoryContextCache.delete(key); return null; }
  return { ...hit, source: 'memory_cache' };
}

/** Réinitialisation du cache mémoire (pour les tests). */
export function clearModelContextCache(): void {
  memoryContextCache.clear();
}

/** Enregistrement manuel ou programmatique d'un contexte de modèle. */
export function registerModelContext(modelId: string, spec: ModelContextSpec, scope = ''): void {
  memoryContextCache.set(JSON.stringify([scope, modelId]), { ...spec, fetchedAt: spec.fetchedAt ?? Date.now() });
}

/** Recherche locale synchrone (mémoire puis catalogue connu). */
export function findLocalModelContext(modelId: string, scope = ''): ModelContextSpec | null {
  const hit = cachedModelContext(modelId, scope);
  if (hit) return hit;

  const directTokens = KNOWN_MODEL_CONTEXTS[modelId];
  if (directTokens) {
    return { modelId, contextTokens: directTokens, source: 'known_catalog' };
  }

  // Tentative sans préfixe fournisseur (ex. 'claude/claude-opus-5-5' -> 'claude-opus-5-5')
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const unPrefixed = modelId.slice(slash + 1);
    const unHit = cachedModelContext(unPrefixed, scope);
    if (unHit) return unHit;
    const unTokens = KNOWN_MODEL_CONTEXTS[unPrefixed];
    if (unTokens) return { modelId, contextTokens: unTokens, source: 'known_catalog' };
  } else {
    for (const prefix of ['claude/', 'openai/', 'deepseek/', 'minimax/', 'qwen/']) {
      const prefixed = `${prefix}${modelId}`;
      const prefHit = cachedModelContext(prefixed, scope);
      if (prefHit) return prefHit;
      const prefTokens = KNOWN_MODEL_CONTEXTS[prefixed];
      if (prefTokens) return { modelId, contextTokens: prefTokens, source: 'known_catalog' };
    }
  }

  return null;
}

/**
 * Charge dynamiquement le contexte d'un modèle via `GET /v1/models/{id}` auprès d'OmniRoute.
 */
export async function loadRemoteModelContext(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ModelContextSpec> {
  // 1. Consultation immédiate du cache local / catalogue connu
  const scope = gatewayScope(baseUrl, apiKey);
  const local = findLocalModelContext(modelId, scope);
  if (local && local.source !== 'default_fallback') {
    return local;
  }

  // 2. Consultation du disque si présent
  const disk = loadDiskContextSpec(scope, modelId);
  if (disk) {
    registerModelContext(modelId, disk, scope);
    return disk;
  }

  // 3. Appel réseau GET /v1/models/{id}
  const candidates = [modelId];
  if (!modelId.includes('/')) {
    candidates.push(`claude/${modelId}`, `openai/${modelId}`, `deepseek/${modelId}`, `minimax/${modelId}`, `qwen/${modelId}`);
  }

  const timeoutSignal = AbortSignal.timeout(3_000);
  const discoverySignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  for (const candidate of candidates) {
    if (discoverySignal.aborted) break;
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
        signal: discoverySignal,
      });

      if (!response.ok) continue;

      const body = (await response.json()) as Record<string, unknown>;
      const rawContext =
        body['context_length'] ??
        body['max_input_tokens'] ??
        body['context_window'] ??
        body['max_context_length'];

      const contextTokens =
        typeof rawContext === 'number' && Number.isFinite(rawContext) && rawContext > 0
          ? Math.floor(rawContext)
          : null;

      if (contextTokens) {
        const spec: ModelContextSpec = {
          modelId,
          contextTokens,
          source: 'remote_api',
          fetchedAt: Date.now(),
        };
        registerModelContext(modelId, spec, scope);
        registerModelContext(candidate, spec, scope);
        await saveDiskContextSpec(scope, modelId, spec);
        return spec;
      }
    } catch {
      // Échec ou timeout sur ce candidat : poursuivre vers le suivant
    }
  }

  // 4. Repli sécurisé final
  const fallbackTokens = /local|spark|qwen/i.test(modelId)
    ? LOCAL_MODEL_DEFAULT_CONTEXT_TOKENS
    : SAFE_DEFAULT_CONTEXT_TOKENS;

  const fallbackSpec: ModelContextSpec = {
    modelId,
    contextTokens: fallbackTokens,
    source: 'default_fallback',
  };
  return fallbackSpec;
}

/**
 * Calcul dynamique des budgets de mémoire de session selon la taille réelle du modèle.
 */
export function calculateDynamicSessionBudgets(contextTokens: number): {
  historyBudgetChars: number;
  intraRunBudgetChars: number;
} {
  // Ratio moyen : 1 token ≈ 3,5 caractères UTF-8 en français/code
  const totalChars = contextTokens * 3.5;

  if (contextTokens <= 32_768) {
    // Petit modèle local (ex. Qwen 32k) : allocation prudente
    // Historique : 25 % (~28k car.), Intra-run : 35 % (~40k car.), reste 40 % pour système + tâche + sortie
    return {
      historyBudgetChars: Math.max(15_000, Math.floor(totalChars * 0.25)),
      intraRunBudgetChars: Math.max(25_000, Math.floor(totalChars * 0.35)),
    };
  }

  if (contextTokens >= 1_000_000) {
    // Très grand modèle (taille découverte) : grand confort borné
    // Historique : 40 % plafonné à 1,5M caractères (~428k tokens)
    // Intra-run : 50 % plafonné à 2,0M caractères (~571k tokens)
    return {
      historyBudgetChars: Math.min(1_500_000, Math.floor(totalChars * 0.40)),
      intraRunBudgetChars: Math.min(2_000_000, Math.floor(totalChars * 0.50)),
    };
  }

  // Modèles standards (128k à 200k tokens, ex. Opus, GPT-4o) :
  // Historique : 40 % borné entre [100k, 400k] caractères
  // Intra-run : 50 % borné entre [100k, 600k] caractères
  return {
    historyBudgetChars: Math.max(100_000, Math.min(400_000, Math.floor(totalChars * 0.40))),
    intraRunBudgetChars: Math.max(100_000, Math.min(600_000, Math.floor(totalChars * 0.50))),
  };
}

// ── Persistance disque de secours ──────────────────────────────────────────

function diskContextCachePath(): string | null {
  const home = process.env['PAPERCLIP_HOME']?.trim();
  return home ? path.join(home, 'adapter-data', 'omniroute-native', 'context-cache.json') : null;
}

interface DiskContextCache {
  version: 2;
  scope: string;
  specs: Record<string, ModelContextSpec>;
}

function loadDiskContextSpec(scope: string, modelId: string): ModelContextSpec | null {
  const file = diskContextCachePath();
  if (!file) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as DiskContextCache;
    if (data.version !== 2 || data.scope !== scope || !data.specs) return null;
    const entry = data.specs[modelId];
    if (entry && fresh(entry)) {
      return { ...entry, modelId, source: 'disk_cache' };
    }
  } catch {
    return null;
  }
  return null;
}

async function saveDiskContextSpec(scope: string, modelId: string, spec: ModelContextSpec): Promise<void> {
  const file = diskContextCachePath();
  if (!file) return;
  try {
    let existing: DiskContextCache = { version: 2, scope, specs: {} };
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as DiskContextCache;
      if (data.version === 2 && data.scope === scope && data.specs) existing = data;
    } catch {
      // Legacy files without expiry/scope are deliberately not reused.
    }
    existing.specs[modelId] = spec;
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify(existing, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  } catch {
    // Écriture facultative
  }
}

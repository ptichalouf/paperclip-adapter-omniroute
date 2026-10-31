/**
 * Découverte des modèles exposés par la passerelle.
 *
 * OmniRoute agrège ~3000 modèles : interroger `/v1/models` à chaque rendu de
 * formulaire serait du gaspillage et ferait clignoter l'UI au moindre
 * hoquet réseau. On met donc le résultat en cache avec une TTL courte — assez
 * pour absorber une rafale d'appels, assez court pour qu'un modèle ajouté
 * côté passerelle apparaisse sans redémarrer Paperclip.
 *
 * Le cache est volontairement *par URL de passerelle* : une agence peut
 * configurer plusieurs instances, elles n'exposent pas les mêmes modèles.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterModel } from '@paperclipai/adapter-utils';

import { OmniRouteClient } from '../shared/client.js';
import { resolveConfig } from '../shared/config.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Lot 18a — un échec est mémorisé 60 s. Mesuré le 31/10 : `/v1/models` répond
 * 503 `catalog_build_timeout` après 8 s une fois sur deux ; sans mémoire de
 * l'échec, chaque enregistrement d'agent repayait ces 8 à 10 s.
 */
const FAILURE_TTL_MS = 60 * 1000;
/**
 * Lot 18a — temps maximal que `getConfigSchema()` accorde à la découverte quand
 * aucun catalogue n'est encore connu. Paperclip appelle ce hook à chaque
 * enregistrement d'agent et à chaque démarrage de run : il ne doit jamais
 * attendre la passerelle plus longtemps que ça.
 */
export const SCHEMA_DISCOVERY_BUDGET_MS = 1_500;

interface CacheEntry {
  expiresAt: number;
  models: AdapterModel[];
}

const cache = new Map<string, CacheEntry>();
/** Lot 18c — derniers noms de combos lus sur `/v1/combos`, par passerelle. */
const comboNames = new Map<string, string[]>();
/** Une seule découverte en vol par passerelle : les appels simultanés la partagent. */
const inflight = new Map<string, Promise<AdapterModel[]>>();
const modelContextCache = new Map<string, number>();

/** Valeurs de repli connues pour nos combos si la découverte n'a pas encore tourné. */
const KNOWN_COMBO_CONTEXTS: Record<string, number> = {
  'auto/best-coding': 2_000_000,
  'auto/best-reasoning': 2_000_000,
  'auto/best-chat': 2_000_000,
  'AC-main': 872_000,
  'AC-pro-coding': 872_000,
  'AC-code': 872_000,
  'AC-fast': 1_000_000,
  'AC-free': 256_000,
  'AC-reflection': 872_000,
  'AC-factcheck': 1_000_000,
  'AC-user': 1_000_000,
  'AC-task': 500_000,
  'AC-vision': 1_000_000,
  'AC-compression': 1_000_000,
  'AC-local-code': 500_000,
  'AC-local-fast': 500_000,
};

/** Renvoie la taille de contexte (en tokens) d'un modèle ou combo s'il est connu. */
export function getModelContextLength(modelId: string): number | undefined {
  const cached = modelContextCache.get(modelId);
  if (cached !== undefined) return cached;
  return KNOWN_COMBO_CONTEXTS[modelId];
}

/**
 * Liste les modèles, éventuellement en forçant le rafraîchissement.
 *
 * Le contrat `ServerAdapterModule.listModels` ne reçoit **aucune** config : le
 * hook est global à l'adaptateur, pas lié à un agent. On résout donc la
 * configuration par défaut (défauts + variables d'environnement) — un agent
 * qui pointe une autre passerelle découvre ses modèles via le sélecteur du
 * board, qui passe par `refreshAdapterModels` et non par ce hook.
 *
 * En cas d'échec réseau on renvoie `[]` plutôt que de propager : un sélecteur
 * vide est un état d'UI acceptable, une exception ne l'est pas. Le détail de
 * l'échec reste visible via le test d'environnement, qui est l'endroit prévu
 * pour diagnostiquer.
 */
export async function listModels(
  options: { refresh?: boolean } = {},
): Promise<AdapterModel[]> {
  const resolved = resolveConfig({});
  if (!resolved.apiKey) return combos();

  const cacheKey = `${resolved.baseUrl}|${resolved.apiKeySource}`;
  if (!options.refresh) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.models;
  }
  const running = inflight.get(cacheKey);
  if (running) return running;

  const discovery = discover(cacheKey, resolved).finally(() => {
    if (inflight.get(cacheKey) === discovery) inflight.delete(cacheKey);
  });
  inflight.set(cacheKey, discovery);
  return discovery;
}

async function discover(
  cacheKey: string,
  resolved: ReturnType<typeof resolveConfig>,
): Promise<AdapterModel[]> {
  const client = new OmniRouteClient({
    baseUrl: resolved.baseUrl,
    // listModels() a déjà vérifié la présence de la clé.
    apiKey: resolved.apiKey ?? '',
    requestTimeoutMs: Math.min(resolved.requestTimeoutMs, 20_000),
  });

  // Lot 18c — `/v1/combos` (≈ 0,1 s) en parallèle de `/v1/models` (≈ 5 s, ou
  // 503 après 8 s) : nos combos AC-* restent proposés même si le catalogue
  // complet de la passerelle est en panne.
  const names = client
    .listComboNames()
    .then((list) => {
      if (list.length > 0) comboNames.set(cacheKey, list);
      return list;
    })
    .catch(() => comboNames.get(cacheKey) ?? []);

  try {
    const specs = await client.listModelSpecs();
    for (const spec of specs) {
      if (spec.contextLength) modelContextCache.set(spec.id, spec.contextLength);
    }
    const models = selectGatewayModels([...specs.map((s) => s.id), ...(await names)]);
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, models });
    void saveDiskCatalog(resolved.baseUrl, models);
    return models;
  } catch {
    // On préfère un cache périmé à une liste vide : la passerelle est peut-être
    // momentanément indisponible, pas les modèles. Ordre : cache mémoire, puis
    // dernier catalogue réussi sur disque (lot 18c), puis combos de secours ;
    // complété par `/v1/combos`. L'échec est mémorisé FAILURE_TTL_MS pour ne
    // pas repayer le délai à chaque appel (lot 18a).
    const stale = cache.get(cacheKey)?.models ?? loadDiskCatalog(resolved.baseUrl) ?? combos();
    const models = selectGatewayModels([...stale.map((m) => m.id), ...(await names)]);
    cache.set(cacheKey, { expiresAt: Date.now() + FAILURE_TTL_MS, models });
    return models;
  }
}

/**
 * Lot 18c — dernier catalogue réussi conservé sur disque, sous
 * `$PAPERCLIP_HOME/adapter-data/omniroute-native/catalog.json` (0600) : après
 * un redémarrage de Paperclip, le sélecteur affiche tout de suite la liste
 * complète, même si `/v1/models` est en panne. Seuls les identifiants `auto/*`
 * et `AC-*` et leurs tailles de contexte y sont écrits (aucun secret).
 */
function diskCatalogPath(): string | null {
  const home = process.env['PAPERCLIP_HOME']?.trim();
  return home ? path.join(home, 'adapter-data', 'omniroute-native', 'catalog.json') : null;
}

function loadDiskCatalog(baseUrl: string): AdapterModel[] | null {
  const file = diskCatalogPath();
  if (!file) return null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      baseUrl?: unknown; ids?: unknown; contexts?: Record<string, unknown>;
    };
    if (saved.baseUrl !== baseUrl || !Array.isArray(saved.ids)) return null;
    for (const [id, value] of Object.entries(saved.contexts ?? {})) {
      if (typeof value === 'number' && value > 0 && !modelContextCache.has(id)) modelContextCache.set(id, value);
    }
    const models = selectGatewayModels(saved.ids.filter((id): id is string => typeof id === 'string'));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function saveDiskCatalog(baseUrl: string, models: AdapterModel[]): Promise<void> {
  const file = diskCatalogPath();
  if (!file || models.length === 0) return;
  const contexts: Record<string, number> = {};
  for (const model of models) {
    const length = modelContextCache.get(model.id);
    if (length) contexts[model.id] = length;
  }
  const body = JSON.stringify({ savedAt: new Date().toISOString(), baseUrl, ids: models.map((m) => m.id), contexts });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, file);
  } catch {
    /* écriture facultative : un disque en lecture seule ne doit rien casser */
  }
}

/**
 * Lot 18a — modèles pour `getConfigSchema()`, sans jamais bloquer longtemps :
 * - catalogue frais : renvoyé tel quel, aucun appel réseau ;
 * - catalogue périmé : renvoyé tout de suite, rafraîchi en arrière-plan ;
 * - aucun catalogue : découverte limitée à SCHEMA_DISCOVERY_BUDGET_MS, puis
 *   combos de secours (la découverte continue et remplira le cache).
 */
export async function listModelsForSchema(): Promise<AdapterModel[]> {
  const resolved = resolveConfig({});
  if (!resolved.apiKey) return combos();
  const cacheKey = `${resolved.baseUrl}|${resolved.apiKeySource}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    if (hit.expiresAt <= Date.now()) void listModels().catch(() => undefined);
    return hit.models;
  }
  // Lot 18c — après un redémarrage : dernier catalogue réussi, tout de suite,
  // et rafraîchissement en arrière-plan.
  const disk = loadDiskCatalog(resolved.baseUrl);
  if (disk) {
    cache.set(cacheKey, { expiresAt: 0, models: disk });
    void listModels().catch(() => undefined);
    return disk;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<AdapterModel[]>((resolve) => {
    timer = setTimeout(
      () => resolve(selectGatewayModels([...combos().map((m) => m.id), ...(comboNames.get(cacheKey) ?? [])])),
      SCHEMA_DISCOVERY_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([listModels(), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Repli utilisé quand la passerelle est injoignable.
 *
 * Ces valeurs de secours couvrent les deux familles même sans réseau. La
 * découverte authentifiée les remplace dès que la passerelle répond.
 */
function combos(): AdapterModel[] {
  return [
    { id: 'auto/best-coding', label: 'auto/best-coding' },
    { id: 'auto/best-reasoning', label: 'auto/best-reasoning' },
    { id: 'auto/best-chat', label: 'auto/best-chat' },
    { id: 'AC-main', label: 'AC-main — combo AC-Création' },
    { id: 'AC-pro-coding', label: 'AC-pro-coding — combo AC-Création' },
    { id: 'AC-task', label: 'AC-task — combo AC-Création' },
  ];
}

/**
 * Familles autorisées dans le sélecteur de l'agent.
 *
 * - `auto/*` : les combos génériques d'OmniRoute (choix de famille :
 *   code, raisonnement, chat, vision…).
 * - `AC-*` : nos propres combos d'agence (AC-main, AC-pro-coding, AC-task…).
 *
 * Tout le reste — les ~3 000 modèles de fournisseur préfixés
 * (`claude/…`, `openai/…`, `minimax/…`) — est **écarté**. Un agent doit choisir
 * un *combo*, pas un modèle brut : le combo porte la politique de routage
 * (fallback, quotas, arbitrage coût/qualité), le modèle brut la court-circuite.
 */
const AUTO_PREFIX = 'auto/';

/** Un nom de combo AC-* : `AC-` suivi d'au moins un caractère. */
const AGENCY_COMBO = /^AC-.+$/;

/**
 * Ne garde que les deux familles autorisées, `auto/*` d'abord.
 *
 * Fonction pure et testée : c'est le contrat affiché à l'opérateur, il ne
 * doit pas dépendre de l'ordre d'arrivée de la passerelle.
 */
export function selectGatewayModels(ids: string[]): AdapterModel[] {
  const seen = new Set<string>();
  const auto: AdapterModel[] = [];
  const agency: AdapterModel[] = [];

  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    if (id.startsWith(AUTO_PREFIX)) {
      auto.push({ id, label: id });
    } else if (AGENCY_COMBO.test(id)) {
      agency.push({ id, label: `${id} — combo AC-Création` });
    }
  }

  auto.sort((a, b) => a.id.localeCompare(b.id));
  agency.sort((a, b) => a.id.localeCompare(b.id));
  return [...auto, ...agency];
}

/** Vide le cache — utilisé par les tests. */
export function clearModelCache(): void {
  cache.clear();
  comboNames.clear();
  inflight.clear();
  modelContextCache.clear();
}

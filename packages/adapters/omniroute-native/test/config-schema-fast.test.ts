/**
 * Lot 18a — enregistrement de configuration rapide (Paperclip ACC-2301).
 *
 * Mesuré le 31/10 (D-exploitation.md Q4) : Paperclip appelle getConfigSchema()
 * à chaque PATCH d'agent et à chaque démarrage de run ; notre getConfigSchema()
 * attendait GET /v1/models (9,3 Mo, 5 réponses 503 sur 9 après 8 s) et un échec
 * n'était pas mis en cache → PATCH de 7,6 à 20 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearModelCache, listModels, SCHEMA_DISCOVERY_BUDGET_MS } from '../src/server/models.js';
import { createServerAdapter } from '../src/server/index.js';

const catalog = { data: [{ id: 'auto/best-coding' }, { id: 'AC-main' }, { id: 'AC-pro-coding' }, { id: 'claude/claude-opus-5' }] };
const ok = () => new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } });
const unavailable = () => new Response(JSON.stringify({ error: { message: 'catalog_build_timeout' } }), { status: 503, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  clearModelCache();
  vi.stubEnv('OMNIROUTE_API_KEY', 'cle-fictive-de-test');
  vi.stubEnv('OMNIROUTE_BASE_URL', 'http://passerelle.invalid');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Lot 18c : une découverte = 1 appel `/v1/models` + 1 appel `/v1/combos`.
// Ces tests portent sur `/v1/models` (le coûteux) : on ne compte que lui.
const modelsCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter(([input]) => String(input).endsWith('/v1/models')).length;

describe('lot 18a — découverte des modèles', () => {
  it('un échec est mémorisé : le 2e appel ne rappelle pas la passerelle', async () => {
    const fetchMock = vi.fn(async () => unavailable());
    vi.stubGlobal('fetch', fetchMock);
    const first = await listModels();
    const second = await listModels();
    expect(first.map((m) => m.id)).toContain('AC-main');
    expect(second).toEqual(first);
    expect(modelsCalls(fetchMock)).toBe(1);
  });

  it('deux appels simultanés ne font qu’une seule requête', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([listModels(), listModels()]);
    expect(a).toEqual(b);
    expect(modelsCalls(fetchMock)).toBe(1);
  });

  it('un rafraîchissement explicite ignore le cache d’échec', async () => {
    const fetchMock = vi.fn(async () => unavailable());
    vi.stubGlobal('fetch', fetchMock);
    await listModels();
    fetchMock.mockImplementation(async () => ok());
    const refreshed = await listModels({ refresh: true });
    expect(refreshed.map((m) => m.id)).toEqual(['auto/best-coding', 'AC-main', 'AC-pro-coding']);
    expect(modelsCalls(fetchMock)).toBe(2);
  });
});

describe('lot 18a — getConfigSchema ne bloque pas l’enregistrement', () => {
  it('passerelle figée : le schéma revient dans le budget, avec les combos de secours', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const adapter = createServerAdapter();
    const started = Date.now();
    const schema = await adapter.getConfigSchema!();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(SCHEMA_DISCOVERY_BUDGET_MS + 500);
    const model = schema.fields.find((f) => f.key === 'model') as { options?: Array<{ value: string }> };
    expect(model.options?.map((o) => o.value)).toContain('AC-pro-coding');
  });

  it('catalogue déjà connu : réponse immédiate sans appel réseau', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await listModels();
    fetchMock.mockClear();
    const adapter = createServerAdapter();
    const started = Date.now();
    const schema = await adapter.getConfigSchema!();
    expect(Date.now() - started).toBeLessThan(50);
    expect(fetchMock).not.toHaveBeenCalled();
    const fallback = schema.fields.find((f) => f.key === 'fallbackModel') as { options?: Array<{ value: string }> };
    expect(fallback.options?.map((o) => o.value)).toEqual(['aucun', 'auto/best-coding', 'AC-main', 'AC-pro-coding']); // lot 21a : « aucun » en tête
  });

  it('catalogue périmé : réponse immédiate avec l’ancien catalogue, rafraîchi en arrière-plan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await listModels();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    fetchMock.mockClear();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const model = schema.fields.find((f) => f.key === 'model') as { options?: Array<{ value: string }> };
    expect(model.options?.map((o) => o.value)).toEqual(['auto/best-coding', 'AC-main', 'AC-pro-coding']);
    expect(modelsCalls(fetchMock)).toBe(1);
  });
});

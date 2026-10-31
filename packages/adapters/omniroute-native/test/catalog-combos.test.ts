/**
 * Lot 18c — catalogue des modèles complet même quand `/v1/models` est en panne
 * (Paperclip ACC-2327).
 *
 * Mesuré le 31/10 à 14:15 depuis le conteneur paperclip : `GET /v1/models`
 * répond 503 après 8 s (catalog_build_timeout) ; `GET /v1/combos` répond 200
 * en 84 ms (11 Ko, nos 15 combos AC-*). Après la mise en ligne, le sélecteur
 * ne montrait plus que les 6 combos de secours codés en dur.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearModelCache, getModelContextLength, listModels, listModelsForSchema } from '../src/server/models.js';

const AC = ['AC-main', 'AC-pro-coding', 'AC-code', 'AC-task', 'AC-vision', 'AC-reflection'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const modelsOk = () =>
  json({ data: [
    { id: 'auto/best-coding', context_length: 2_000_000 }, { id: 'auto/claude-opus' }, { id: 'auto/thrifty' },
    { id: 'AC-main', context_length: 872_000 }, { id: 'claude/claude-opus-5-5' },
  ] });
const modelsDown = () => json({ error: { message: 'catalog_build_timeout' } }, 503);
const combosOk = () => json({ object: 'list', data: AC.map((name) => ({ name, strategy: 'priority', models: [] })) });

type Route = (url: string) => Promise<Response>;
function routed(models: Route, combos: Route) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v1/combos')) return combos(url);
    if (url.endsWith('/v1/models')) return models(url);
    return json({ error: 'route inconnue' }, 404);
  });
}
const callsTo = (mock: ReturnType<typeof routed>, suffix: string) =>
  mock.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith(suffix)).length;

let home: string;
beforeEach(async () => {
  clearModelCache();
  home = await mkdtemp(path.join(os.tmpdir(), 'lot18c-'));
  vi.stubEnv('OMNIROUTE_API_KEY', 'cle-fictive-de-test');
  vi.stubEnv('OMNIROUTE_BASE_URL', 'http://passerelle.invalid');
  vi.stubEnv('PAPERCLIP_HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

describe('lot 18c — /v1/models en panne', () => {
  it('tous nos combos AC-* restent proposés grâce à /v1/combos', async () => {
    vi.stubGlobal('fetch', routed(async () => modelsDown(), async () => combosOk()));
    const ids = (await listModels()).map((m) => m.id);
    for (const name of AC) expect(ids).toContain(name);
    expect(ids).toContain('auto/best-coding');
  });

  it('getConfigSchema (budget 1,5 s) voit aussi tous les AC-* quand /v1/models est lent', async () => {
    vi.stubGlobal(
      'fetch',
      routed(() => new Promise<Response>((resolve) => setTimeout(() => resolve(modelsDown()), 5_000)), async () => combosOk()),
    );
    const started = Date.now();
    const ids = (await listModelsForSchema()).map((m) => m.id);
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const name of AC) expect(ids).toContain(name);
  });
});

describe('lot 18c — dernier catalogue réussi conservé sur disque', () => {
  it('écrit le catalogue filtré (auto/* + AC-*) avec les contextes, fichier 0600', async () => {
    vi.stubGlobal('fetch', routed(async () => modelsOk(), async () => combosOk()));
    await listModels();
    const file = path.join(home, 'adapter-data', 'omniroute-native', 'catalog.json');
    await vi.waitFor(async () => expect((await stat(file)).isFile()).toBe(true));
    const saved = JSON.parse(await readFile(file, 'utf8')) as { ids: string[]; contexts: Record<string, number> };
    expect(saved.ids).toContain('auto/thrifty');
    expect(saved.ids).toContain('AC-task');
    expect(saved.ids).not.toContain('claude/claude-opus-5-5');
    expect(saved.contexts['AC-main']).toBe(872_000);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('après un redémarrage, /v1/models en panne : le catalogue complet revient du disque', async () => {
    vi.stubGlobal('fetch', routed(async () => modelsOk(), async () => combosOk()));
    await listModels();
    const file = path.join(home, 'adapter-data', 'omniroute-native', 'catalog.json');
    await vi.waitFor(async () => expect((await stat(file)).isFile()).toBe(true));

    clearModelCache(); // simule le redémarrage du serveur
    vi.stubGlobal('fetch', routed(async () => modelsDown(), async () => json({ error: 'down' }, 503)));
    const ids = (await listModels()).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['auto/claude-opus', 'auto/thrifty', 'AC-main', 'AC-task']));
    expect(getModelContextLength('AC-main')).toBe(872_000);
  });

  it('getConfigSchema répond tout de suite depuis le disque, sans attendre la passerelle', async () => {
    vi.stubGlobal('fetch', routed(async () => modelsOk(), async () => combosOk()));
    await listModels();
    const file = path.join(home, 'adapter-data', 'omniroute-native', 'catalog.json');
    await vi.waitFor(async () => expect((await stat(file)).isFile()).toBe(true));

    clearModelCache();
    const hanging = routed(() => new Promise<Response>(() => {}), () => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', hanging);
    const started = Date.now();
    const ids = (await listModelsForSchema()).map((m) => m.id);
    expect(Date.now() - started).toBeLessThan(200);
    expect(ids).toContain('auto/thrifty');
    expect(callsTo(hanging, '/v1/models')).toBeLessThanOrEqual(1); // rafraîchissement en arrière-plan
  });

  it('sans PAPERCLIP_HOME : aucune écriture, aucune erreur', async () => {
    vi.stubEnv('PAPERCLIP_HOME', '');
    vi.stubGlobal('fetch', routed(async () => modelsOk(), async () => combosOk()));
    await expect(listModels()).resolves.toBeTruthy();
  });
});

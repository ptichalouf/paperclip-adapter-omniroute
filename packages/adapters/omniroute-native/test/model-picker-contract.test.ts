import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerAdapter } from '../src/server/index.js';
import { clearModelCache } from '../src/server/models.js';

// La fixture remplace uniquement la frontière HTTP. Tous les hooks chargés par
// Paperclip restent réels : c'est leur câblage, pas le filtre seul, qui régressait.
const gatewayIds = [
  'auto/best-coding', 'auto/best-chat', 'auto/best-free', 'auto/pro-coding',
  'auto/best-vision', 'AC-main', 'AC-pro-coding', 'AC-code', 'AC-chat',
  'openai/gpt-test',
];
const expected = gatewayIds.filter((id) => id.startsWith('auto/') || id.startsWith('AC-')).sort();

beforeEach(() => {
  vi.stubEnv('OMNIROUTE_API_KEY', 'fixture-only');
  vi.stubEnv('OMNIROUTE_BASE_URL', 'http://gateway.fixture');
  clearModelCache();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    data: gatewayIds.map((id) => ({ id })),
  }), { headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearModelCache(); });

// Lot 18c : une découverte = 1 appel `/v1/models` + 1 appel `/v1/combos`.
// Ces tests portent sur le catalogue `/v1/models` : on ne compte que lui.
// Lot 21a : les menus facultatifs (dont le repli) commencent par « aucun ».
const catalogOptions = (field: { options?: Array<{ value: string }> } | undefined) => {
  const values = field?.options?.map((o) => o.value) ?? [];
  return values[0] === 'aucun' ? values.slice(1) : values;
};

const modelsCalls = () =>
  vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/v1/models')).length;

describe('sélecteurs réellement livrés à Paperclip', () => {
  it('charge tous les combos dès la première ouverture du principal', async () => {
    const adapter = createServerAdapter();
    const choices = await adapter.listModels!();
    expect(choices.map((m) => m.id).sort()).toEqual(expected);
    expect(modelsCalls()).toBe(1);
  });

  it('hydrate les options du principal ET du repli avec le même catalogue', async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    for (const key of ['model', 'fallbackModel']) {
      const field = schema.fields.find((field) => field.key === key)!;
      expect(field.type).toBe('combobox');
      expect(catalogOptions(field).sort()).toEqual(expected);
    }
    const principal = await adapter.listModels!();
    expect(catalogOptions(schema.fields.find((f) => f.key === 'fallbackModel')).sort())
      .toEqual(principal.map((m) => m.id).sort());
    expect(schema.fields.find((f) => f.key === 'fallbackModel')!.options?.[0]?.value).toBe('aucun');
    expect(modelsCalls()).toBe(1);
  });

  it('rafraîchit le catalogue commun quand OmniRoute ajoute une combinaison', async () => {
    const adapter = createServerAdapter();
    await adapter.listModels!();
    const added = [...gatewayIds, 'AC-nouvelle-combinaison'];
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: added.map((id) => ({ id })) })));
    const refreshed = await adapter.refreshModels!();
    const schema = await adapter.getConfigSchema!();
    expect(refreshed.map((m) => m.id)).toContain('AC-nouvelle-combinaison');
    expect(catalogOptions(schema.fields.find((f) => f.key === 'fallbackModel')))
      .toEqual(refreshed.map((m) => m.id));
    expect(modelsCalls()).toBe(2);
  });

  it('garde les choix personnels dans les deux champs quand la passerelle est indisponible', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('réseau coupé'));
    const adapter = createServerAdapter();
    const models = await adapter.listModels!();
    const schema = await adapter.getConfigSchema!();
    expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(['AC-main', 'AC-pro-coding']));
    expect(catalogOptions(schema.fields.find((f) => f.key === 'fallbackModel')))
      .toEqual(models.map((m) => m.id));
  });
});

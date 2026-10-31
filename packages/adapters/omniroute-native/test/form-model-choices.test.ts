/**
 * Lot 21a — formulaire de l'agent : choix de modèles par menus déroulants
 * (retour d'Alexandre du 31/10 15:02 : « Modèles d'escalade » était un champ
 * texte libre à virgules, pris pour un menu déroulant cassé).
 *
 * Paperclip ne connaît pas la multi-sélection (types : text, select, toggle,
 * number, textarea, combobox) et son combobox ne sait pas revenir à « vide »
 * (ui/src/adapters/schema-config-fields.tsx : Entrée sur un filtre vide ne
 * valide rien). D'où : deux menus d'escalade, et un choix « aucun » explicite
 * dans chaque menu facultatif ; champs secondaires masqués tant que la
 * fonction est désactivée (`meta.visibleWhen`, même fichier, l. 287-317).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAdapter } from '../src/server/index.js';
import { clearModelCache } from '../src/server/models.js';
import { resolveConfig } from '../src/shared/config.js';

const catalog = ['auto/best-coding', 'AC-code', 'AC-pro-coding', 'AC-task'];

beforeEach(() => {
  clearModelCache();
  vi.stubEnv('OMNIROUTE_API_KEY', 'cle-fictive-de-test');
  vi.stubEnv('OMNIROUTE_BASE_URL', 'http://passerelle.invalid');
  vi.stubEnv('PAPERCLIP_HOME', '');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = url.endsWith('/v1/combos')
      ? { data: catalog.filter((id) => id.startsWith('AC-')).map((name) => ({ name })) }
      : { data: catalog.map((id) => ({ id })) };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearModelCache();
});

async function fields() {
  const adapter = createServerAdapter();
  await adapter.listModels!();
  const schema = await adapter.getConfigSchema!();
  return Object.fromEntries(schema.fields.map((f) => [f.key, f])) as Record<string, (typeof schema.fields)[number]>;
}
const values = (field: { options?: Array<{ value: string }> } | undefined) => field?.options?.map((o) => o.value) ?? [];

describe('lot 21a — menus de modèles du formulaire', () => {
  it('escalade : deux menus déroulants alimentés par le catalogue, plus de champ texte à virgules', async () => {
    const f = await fields();
    expect(f['escalationModels']).toBeUndefined();
    for (const key of ['escalationModel', 'escalationModel2']) {
      expect(f[key]?.type).toBe('combobox');
      expect(values(f[key])).toEqual(['aucun', 'auto/best-coding', 'AC-code', 'AC-pro-coding', 'AC-task']);
    }
  });

  it('« aucun » en tête des menus facultatifs, absent du modèle principal', async () => {
    const f = await fields();
    for (const key of ['fallbackModel', 'subtaskModel', 'escalationModel', 'escalationModel2']) {
      expect(values(f[key])[0]).toBe('aucun');
    }
    expect(values(f['model'])).not.toContain('aucun');
  });

  it('les réglages secondaires ne s’affichent que si la fonction est activée', async () => {
    const f = await fields();
    const hidden = { key: 'escalationModel', notValues: ['', 'aucun'] };
    expect(f['escalationModel2']?.meta?.['visibleWhen']).toEqual(hidden);
    expect(f['maxEscalations']?.meta?.['visibleWhen']).toEqual(hidden);
    for (const key of ['subtaskMaxTurns', 'subtaskTimeoutSec']) {
      expect(f[key]?.meta?.['visibleWhen']).toEqual({ key: 'subtaskModel', notValues: ['', 'aucun'] });
    }
  });
});

describe('lot 21a — lecture de la configuration', () => {
  it('les deux menus forment l’échelle d’escalade, dans l’ordre', () => {
    expect(resolveConfig({ escalationModel: 'AC-code', escalationModel2: 'AC-pro-coding' }).escalationModels)
      .toEqual(['AC-code', 'AC-pro-coding']);
  });

  it('« aucun » vaut désactivé partout', () => {
    const c = resolveConfig({ fallbackModel: 'aucun', subtaskModel: 'Aucun', escalationModel: 'aucun', escalationModel2: 'AC-code' });
    expect(c.fallbackModel).toBeNull();
    expect(c.subtaskModel).toBeNull();
    expect(c.escalationModels).toEqual([]);
  });

  it('« aucun » au premier menu neutralise le second menu masqué', () => {
    expect(resolveConfig({ escalationModel: 'aucun', escalationModel2: 'AC-pro-coding' }).escalationModels)
      .toEqual([]);
  });

  it('« aucun » au premier menu neutralise l’ancien champ texte', () => {
    expect(resolveConfig({ escalationModel: 'aucun', escalationModels: 'AC-code' }).escalationModels)
      .toEqual([]);
  });

  it('premier menu vide ou absent : les configurations existantes restent lues', () => {
    for (const escalationModel of ['', '   ', undefined]) {
      expect(resolveConfig({ escalationModel, escalationModels: 'AC-code' }).escalationModels)
        .toEqual(['AC-code']);
      expect(resolveConfig({ escalationModel, escalationModel2: 'AC-pro-coding' }).escalationModels)
        .toEqual(['AC-pro-coding']);
    }
  });

  it('compatibilité : l’ancien champ texte escalationModels reste lu, sans doublon', () => {
    expect(resolveConfig({ escalationModels: 'AC-code, AC-pro-coding' }).escalationModels).toEqual(['AC-code', 'AC-pro-coding']);
    expect(resolveConfig({ escalationModel: 'AC-code', escalationModels: 'AC-code, AC-pro-coding' }).escalationModels)
      .toEqual(['AC-code', 'AC-pro-coding']);
  });

  it('par défaut, autant d’escalades que de modèles choisis (2 menus)', () => {
    expect(resolveConfig({ escalationModel: 'AC-code', escalationModel2: 'AC-pro-coding' }).maxEscalations).toBe(2);
    expect(resolveConfig({ escalationModel: 'AC-code', maxEscalations: 1 }).maxEscalations).toBe(1);
  });
});

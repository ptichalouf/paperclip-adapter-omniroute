import { describe, expect, it } from 'vitest';

import type { AdapterModel } from '@paperclipai/adapter-utils';

import { selectGatewayModels } from '../src/server/models.js';

describe('selectGatewayModels — exposer auto/* et nos combos AC-*', () => {
  const gateway = [
    'auto/best-coding',
    'auto/best-reasoning',
    'AC-main',
    'AC-pro-coding',
    'AC-task',
    'claude/claude-sonnet-5',
    'claude/claude-opus-5',
    'openai/gpt-4o-mini',
    'recursive/flint-v1.0:free',
    'minimax/MiniMax-M3.1-Flash-Preview',
    'codex/gpt-6.1-sol',
    'agy/gemini-3.8-flash-high',
    'auto/best-free',
  ];

  it('ne garde que les deux familles autorisées : auto/* et AC-*', () => {
    const ids = selectGatewayModels(gateway).map((m: AdapterModel) => m.id);
    expect(ids).toEqual([
      'auto/best-coding',
      'auto/best-free',
      'auto/best-reasoning',
      'AC-main',
      'AC-pro-coding',
      'AC-task',
    ]);
  });

  it('écarte les modèles de fournisseur préfixés', () => {
    const ids = selectGatewayModels(gateway).map((m: AdapterModel) => m.id);
    for (const id of [
      'claude/claude-sonnet-5',
      'claude/claude-opus-5',
      'openai/gpt-4o-mini',
      'recursive/flint-v1.0:free',
      'minimax/MiniMax-M3.1-Flash-Preview',
      'codex/gpt-6.1-sol',
      'agy/gemini-3.8-flash-high',
    ]) {
      expect(ids).not.toContain(id);
    }
  });

  it('classe les combos auto/* avant les combos AC-*', () => {
    const ids = selectGatewayModels(gateway).map((m: AdapterModel) => m.id);
    const lastAuto = ids.map((i: string, n: number) => (i.startsWith('auto/') ? n : -1)).filter((n: number) => n >= 0).pop();
    const firstAc = ids.findIndex((i: string) => i.startsWith('AC-'));
    expect(lastAuto).toBeLessThan(firstAc);
  });

  it('ignore un préfixe AC- mal formé ou une casse inattendue', () => {
    const ids = selectGatewayModels(['AC-main', 'ac-main', 'AC-', 'AC', 'auto/x', 'AUTO/x']).map(
      (m) => m.id,
    );
    expect(ids).toEqual(['auto/x', 'AC-main']);
  });

  it('renvoie une liste vide si rien ne correspond', () => {
    expect(selectGatewayModels(['openai/gpt-4o', 'claude/opus'])).toEqual([]);
  });

  it('ne déduplique pas deux entrées identiques de la passerelle', () => {
    const ids = selectGatewayModels(['AC-main', 'AC-main', 'auto/x', 'auto/x']).map((m: AdapterModel) => m.id);
    expect(ids).toEqual(['auto/x', 'AC-main']);
  });

  it('étiquette les AC-* comme combos de l’agence', () => {
    const models = selectGatewayModels(['AC-main', 'auto/x']);
    expect(models.find((m: AdapterModel) => m.id === 'AC-main')?.label).toContain('AC-Création');
    expect(models.find((m: AdapterModel) => m.id === 'auto/x')?.label).toBe('auto/x');
  });
});

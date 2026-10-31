import { describe, expect, it, afterEach } from 'vitest';

import { isRedactedValue, resolveConfig } from '../src/shared/config.js';

/**
 * Régression du 29/10/2026 : le champ `apiKey` de la config de l'agent
 * valait littéralement `***REDACTED***` — le masque que Paperclip réinjecte
 * quand un champ secret n'est pas déclaré comme secret dans le schéma de
 * l'adaptateur. L'adaptateur envoyait ce masque comme une clé, ce qui
 * provoquait un « auth rejected » alors que la clé d'environnement du
 * conteneur était parfaitement valide.
 */
const ORIGINAL_OMNI = process.env['OMNIROUTE_API_KEY'];
const ORIGINAL_ANTHROPIC = process.env['ANTHROPIC_API_KEY'];

afterEach(() => {
  if (ORIGINAL_OMNI === undefined) delete process.env['OMNIROUTE_API_KEY'];
  else process.env['OMNIROUTE_API_KEY'] = ORIGINAL_OMNI;
  if (ORIGINAL_ANTHROPIC === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = ORIGINAL_ANTHROPIC;
});

describe('isRedactedValue — un masque n est pas une clé', () => {
  it('reconnait le masque REDACTED de Paperclip', () => {
    expect(isRedactedValue('***REDACTED***')).toBe(true);
    expect(isRedactedValue('  ***REDACTED***  ')).toBe(true);
  });

  it('reconnait un masque elliptique', () => {
    expect(isRedactedValue('sk-d68...0988')).toBe(true);
  });

  it('ne confond pas une vraie clé', () => {
    expect(isRedactedValue('sk-d683e0d9e1234567890abcdef')).toBe(false);
    expect(isRedactedValue('a-very-long-key-without-any-mask')).toBe(false);
    expect(isRedactedValue('')).toBe(false);
  });
});

describe('resolveConfig — une clé masquée ne masque pas la clé d environnement', () => {
  it('écarte un apiKey masqué et prend celui de l environnement', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-cle-environnement-valide';
    delete process.env['OMNIROUTE_API_KEY'];

    const cfg = resolveConfig({ apiKey: '***REDACTED***' });

    expect(cfg.apiKey).toBe('sk-cle-environnement-valide');
    expect(cfg.apiKeySource).toBe('env:ANTHROPIC_API_KEY');
  });

  it('écarte une clé d environnement masquée', () => {
    process.env['OMNIROUTE_API_KEY'] = '***REDACTED***';
    process.env['ANTHROPIC_API_KEY'] = 'sk-cle-secondaire';

    const cfg = resolveConfig({});

    expect(cfg.apiKey).toBe('sk-cle-secondaire');
    expect(cfg.apiKeySource).toBe('env:ANTHROPIC_API_KEY');
  });

  it('accepte une vraie clé en configuration', () => {
    delete process.env['OMNIROUTE_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    const cfg = resolveConfig({ apiKey: 'sk-cle-en-configuration' });

    expect(cfg.apiKey).toBe('sk-cle-en-configuration');
    expect(cfg.apiKeySource).toBe('config');
  });

  it('reste sans clé si tout est masqué', () => {
    process.env['OMNIROUTE_API_KEY'] = '***REDACTED***';
    delete process.env['ANTHROPIC_API_KEY'];

    const cfg = resolveConfig({ apiKey: '***REDACTED***' });

    expect(cfg.apiKey).toBeNull();
    expect(cfg.apiKeySource).toBe('none');
  });
});

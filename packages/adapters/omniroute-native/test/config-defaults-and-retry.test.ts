import { describe, expect, it } from 'vitest';

import { parseRetryAfterHeader } from '../src/shared/client.js';
import { classifyGatewayError } from '../src/shared/errors.js';
import { DEFAULT_MAX_TURNS, resolveConfig } from '../src/shared/config.js';

describe('maxTurns — la valeur par défaut est celle du formulaire (0 = illimité, parité claude_local)', () => {
  it('applique 0 tour (illimité) quand la configuration n en porte pas', () => {
    const cfg = resolveConfig({ apiKey: 'dummy-key' });
    expect(cfg.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(cfg.maxTurns).toBe(0);
  });

  it('respecte une valeur explicite positive ou nulle', () => {
    expect(resolveConfig({ apiKey: 'dummy-key', maxTurns: 3 }).maxTurns).toBe(3);
    expect(resolveConfig({ apiKey: 'dummy-key', maxTurns: '12' }).maxTurns).toBe(12);
    expect(resolveConfig({ apiKey: 'dummy-key', maxTurns: 0 }).maxTurns).toBe(0);
  });

  it('refuse une valeur négative ou invalide', () => {
    expect(resolveConfig({ apiKey: 'dummy-key', maxTurns: -5 }).maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(resolveConfig({ apiKey: 'dummy-key', maxTurns: 'abc' }).maxTurns).toBe(DEFAULT_MAX_TURNS);
  });
});

describe('parseRetryAfterHeader — lecture du header Retry-After', () => {
  it('lit la forme « nombre de secondes »', () => {
    expect(parseRetryAfterHeader('30')).toBe(30);
    expect(parseRetryAfterHeader('120')).toBe(120);
    expect(parseRetryAfterHeader('  45  ')).toBe(45);
  });

  it('lit la forme « date HTTP absolue »', () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfterHeader(when);
    expect(parsed).toBeGreaterThan(50);
    expect(parsed).toBeLessThanOrEqual(61);
  });

  it('rejette ce qui est inexploitable', () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader('')).toBeUndefined();
    expect(parseRetryAfterHeader('   ')).toBeUndefined();
    expect(parseRetryAfterHeader('bientôt')).toBeUndefined();
    expect(parseRetryAfterHeader('0')).toBeUndefined();
    expect(parseRetryAfterHeader('-10')).toBeUndefined();
  });

  it('ne renvoie pas un délai négatif pour une date passée', () => {
    const when = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterHeader(when)).toBeUndefined();
  });
});

describe('retryNotBefore — le délai de reprise atteint la classification', () => {
  it('renseigne retryNotBefore quand la passerelle indique un délai', () => {
    const classified = classifyGatewayError({
      status: 429,
      message: 'admission capacity temporarily unavailable',
      retryAfterSec: 42,
    });
    expect(classified.retryNotBefore).not.toBeNull();
    // Le délai annoncé est d environ 42 s.
    const until = Date.parse(classified.retryNotBefore ?? '');
    expect(until - Date.now()).toBeGreaterThan(35_000);
    expect(until - Date.now()).toBeLessThanOrEqual(42_000);
  });

  it('laisse retryNotBefore nul quand aucun delai n est fourni', () => {
    const classified = classifyGatewayError({ status: 503, message: 'temporarily unavailable' });
    expect(classified.retryNotBefore).toBeNull();
  });
});

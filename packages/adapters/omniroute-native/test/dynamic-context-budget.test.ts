import { describe, expect, it } from 'vitest';
import {
  resolveHistoryBudgetChars,
  resolveIntraRunBudgetChars,
  DEFAULT_MIN_HISTORY_CHAR_BUDGET,
  DEFAULT_MAX_HISTORY_CHAR_BUDGET,
} from '../src/server/session.js';
import { classifyGatewayError } from '../src/shared/errors.js';
import { configSchema } from '../src/server/config-schema.js';

describe('Lot 5 — Dimensionnement dynamique du contexte et garde de dépassement', () => {
  it('résout le budget par défaut à DEFAULT_MIN_HISTORY_CHAR_BUDGET (100k chars) si aucune info', () => {
    const budget = resolveHistoryBudgetChars('unknown-model', undefined);
    expect(budget).toBe(DEFAULT_MIN_HISTORY_CHAR_BUDGET);
    expect(budget).toBeGreaterThanOrEqual(100_000);
  });

  it('augmente dynamiquement le budget pour les grands modèles comme AC-pro-coding (872k tokens)', () => {
    // 872k tokens -> 872 000 * 3.5 * 0.40 ~ 1.2M -> plafonné au plafond d'hygiène (400k chars)
    const budget = resolveHistoryBudgetChars('AC-pro-coding', 872_000);
    expect(budget).toBe(DEFAULT_MAX_HISTORY_CHAR_BUDGET);
    expect(budget).toBe(400_000);
  });

  it('calcule un budget proportionné pour un modèle intermédiaire', () => {
    // 100k tokens -> 100 000 * 3.5 * 0.40 = 140 000 chars
    const budget = resolveHistoryBudgetChars('test-medium', 100_000);
    expect(budget).toBe(140_000);
  });

  it('respecte un budget explicite renseigné par l opérateur', () => {
    const budget = resolveHistoryBudgetChars('AC-pro-coding', 872_000, 60_000);
    expect(budget).toBe(60_000);
  });

  it('calcule le budget intra-run proportionné avec un plancher de 100k et plafond de 600k', () => {
    const defaultIntra = resolveIntraRunBudgetChars('unknown-model', undefined);
    expect(defaultIntra).toBe(100_000);

    const proIntra = resolveIntraRunBudgetChars('AC-pro-coding', 872_000);
    expect(proIntra).toBe(600_000);

    const explicitIntra = resolveIntraRunBudgetChars('AC-pro-coding', 872_000, 80_000);
    expect(explicitIntra).toBe(80_000);
  });

  it('classifie les erreurs amont de dépassement de contexte en omniroute_context_length_exceeded', () => {
    const samples = [
      { message: 'Input exceeds maximum context length of 131072 tokens', status: 400 },
      { message: 'prompt is too long: 150000 tokens > 131072 maximum', status: 400 },
      { code: 'context_length_exceeded', message: 'The request was too large for this model', status: 400 },
      { message: 'maximum context length exceeded', status: 400 },
    ];

    for (const sample of samples) {
      const classified = classifyGatewayError(sample);
      expect(classified.errorCode).toBe('omniroute_context_length_exceeded');
      expect(classified.retryable).toBe(false);
      expect(classified.summary).toContain('contexte');
    }
  });

  it('expose le champ optionnel maxContextChars dans configSchema', () => {
    const field = configSchema.fields.find((f) => f.key === 'maxContextChars');
    expect(field).toBeDefined();
    expect(field?.type).toBe('number');
    expect(field?.group).toBe('Modèle');
  });
});

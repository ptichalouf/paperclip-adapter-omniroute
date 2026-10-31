import { describe, expect, it } from 'vitest';

import { projectChunk, toPaperclipUsage } from '../src/shared/chat-completions.js';
import { resolveRunCostUsd } from '../src/server/execute.js';

/**
 * Lot 10 — compteurs justes. Formes d'usage réelles mesurées le 31/10/2026 sur
 * OmniRoute (AC-pro-coding → claude-opus-5-5), en streaming.
 */
const firstCall = {
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 13,
    completion_tokens: 4,
    cache_creation_input_tokens: 16826,
    prompt_tokens_details: { cache_creation_in_prompt: false },
  },
};
const secondCall = {
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 16839,
    completion_tokens: 4,
    prompt_tokens_details: { cached_tokens: 16826 },
    cache_read_input_tokens: 16826,
  },
};

describe('lot 10 — usage OmniRoute vers la convention Paperclip', () => {
  it('lit les écritures du cache (hors prompt_tokens)', () => {
    const u = projectChunk(firstCall as never)!.usage!;
    expect(u).toMatchObject({ inputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 16826, cacheWriteInPrompt: false });
  });

  it('lit les lectures du cache (dans prompt_tokens)', () => {
    const u = projectChunk(secondCall as never)!.usage!;
    expect(u).toMatchObject({ inputTokens: 16839, cacheReadTokens: 16826, cacheWriteTokens: 0 });
  });

  it('1er appel : entrée = non caché + écritures', () => {
    expect(toPaperclipUsage({ promptTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 16826, cacheWriteInPrompt: false }))
      .toEqual({ inputTokens: 16839, cacheReadTokens: 0, cacheWriteTokens: 16826 });
  });

  it('2e appel : les lectures du cache ne sont plus comptées deux fois', () => {
    expect(toPaperclipUsage({ promptTokens: 16839, cacheReadTokens: 16826, cacheWriteTokens: 0, cacheWriteInPrompt: false }))
      .toEqual({ inputTokens: 13, cacheReadTokens: 16826, cacheWriteTokens: 0 });
  });

  it('écritures déjà dans prompt_tokens : pas de double compte', () => {
    expect(toPaperclipUsage({ promptTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 300, cacheWriteInPrompt: true }))
      .toEqual({ inputTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 300 });
  });

  it('totaux du run 7ca692c0 (journal OmniRoute) : 54 260 en entrée, pas 426 194', () => {
    // usage_history OmniRoute, clé paperclip-adapter-native, 19 appels :
    // tokens_input 426 194, cache_read 405 329, cache_creation 33 395.
    expect(toPaperclipUsage({ promptTokens: 426194, cacheReadTokens: 405329, cacheWriteTokens: 33395, cacheWriteInPrompt: false }).inputTokens)
      .toBe(54260);
  });
});

describe('lot 10 — coût inconnu plutôt que 0 $', () => {
  it('0 $ avec des tours sans coût = inconnu', () => {
    expect(resolveRunCostUsd(0, 14)).toBeNull();
  });
  it('coût partiel positif = minorant conservé', () => {
    expect(resolveRunCostUsd(0.42, 3)).toBe(0.42);
  });
  it('tous les tours à 0 $ rapportés = 0 $', () => {
    expect(resolveRunCostUsd(0, 0)).toBe(0);
  });
  it('aucun coût = inconnu', () => {
    expect(resolveRunCostUsd(null, 19)).toBeNull();
  });
});

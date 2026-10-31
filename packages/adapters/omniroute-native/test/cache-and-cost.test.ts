/**
 * Lot 22 — Cache débloqué (User-Agent sdk-cli + cache_control tour par tour)
 * et calcul du coût réel d'après le barème du modèle servi.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildChatCompletionsPayload, wireMessagesToOpenAi } from '../src/shared/chat-completions.js';
import { OmniRouteClient } from '../src/shared/client.js';
import { calculateModelCostUsd, clearPricingCache, KNOWN_MODEL_PRICING, loadRemoteModelPricing } from '../src/shared/pricing.js';

describe('lot 22 — cache débloqué vers OmniRoute', () => {
  it('buildChatCompletionsPayload pose cache_control sur le DERNIER message de la conversation (tool_result)', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Question 1' }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'call_1', content: 'Contenu' }] },
    ];
    const payload = buildChatCompletionsPayload({
      model: 'AC-pro-coding',
      system: 'Système',
      messages,
      tools: [],
      maxTokens: 1024,
      reasoningEffort: 'none',
    });
    const msgs = payload['messages'] as Array<Record<string, unknown>>;
    // msgs[0] = system
    expect(msgs[0]['cache_control']).toBeUndefined();
    // msgs[1] = user Question 1
    expect(msgs[1]['cache_control']).toBeUndefined();
    // msgs[2] = assistant
    expect(msgs[2]['cache_control']).toBeUndefined();
    // msgs[3] = tool tool_result -> porte cache_control
    expect(msgs[3]['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('si le dernier message est un simple texte user, il reçoit aussi cache_control', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Premier message' }] },
    ];
    const payload = buildChatCompletionsPayload({
      model: 'AC-pro-coding',
      system: 'Système',
      messages,
      tools: [],
      maxTokens: 1024,
      reasoningEffort: 'none',
    });
    const msgs = payload['messages'] as Array<Record<string, unknown>>;
    expect(msgs[1]['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('OmniRouteClient envoie le User-Agent sdk-cli et l’anti-compression', () => {
    const client = new OmniRouteClient({
      baseUrl: 'http://passerelle.invalid',
      apiKey: 'test-key',
      requestTimeoutMs: 5000,
    });
    // On vérifie que les en-têtes de base sont bien configurés
    const headers = client.buildRequestHeaders();
    expect(headers['User-Agent']).toContain('sdk-cli');
    expect(headers['x-omniroute-compression']).toBe('off');
    expect(headers['x-omniroute-no-memory']).toBe('true');
  });
});

describe('lot 22 — calcul du coût réel en temps réel', () => {
  it('calcule le coût exact pour claude-opus-5-5 (barème officiel OmniRoute)', () => {
    // Barème Opus : 4 $ entrée, 20 $ sortie, 0,20 $ lecture cache, 5 $ écriture cache (par million)
    const cost = calculateModelCostUsd('claude/claude-opus-5-5', {
      // 10 000 total input dont 5 000 écritures cache -> 5 000 entrée fraîche (0,020 $)
      // + 1 000 sortie (0,020 $) + 50 000 lecture cache (0,010 $) + 5 000 écriture cache (0,025 $) = 0,075 $
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 5_000,
    });
    expect(cost).toBeCloseTo(0.075, 6);
  });

  it('gère les noms sans préfixe (ex. claude-opus-5-5 renvoyé dans le flux)', () => {
    const cost = calculateModelCostUsd('claude-opus-5-5', {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 5_000,
    });
    expect(cost).toBeCloseTo(0.075, 6);
  });


  it('ne surfacture pas les écritures cache (qa_reviewer review 3349 probe)', () => {
    // Cas 1 : cacheWriteInPrompt = true (les écritures étaient déjà dans prompt_tokens)
    const costTrue = calculateModelCostUsd('claude/claude-opus-5-5', {
      promptTokens: 10_000,
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 5_000,
      cacheWriteInPrompt: true,
    });
    // 5 000 tokens neufs à 4/M + 5 000 écrits à 5/M + 1 000 sortis à 20/M = 0,020 + 0,025 + 0,020 = 0,065 USD
    expect(costTrue).toBeCloseTo(0.065, 6);

    // Cas 2 : cacheWriteInPrompt = false (les écritures n'étaient pas dans prompt_tokens)
    const costFalse = calculateModelCostUsd('claude/claude-opus-5-5', {
      promptTokens: 5_000,
      inputTokens: 10_000, // toPaperclipUsage a fait 5000 + 5000 = 10000
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 5_000,
      cacheWriteInPrompt: false,
    });
    expect(costFalse).toBeCloseTo(0.065, 6);
  });


  it('charge dynamiquement le barème officiel auprès d’OmniRoute via GET /v1/models/{id}', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes('/v1/models/custom%2Fmon-modele')) {
        return new Response(JSON.stringify({
          id: 'custom/mon-modele',
          pricing: { prompt: 2.0, completion: 8.0, input_cache_read: 0.5, input_cache_write: 3.0 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      clearPricingCache();
      const p = await loadRemoteModelPricing('http://gateway.test', 'cle', 'custom/mon-modele');
      expect(p).not.toBeNull();
      expect(p?.promptPerToken).toBeCloseTo(0.000002, 9);
      expect(p?.completionPerToken).toBeCloseTo(0.000008, 9);
      expect(p?.cacheReadPerToken).toBeCloseTo(0.0000005, 9);
      expect(p?.cacheWritePerToken).toBeCloseTo(0.000003, 9);

      // Le calcul ultérieur utilise ce tarif chargé dynamiquement
      const cost = calculateModelCostUsd('custom/mon-modele', {
        inputTokens: 10_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // 10 000 * 2/1M + 1 000 * 8/1M = 0,02 + 0,008 = 0,028 $
      expect(cost).toBeCloseTo(0.028, 6);
    } finally {
      vi.unstubAllGlobals();
      clearPricingCache();
    }
  });

  it('renvoie null pour un modèle local gratuit ou inconnu', () => {
    expect(calculateModelCostUsd('qwen3.6-35b-a3b', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(calculateModelCostUsd('inconnu', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});

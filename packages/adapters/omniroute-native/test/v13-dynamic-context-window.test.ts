import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  calculateDynamicSessionBudgets,
  clearModelContextCache,
  findLocalModelContext,
  loadRemoteModelContext,
  registerModelContext,
  KNOWN_MODEL_CONTEXTS,
  SAFE_DEFAULT_CONTEXT_TOKENS,
  LOCAL_MODEL_DEFAULT_CONTEXT_TOKENS,
} from '../src/shared/context-window.js';

describe('v1.3 — Dynamic Context Window & Memory Budgets', () => {
  let tmpHome: string;

  beforeEach(async () => {
    clearModelContextCache();
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'v13-ctx-home-'));
    process.env['PAPERCLIP_HOME'] = tmpHome;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    clearModelContextCache();
    delete process.env['PAPERCLIP_HOME'];
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  describe('calculateDynamicSessionBudgets', () => {
    it('calcule des budgets proportionnés et sûrs pour un petit modèle local (≤ 32k tokens)', () => {
      // 32 768 * 3.5 = 114 688 chars
      // history = max(15k, floor(114688 * 0.25)) = 28 672 chars
      // intraRun = max(25k, floor(114688 * 0.35)) = 40 140 chars
      const budgets = calculateDynamicSessionBudgets(32_768);
      expect(budgets.historyBudgetChars).toBe(28_672);
      expect(budgets.intraRunBudgetChars).toBe(40_140);
    });

    it('calcule des budgets confortables pour un modèle géant (≥ 1M tokens)', () => {
      // 1 000 000 * 3.5 = 3.5M chars
      // history = min(1.5M, 3.5M * 0.40 = 1.4M) = 1_400_000 chars
      // intraRun = min(2.0M, 3.5M * 0.50 = 1.75M) = 1_750_000 chars
      const budgets1M = calculateDynamicSessionBudgets(1_000_000);
      expect(budgets1M.historyBudgetChars).toBe(1_400_000);
      expect(budgets1M.intraRunBudgetChars).toBe(1_750_000);

      // Pour un modèle à 2M tokens (ex. auto/best-coding): plafonné à 1.5M et 2.0M
      const budgets2M = calculateDynamicSessionBudgets(2_000_000);
      expect(budgets2M.historyBudgetChars).toBe(1_500_000);
      expect(budgets2M.intraRunBudgetChars).toBe(2_000_000);
    });

    it('calcule des budgets équilibrés pour un modèle standard (128k à 872k tokens)', () => {
      // 128 000 tokens (GPT-4o) : 128k * 3.5 = 448 000 chars
      // history: clamp(100k, 400k, 448k * 0.40 = 179 200) = 179 200
      // intraRun: clamp(100k, 600k, 448k * 0.50 = 224 000) = 224 000
      const budgets128k = calculateDynamicSessionBudgets(128_000);
      expect(budgets128k.historyBudgetChars).toBe(179_200);
      expect(budgets128k.intraRunBudgetChars).toBe(224_000);

      // Hypothetical discovered 872 000-token context : 872k * 3.5 = 3 052 000 chars
      // history: clamp(100k, 400k, 1 220 800) = 400 000
      // intraRun: clamp(100k, 600k, 1 526 000) = 600 000
      const budgets872k = calculateDynamicSessionBudgets(872_000);
      expect(budgets872k.historyBudgetChars).toBe(400_000);
      expect(budgets872k.intraRunBudgetChars).toBe(600_000);
    });
  });

  describe('findLocalModelContext', () => {
    it('keeps only direct-model hints in the offline catalogue', () => {
      expect(KNOWN_MODEL_CONTEXTS['AC-pro-coding']).toBeUndefined();
      expect(KNOWN_MODEL_CONTEXTS['auto/best-coding']).toBeUndefined();
      expect(findLocalModelContext('AC-pro-coding')).toBeNull();
      expect(findLocalModelContext('openai/gpt-4o')?.contextTokens).toBe(128_000);
    });

    it('gère les préfixes fournisseurs de manière bidirectionnelle', () => {
      const hitWithout = findLocalModelContext('claude-opus-5-5');
      expect(hitWithout?.contextTokens).toBe(200_000);

      const hitDeepseek = findLocalModelContext('deepseek-chat');
      expect(hitDeepseek?.contextTokens).toBe(64_000);
    });

    it('priorise le cache mémoire sur le catalogue connu', () => {
      registerModelContext('AC-pro-coding', {
        modelId: 'AC-pro-coding',
        contextTokens: 999_999,
        source: 'memory_cache',
      });
      const hit = findLocalModelContext('AC-pro-coding');
      expect(hit?.contextTokens).toBe(999_999);
      expect(hit?.source).toBe('memory_cache');
    });
  });

  describe('loadRemoteModelContext', () => {
    it('borne la découverte même avec un signal de run non annulé', async () => {
      const controller = new AbortController();
      vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })));
      const started = Date.now();
      const spec = await loadRemoteModelContext('http://gateway.test', 'test-key', 'unknown-timeout-test', controller.signal);
      expect(spec.source).toBe('default_fallback');
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(controller.signal.aborted).toBe(false);
    }, 4_500);

    it('résout immédiatement sans appel réseau si le modèle est dans le catalogue', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const spec = await loadRemoteModelContext('http://fake-non-existent.local', 'token', 'openai/gpt-4o');
      expect(spec.contextTokens).toBe(128_000);
      expect(spec.source).toBe('known_catalog');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('appelle GET /v1/models/{id} pour un modèle inconnu et met en cache mémoire et disque', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const u = String(url instanceof Request ? url.url : url);
        if (u.includes('/v1/models/custom-model')) {
          return new Response(JSON.stringify({
            id: 'custom-model',
            context_length: 65_536,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const spec = await loadRemoteModelContext('http://gateway.test', 'test-key', 'custom-model');
      expect(spec.modelId).toBe('custom-model');
      expect(spec.contextTokens).toBe(65_536);
      expect(spec.source).toBe('remote_api');

      // Vérification de la persistance disque
      clearModelContextCache();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('réseau coupé')));
      const diskSpec = await loadRemoteModelContext('http://gateway.test', 'test-key', 'custom-model');
      expect(diskSpec.contextTokens).toBe(65_536);
      expect(diskSpec.source).toBe('disk_cache');
    });

    it('se replie de façon sécurisée en cas d’échec ou indisponibilité réseau', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('réseau indisponible')));

      const specLocal = await loadRemoteModelContext(
        'http://127.0.0.1:59999',
        'key',
        'unknown-spark-qwen-custom',
      );
      expect(specLocal.contextTokens).toBe(LOCAL_MODEL_DEFAULT_CONTEXT_TOKENS);
      expect(specLocal.source).toBe('default_fallback');

      const specGeneral = await loadRemoteModelContext(
        'http://127.0.0.1:59999',
        'key',
        'unknown-general-model-xyz',
      );
      expect(specGeneral.contextTokens).toBe(SAFE_DEFAULT_CONTEXT_TOKENS);
      expect(specGeneral.source).toBe('default_fallback');
    });
  });
});

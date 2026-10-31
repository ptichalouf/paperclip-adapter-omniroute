import { describe, expect, it } from 'vitest';
import {
  buildSystemPromptForTest,
  buildPromptForTest,
} from '../src/server/execute.js';
import type { SkillMount } from '../src/server/skills.js';
import { makeTestContext } from './support/test-context.js';

describe('v1.3 — Invariance absolue du prompt système', () => {
  function makePromptContext(extra: {
    context?: Record<string, unknown>;
    runtimeTools?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {}) {
    const { ctx } = makeTestContext({
      config: extra.config,
      context: extra.context,
    });
    if (extra.runtimeTools) {
      ctx['runtimeTools'] = extra.runtimeTools;
    }
    return ctx as never;
  }

  it('produit un prompt système 100 % binaire identique avec ou sans note de passation', () => {
    const ctxWithoutHandoff = makePromptContext({
      context: { taskId: 'task-001' },
    });

    const ctxWithHandoff = makePromptContext({
      context: {
        taskId: 'task-002',
        paperclipFreshSessionHandoffMarkdown: 'Voici le résumé du run précédent : décisions actées.',
        paperclipSessionHandoffMarkdown: 'Autre note de passation hôte.',
      },
    });

    const prompt1 = buildSystemPromptForTest(ctxWithoutHandoff);
    const prompt2 = buildSystemPromptForTest(ctxWithHandoff);

    expect(prompt1).toBe(prompt2);
    expect(prompt1).not.toContain('## Passation de session précédente');
    expect(prompt1).not.toContain('décisions actées');
    expect(prompt2).not.toContain('## Passation de session précédente');
  });

  it('déplace la passation de session dans le premier message utilisateur (buildPrompt)', () => {
    const handoffText = 'Plan validé au tour précédent et fichiers créés.';
    const ctx = makePromptContext({
      context: {
        taskId: 'task-001',
        paperclipFreshSessionHandoffMarkdown: handoffText,
      },
    });

    const userPrompt = buildPromptForTest(ctx);
    expect(userPrompt).toContain('## Passation de session précédente');
    expect(userPrompt).toContain(handoffText);

    const systemPrompt = buildSystemPromptForTest(ctx);
    expect(systemPrompt).not.toContain('## Passation de session précédente');
    expect(systemPrompt).not.toContain(handoffText);
  });

  it('trie les skills par ordre alphabétique pour garantir un cache déterministe', () => {
    const unorderedMounts: SkillMount[] = [
      { key: 'zeta', runtimeName: 'zeta-tool', source: '/skills/zeta', description: 'Outil Z' },
      { key: 'alpha', runtimeName: 'alpha-tool', source: '/skills/alpha', description: 'Outil A' },
      { key: 'beta', runtimeName: 'beta-tool', source: '/skills/beta', description: 'Outil B' },
    ];

    const ctx = makePromptContext();
    const prompt = buildSystemPromptForTest(ctx, null, unorderedMounts);

    const alphaIdx = prompt.indexOf('alpha-tool');
    const betaIdx = prompt.indexOf('beta-tool');
    const zetaIdx = prompt.indexOf('zeta-tool');

    expect(alphaIdx).toBeGreaterThan(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    expect(zetaIdx).toBeGreaterThan(betaIdx);
  });

  it('garde le prompt système invariant quelle que soit la disponibilité ponctuelle des connecteurs runtime', () => {
    const ctxWithoutRuntime = makePromptContext({
      context: { taskId: 'task-1' },
    });

    const ctxWithRuntime = makePromptContext({
      context: { taskId: 'task-2' },
      runtimeTools: {
        version: 1,
        guidance: 'g',
        mcpEndpoint: 'http://127.0.0.1:3100/mcp',
        rest: {
          connectionsSearch: 'http://127.0.0.1:3100/api/connections/search',
          connectionRequest: 'http://127.0.0.1:3100/api/connections/request',
        },
        bearerToken: 'RT-SECRET-TOKEN',
        tools: ['gitea', 'nextcloud-mcp', 'connections_search'],
      },
    });

    const promptWithout = buildSystemPromptForTest(ctxWithoutRuntime);
    const promptWith = buildSystemPromptForTest(ctxWithRuntime);

    expect(promptWithout).toBe(promptWith);
    expect(promptWith).not.toContain('RT-SECRET-TOKEN');
    expect(promptWith).not.toContain('gitea');
    expect(promptWith).toContain('## Environnement Paperclip');
    expect(promptWith).toContain('## Outils Paperclip');
  });
});

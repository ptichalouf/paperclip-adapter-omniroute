import { describe, expect, it } from 'vitest';

import { buildSystemPromptForTest } from '../src/server/execute.js';

/**
 * Un contexte d'exécution minimal mais réaliste : l'hôte y injecte des
 * secrets (JWT de run, bearer des outils runtime). Le test vérifie qu'aucun
 * d'eux n'atteint le prompt système.
 */
function contextWithSecrets() {
  return {
    agent: { id: 'agent-1', companyId: 'company-1', name: 'Pilote' },
    runId: 'run-1',
    authToken: 'SECRET-RUN-JWT-0001',
    runtimeTools: {
      mcpEndpoint: 'http://127.0.0.1:3100/mcp/runtime-tools',
      bearerToken: 'SECRET-TOOLS-BEARER-0002',
      expiresAt: '2030-01-01T00:00:00.000Z',
      rest: {
        connectionsSearch: 'http://127.0.0.1:3100/api/runtime-tools/connections/search',
        connectionRequest: 'http://127.0.0.1:3100/api/runtime-tools/connections/request',
      },
      tools: ['gitea', 'nextcloud-mcp'],
      guidance: 'GUIDANCE-TEXT-0003',
    },
  } as never;
}

describe('buildSystemPrompt — aucun secret dans le prompt', () => {
  it('ne met jamais le JWT de run dans le prompt', () => {
    const prompt = buildSystemPromptForTest(contextWithSecrets());
    expect(prompt).not.toContain('SECRET-RUN-JWT-0001');
  });

  it('ne met jamais le bearer des outils runtime dans le prompt', () => {
    const prompt = buildSystemPromptForTest(contextWithSecrets());
    expect(prompt).not.toContain('SECRET-TOOLS-BEARER-0002');
  });

  it('annonce les variables d infrastructure de façon invariante sans valeurs dynamiques', () => {
    const prompt = buildSystemPromptForTest(contextWithSecrets());
    expect(prompt).toContain('PAPERCLIP_API_URL');
    expect(prompt).toContain('PAPERCLIP_AGENT_ID');
    expect(prompt).toContain('PAPERCLIP_TASK_ID');
    expect(prompt).not.toContain('gitea');
  });

  it('présente une liste blanche : une variable inconnue n’est pas annoncée', () => {
    const ctx = contextWithSecrets() as unknown as Record<string, unknown>;
    const runtimeTools = ctx['runtimeTools'] as Record<string, unknown>;
    runtimeTools['PAPERCLIP_FUTURE_SECRET'] = 'SECRET-INCONNU-0004';
    const prompt = buildSystemPromptForTest(ctx as never);
    expect(prompt).not.toContain('SECRET-INCONNU-0004');
    expect(prompt).not.toContain('PAPERCLIP_FUTURE_SECRET');
  });

  it('respecte un systemPrompt configuré, sans y rien ajouter', () => {
    const ctx = contextWithSecrets() as unknown as Record<string, unknown>;
    ctx['config'] = { systemPrompt: 'Consigne propre de l\'agent.' };
    const prompt = buildSystemPromptForTest(ctx as never);
    expect(prompt).toBe("Consigne propre de l'agent.");
  });
});

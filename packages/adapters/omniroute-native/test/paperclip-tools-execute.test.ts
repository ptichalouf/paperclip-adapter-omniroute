import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { buildSystemPromptForTest, execute } from '../src/server/execute.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { startFakePaperclip } from './support/fake-paperclip.js';
import { makeTestContext } from './support/test-context.js';

/**
 * Lot 9 — branchement des outils Paperclip dans `execute` et texte du prompt.
 *
 * Bout en bout : une fausse passerelle fait appeler `paperclip_add_comment`
 * au modèle ; un faux Paperclip reçoit la requête. On prouve que l'outil est
 * proposé au modèle, qu'il part avec le run id du contexte, que le jeton ne
 * revient pas dans le transcript, et que le prompt ne recommande plus le shell
 * pour parler à l'API.
 */

const TOKEN = 'FAKE-RUN-JWT-lot9-e2e-0001';
const RT_TOKEN = 'FAKE-TOOLS-BEARER-lot9-e2e-0002';
const TASK = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  vi.unstubAllEnvs();
});

function promptCtx(extra: Record<string, unknown> = {}) {
  return {
    agent: { id: 'agent-1', companyId: 'company-1', name: 'Pilote' },
    runId: 'run-1',
    authToken: TOKEN,
    context: { taskId: TASK },
    ...extra,
  } as never;
}

describe('lot 9 — prompt système', () => {
  it('oriente vers les outils paperclip_* et ne recommande plus d’appeler l’API au shell', () => {
    const prompt = buildSystemPromptForTest(promptCtx());
    expect(prompt).toContain('paperclip_deliver');
    expect(prompt).toContain('paperclip_get_issue');
    expect(prompt).not.toMatch(/curl/i);
    expect(prompt).not.toContain("permettent d'appeler l'API du board");
    expect(prompt).not.toContain(TOKEN);
  });

  it('annonce les consignes des outils de connexion de façon universelle et stable sans le bearer', () => {
    const prompt = buildSystemPromptForTest(promptCtx());
    expect(prompt).toContain('connections_search');
    expect(prompt).toContain('connection_request');
    expect(prompt).not.toContain(TOKEN);
  });

  it('garde le même prompt système même quand des runtimeTools sont configurés, sans jamais fuiter le bearer', () => {
    const prompt = buildSystemPromptForTest(promptCtx({
      runtimeTools: {
        version: 1,
        guidance: 'g',
        mcpEndpoint: 'http://127.0.0.1:1/api/mcp/runtime-tools',
        rest: {
          connectionsSearch: 'http://127.0.0.1:1/api/runtime-tools/connections/search',
          connectionRequest: 'http://127.0.0.1:1/api/runtime-tools/connections/request',
        },
        bearerToken: RT_TOKEN,
        expiresAt: '2030-01-01T00:00:00.000Z',
        tools: ['connections_search', 'connection_request'],
      },
    }));
    expect(prompt).toBe(buildSystemPromptForTest(promptCtx()));
    expect(prompt).toContain('connections_search');
    expect(prompt).not.toContain(RT_TOKEN);
  });
});

describe('lot 9 — outils branchés dans execute (bout en bout)', () => {
  it('propose les outils paperclip_* au modèle et exécute un appel avec le run id', async () => {
    const paperclip = await startFakePaperclip();
    paperclip.route(`POST /api/issues/${TASK}/comments`, (req) => ({
      status: 201,
      body: { id: 'c1', body: 'ok', echo: String(req.headers['authorization']) },
    }));
    vi.stubEnv('PAPERCLIP_API_URL', paperclip.baseUrl);
    const gateway = await startFakeGateway({
      toolCall: { name: 'paperclip_add_comment', input: { body: 'Commentaire via outil' } },
    });
    const workspace = path.join('/tmp', `omniroute-lot9-${process.pid}`);
    await fs.mkdir(workspace, { recursive: true });

    try {
      const { ctx } = makeTestContext({
        config: { baseUrl: gateway.baseUrl },
        context: { taskId: TASK, paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
      });
      (ctx as Record<string, unknown>)['authToken'] = TOKEN;
      const result = await execute(ctx as never);

      expect(result.exitCode).toBe(0);
      const offered = gateway.captured[0]?.tools ?? [];
      for (const name of ['paperclip_get_issue', 'paperclip_add_comment', 'paperclip_update_issue', 'paperclip_deliver']) {
        expect(offered).toContain(name);
      }
      // Les outils de code restent là.
      expect(offered).toContain('shell');

      expect(paperclip.requests).toHaveLength(1);
      const req = paperclip.requests[0];
      expect(req?.method).toBe('POST');
      expect(req?.path).toBe(`/api/issues/${TASK}/comments`);
      expect(req?.headers['x-paperclip-run-id']).toBe('run-test');
      expect(req?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(req?.body).toEqual({ body: 'Commentaire via outil' });

      // Le résultat d'outil renvoyé au modèle ne contient pas le jeton.
      const replay = JSON.stringify(gateway.captured[1]?.messages ?? []);
      expect(replay).toContain('c1');
      expect(replay).not.toContain(TOKEN);
      expect(JSON.stringify(gateway.captured)).not.toContain(TOKEN);
    } finally {
      await gateway.close();
      await paperclip.close();
    }
  });

  it('sans jeton de run, aucun outil paperclip_* n’est proposé', async () => {
    const gateway = await startFakeGateway();
    const workspace = path.join('/tmp', `omniroute-lot9-nojwt-${process.pid}`);
    await fs.mkdir(workspace, { recursive: true });
    try {
      const { ctx } = makeTestContext({
        config: { baseUrl: gateway.baseUrl },
        context: { taskId: TASK, paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
      });
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      const offered = gateway.captured[0]?.tools ?? [];
      expect(offered.some((name) => name.startsWith('paperclip_'))).toBe(false);
    } finally {
      await gateway.close();
    }
  });
});

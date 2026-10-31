import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPaperclipTools, type PaperclipToolsOptions } from '../src/server/paperclip-tools.js';
import type { WorkspaceTool } from '../src/server/tools.js';
import { startFakePaperclip, type FakePaperclip } from './support/fake-paperclip.js';

/**
 * Lot 9 — outils Paperclip directs.
 *
 * Constat (ACC-2278, ACC-2305) : l'agent écrit 5 à 11 `curl` par run vers
 * l'API Paperclip, en-têtes construits à la main, et télécharge jusqu'à 3,9 Mo.
 * Ces tests prouvent, contre un faux serveur HTTP local, ce que chaque outil
 * envoie (méthode, chemin, en-têtes dont le run id, corps), que le jeton ne
 * ressort jamais, que les sorties restent compactes et que `paperclip_deliver`
 * s'arrête au premier échec.
 */

// Valeurs fictives : aucun vrai jeton dans les tests.
const TOKEN = 'FAKE-RUN-JWT-lot9-0001';
const RT_TOKEN = 'FAKE-TOOLS-BEARER-lot9-0002';
const RUN = 'run-lot9-0001';
const AGENT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const REV = '44444444-4444-4444-8444-444444444444';

let fake: FakePaperclip;

beforeEach(async () => {
  fake = await startFakePaperclip();
});
afterEach(async () => {
  await fake.close();
});

function tools(overrides: Partial<PaperclipToolsOptions> = {}): Map<string, WorkspaceTool> {
  const list = buildPaperclipTools({
    apiUrl: fake.baseUrl,
    apiKey: TOKEN,
    runId: RUN,
    agentId: AGENT,
    companyId: COMPANY,
    taskId: TASK,
    ...overrides,
  });
  return new Map(list.map((t) => [t.spec.name, t]));
}

async function run(name: string, input: unknown, overrides: Partial<PaperclipToolsOptions> = {}) {
  const tool = tools(overrides).get(name);
  if (!tool) throw new Error(`outil absent : ${name}`);
  return tool.run(input);
}

function issue(extra: Record<string, unknown> = {}) {
  return {
    id: TASK,
    identifier: 'ACC-2285',
    title: 'Outils Paperclip directs',
    status: 'in_progress',
    priority: 'high',
    assigneeAgentId: AGENT,
    parentId: null,
    projectId: null,
    goalId: null,
    description: 'Brief du ticket.',
    executionPolicy: { gros: 'x'.repeat(5000) },
    updatedAt: '2026-10-31T10:00:00.000Z',
    ...extra,
  };
}

/** Chaque requête porte le jeton (en-tête seulement) et le run id. */
function expectAuthHeaders() {
  expect(fake.requests.length).toBeGreaterThan(0);
  for (const req of fake.requests) {
    expect(req.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['x-paperclip-run-id']).toBe(RUN);
  }
}

describe('lot 9 — liste des outils', () => {
  it('expose les outils paperclip_* attendus, sobres et préfixés', () => {
    const names = [...tools().keys()];
    for (const expected of [
      'paperclip_get_issue',
      'paperclip_list_comments',
      'paperclip_add_comment',
      'paperclip_update_issue',
      'paperclip_list_documents',
      'paperclip_get_document',
      'paperclip_write_document',
      'paperclip_create_subtask',
      'paperclip_list_my_issues',
      'paperclip_api_request',
      'paperclip_deliver',
    ]) {
      expect(names).toContain(expected);
    }
    // Sans outils runtime : pas d'outils de connexion.
    expect(names).not.toContain('connections_search');
    expect(names.length).toBeLessThanOrEqual(15);
    // Descriptions sobres : budget total mesuré dans le rapport.
    const specChars = JSON.stringify([...tools().values()].map((t) => t.spec)).length;
    expect(specChars).toBeLessThan(11000);
  });

  it('ne construit rien sans URL ou sans jeton', () => {
    expect(buildPaperclipTools({ apiUrl: '', apiKey: TOKEN, runId: RUN, agentId: AGENT, companyId: COMPANY, taskId: TASK })).toEqual([]);
    expect(buildPaperclipTools({ apiUrl: fake.baseUrl, apiKey: '', runId: RUN, agentId: AGENT, companyId: COMPANY, taskId: TASK })).toEqual([]);
  });
});

describe('lot 9 — requêtes envoyées (méthode, chemin, en-têtes, corps)', () => {
  it('paperclip_get_issue lit le ticket courant, ses commentaires récents et ses documents', async () => {
    fake.route(`GET /api/issues/${TASK}`, { body: issue() });
    fake.route(`GET /api/issues/${TASK}/comments`, {
      body: [{ id: 'c1', authorAgentId: AGENT, body: 'Dernier commentaire', createdAt: '2026-10-31T09:00:00.000Z' }],
    });
    fake.route(`GET /api/issues/${TASK}/documents`, { body: [{ key: 'plan', title: 'Plan', latestRevisionNumber: 2, body: 'corps' }] });

    const result = await run('paperclip_get_issue', {});

    expect(result.isError).toBe(false);
    const paths = fake.requests.map((r) => `${r.method} ${r.path}?${r.query}`);
    expect(paths).toContain(`GET /api/issues/${TASK}?`);
    expect(paths).toContain(`GET /api/issues/${TASK}/comments?order=desc&limit=5`);
    expect(paths).toContain(`GET /api/issues/${TASK}/documents?`);
    expectAuthHeaders();
    expect(result.content).toContain('ACC-2285');
    expect(result.content).toContain('Dernier commentaire');
    expect(result.content).toContain('plan');
    // Champs volumineux non utiles écartés.
    expect(result.content).not.toContain('executionPolicy');
  });

  it('paperclip_list_comments passe limit, order et after', async () => {
    fake.route(`GET /api/issues/ACC-1/comments`, { body: [] });
    const result = await run('paperclip_list_comments', { issueId: 'ACC-1', limit: 10, order: 'asc', after: REV });
    expect(result.isError).toBe(false);
    expect(fake.requests[0]?.method).toBe('GET');
    expect(fake.requests[0]?.path).toBe('/api/issues/ACC-1/comments');
    expect(new URLSearchParams(fake.requests[0]?.query)).toEqual(new URLSearchParams(`after=${REV}&order=asc&limit=10`));
    expectAuthHeaders();
  });

  it('paperclip_add_comment publie le corps tel quel sur le ticket courant', async () => {
    fake.route(`POST /api/issues/${TASK}/comments`, { status: 201, body: { id: 'c9', body: 'Fait.' } });
    const result = await run('paperclip_add_comment', { body: 'Fait.\n\n- point 1' });
    expect(result.isError).toBe(false);
    expect(fake.requests[0]?.method).toBe('POST');
    expect(fake.requests[0]?.path).toBe(`/api/issues/${TASK}/comments`);
    expect(fake.requests[0]?.headers['content-type']).toContain('application/json');
    expect(fake.requests[0]?.body).toEqual({ body: 'Fait.\n\n- point 1' });
    expectAuthHeaders();
  });

  it('paperclip_update_issue envoie un PATCH avec statut et commentaire', async () => {
    fake.route(`PATCH /api/issues/${TASK}`, { body: issue({ status: 'in_review' }) });
    const result = await run('paperclip_update_issue', { status: 'in_review', comment: 'Prêt pour revue.' });
    expect(result.isError).toBe(false);
    expect(fake.requests[0]?.method).toBe('PATCH');
    expect(fake.requests[0]?.path).toBe(`/api/issues/${TASK}`);
    expect(fake.requests[0]?.body).toEqual({ status: 'in_review', comment: 'Prêt pour revue.' });
    expect(result.content).toContain('in_review');
    expectAuthHeaders();
  });

  it('paperclip_update_issue refuse un statut inconnu sans rien envoyer', async () => {
    const result = await run('paperclip_update_issue', { status: 'terminé' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('in_review');
    expect(fake.requests).toHaveLength(0);
  });

  it('paperclip_list_documents et paperclip_get_document lisent les documents', async () => {
    fake.route(`GET /api/issues/${TASK}/documents`, { body: [{ key: 'plan', title: 'Plan', body: 'b'.repeat(50_000), latestRevisionNumber: 1 }] });
    fake.route(`GET /api/issues/${TASK}/documents/plan`, { body: { key: 'plan', title: 'Plan', body: 'L1\nL2', latestRevisionId: REV, latestRevisionNumber: 1 } });
    const list = await run('paperclip_list_documents', {});
    const doc = await run('paperclip_get_document', { key: 'plan' });
    expect(list.isError).toBe(false);
    expect(list.content.length).toBeLessThan(2000);
    expect(doc.isError).toBe(false);
    expect(doc.content).toContain('L1\nL2');
    expect(doc.content).toContain(REV);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /api/issues/${TASK}/documents`,
      `GET /api/issues/${TASK}/documents/plan`,
    ]);
    expectAuthHeaders();
  });

  it('paperclip_write_document crée un document absent (PUT sans baseRevisionId)', async () => {
    fake.route(`GET /api/issues/${TASK}/documents/analyse`, { status: 404, body: { error: 'Document not found' } });
    fake.route(`PUT /api/issues/${TASK}/documents/analyse`, { status: 201, body: { key: 'analyse', title: 'Analyse', latestRevisionNumber: 1 } });
    const result = await run('paperclip_write_document', { key: 'analyse', title: 'Analyse', body: '# Analyse' });
    expect(result.isError).toBe(false);
    const put = fake.requests.find((r) => r.method === 'PUT');
    expect(put?.path).toBe(`/api/issues/${TASK}/documents/analyse`);
    expect(put?.body).toEqual({ format: 'markdown', title: 'Analyse', body: '# Analyse' });
    expectAuthHeaders();
  });

  it('paperclip_write_document met à jour un document existant avec sa dernière révision', async () => {
    fake.route(`GET /api/issues/${TASK}/documents/plan`, { body: { key: 'plan', latestRevisionId: REV, latestRevisionNumber: 3, body: 'ancien' } });
    fake.route(`PUT /api/issues/${TASK}/documents/plan`, { body: { key: 'plan', latestRevisionNumber: 4 } });
    const result = await run('paperclip_write_document', { key: 'plan', body: 'nouveau', changeSummary: 'maj' });
    expect(result.isError).toBe(false);
    const put = fake.requests.find((r) => r.method === 'PUT');
    expect(put?.body).toEqual({ format: 'markdown', body: 'nouveau', changeSummary: 'maj', baseRevisionId: REV });
    expect(result.content).toContain('4');
  });

  it('paperclip_write_document refuse une clé invalide sans rien envoyer', async () => {
    const result = await run('paperclip_write_document', { key: 'Mon Doc', body: 'x' });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('paperclip_create_subtask crée une sous-tâche du ticket courant', async () => {
    fake.route(`POST /api/companies/${COMPANY}/issues`, { status: 201, body: issue({ id: 'new-1', identifier: 'ACC-2400', title: 'Sous-tâche', parentId: TASK, status: 'todo' }) });
    const result = await run('paperclip_create_subtask', { title: 'Sous-tâche', description: 'Faire X', assigneeAgentId: AGENT, priority: 'low' });
    expect(result.isError).toBe(false);
    expect(fake.requests[0]?.method).toBe('POST');
    expect(fake.requests[0]?.path).toBe(`/api/companies/${COMPANY}/issues`);
    expect(fake.requests[0]?.body).toEqual({ title: 'Sous-tâche', description: 'Faire X', parentId: TASK, assigneeAgentId: AGENT, priority: 'low' });
    expect(result.content).toContain('ACC-2400');
    expectAuthHeaders();
  });

  it('paperclip_list_my_issues filtre côté serveur (assigné, statut, limite)', async () => {
    fake.route(`GET /api/companies/${COMPANY}/issues`, { body: [issue()] });
    const result = await run('paperclip_list_my_issues', {});
    expect(result.isError).toBe(false);
    const query = new URLSearchParams(fake.requests[0]?.query);
    expect(query.get('assigneeAgentId')).toBe(AGENT);
    expect(query.get('status')).toBe('todo,in_progress,blocked');
    expect(query.get('limit')).toBe('50');
    expect(result.content).toContain('ACC-2285');
    expect(result.content).not.toContain('Brief du ticket');
    expectAuthHeaders();
  });

  it('paperclip_api_request appelle une route relative à /api avec les en-têtes', async () => {
    fake.route('GET /api/agents/me', { body: { id: AGENT, name: 'Test' } });
    fake.route(`POST /api/issues/${TASK}/checkout`, { body: { ok: true } });
    const get = await run('paperclip_api_request', { method: 'GET', path: '/api/agents/me' });
    const post = await run('paperclip_api_request', { method: 'POST', path: `/issues/${TASK}/checkout`, body: { agentId: AGENT } });
    expect(get.isError).toBe(false);
    expect(post.isError).toBe(false);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/agents/me',
      `POST /api/issues/${TASK}/checkout`,
    ]);
    expect(fake.requests[1]?.body).toEqual({ agentId: AGENT });
    expectAuthHeaders();
  });

  it('paperclip_api_request refuse une URL absolue, un « .. » et DELETE', async () => {
    for (const input of [
      { method: 'GET', path: 'http://evil.example/x' },
      { method: 'GET', path: '/issues/../../etc' },
      { method: 'DELETE', path: `/issues/${TASK}` },
    ]) {
      const result = await run('paperclip_api_request', input);
      expect(result.isError).toBe(true);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('lot 9 — le jeton ne sort jamais', () => {
  it('masque le jeton même si le serveur le renvoie dans une erreur', async () => {
    fake.route(`POST /api/issues/${TASK}/comments`, (req) => ({
      status: 403,
      body: { error: `refusé pour ${String(req.headers['authorization'])}` },
    }));
    const result = await run('paperclip_add_comment', { body: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('403');
    expect(result.content).not.toContain(TOKEN);
    expect(result.content).toContain('[REDACTED]');
  });

  it('masque le jeton dans un succès qui l’écho', async () => {
    fake.route('GET /api/agents/me', (req) => ({ body: { echo: String(req.headers['authorization']) } }));
    const result = await run('paperclip_api_request', { method: 'GET', path: '/agents/me' });
    expect(result.content).not.toContain(TOKEN);
  });

  it('une erreur réseau ne contient ni jeton ni trace brute', async () => {
    const result = await run('paperclip_add_comment', { body: 'x' }, { apiUrl: 'http://127.0.0.1:1' });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(TOKEN);
    expect(result.content).toMatch(/injoignable|échec/i);
  });

  it('aucune sortie d’outil, sur tous les outils, ne contient le jeton', async () => {
    const echo = (req: { headers: Record<string, unknown> }) => ({ body: { echo: String(req.headers['authorization']) } });
    for (const key of [
      `GET /api/issues/${TASK}`, `GET /api/issues/${TASK}/comments`, `POST /api/issues/${TASK}/comments`,
      `PATCH /api/issues/${TASK}`, `GET /api/issues/${TASK}/documents`, `GET /api/issues/${TASK}/documents/plan`,
      `PUT /api/issues/${TASK}/documents/plan`, `POST /api/companies/${COMPANY}/issues`, `GET /api/companies/${COMPANY}/issues`,
    ]) fake.route(key, echo);
    const outputs: string[] = [];
    const inputs: Record<string, unknown> = {
      paperclip_get_issue: {},
      paperclip_list_comments: {},
      paperclip_add_comment: { body: 'x' },
      paperclip_update_issue: { status: 'done' },
      paperclip_list_documents: {},
      paperclip_get_document: { key: 'plan' },
      paperclip_write_document: { key: 'plan', body: 'x' },
      paperclip_create_subtask: { title: 't' },
      paperclip_list_my_issues: {},
      paperclip_api_request: { method: 'GET', path: `/issues/${TASK}` },
      paperclip_deliver: { comment: 'c', status: 'done', document: { key: 'plan', body: 'x' } },
    };
    for (const [name, tool] of tools()) {
      outputs.push((await tool.run(inputs[name] ?? {})).content);
    }
    expect(outputs.join('\n')).not.toContain(TOKEN);
  });
});

describe('lot 9 — sorties compactes', () => {
  it('une liste énorme est tronquée et le dit', async () => {
    const comments = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`, authorAgentId: AGENT, createdAt: '2026-10-31T09:00:00.000Z', body: `commentaire ${i} ` + 'z'.repeat(5000),
    }));
    fake.route(`GET /api/issues/${TASK}/comments`, { body: comments });
    const result = await run('paperclip_list_comments', { limit: 100 });
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThanOrEqual(12_500);
    expect(result.content).toMatch(/tronqu/);
  });

  it('paperclip_api_request coupe une réponse de plusieurs Mo', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => issue({ id: `i${i}`, description: 'd'.repeat(3000) }));
    fake.route(`GET /api/companies/${COMPANY}/issues`, { body: big });
    const result = await run('paperclip_api_request', { method: 'GET', path: `/companies/${COMPANY}/issues` });
    expect(JSON.stringify(big).length).toBeGreaterThan(3_000_000);
    expect(result.content.length).toBeLessThanOrEqual(12_500);
    expect(result.content).toMatch(/tronqu/);
  });
});

describe('lot 9 — paperclip_deliver', () => {
  it('enchaîne document puis statut+commentaire, avec run id, en un appel', async () => {
    fake.route(`GET /api/issues/${TASK}`, { body: issue() });
    fake.route(`GET /api/issues/${TASK}/documents/analyse`, { status: 404, body: { error: 'Document not found' } });
    fake.route(`PUT /api/issues/${TASK}/documents/analyse`, { status: 201, body: { key: 'analyse', latestRevisionNumber: 1 } });
    fake.route(`PATCH /api/issues/${TASK}`, { body: issue({ status: 'done' }) });

    const result = await run('paperclip_deliver', {
      document: { key: 'analyse', title: 'Analyse', body: '# Analyse' },
      comment: 'Livré.',
      status: 'done',
    });

    expect(result.isError).toBe(false);
    const writes = fake.requests.filter((r) => r.method !== 'GET');
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
      `PUT /api/issues/${TASK}/documents/analyse`,
      `PATCH /api/issues/${TASK}`,
    ]);
    const patch = writes[1]?.body as { status: string; comment: string };
    expect(patch.status).toBe('done');
    expect(patch.comment).toContain('Livré.');
    // Lien vers le document ajouté au commentaire.
    expect(patch.comment).toContain('/ACC/issues/ACC-2285#document-analyse');
    expectAuthHeaders();
    expect(result.content).toMatch(/document/i);
    expect(result.content).toMatch(/statut/i);
  });

  it('sans statut : document puis commentaire (POST)', async () => {
    fake.route(`GET /api/issues/ACC-7/documents/plan`, { body: { key: 'plan', latestRevisionId: REV } });
    fake.route(`PUT /api/issues/ACC-7/documents/plan`, { body: { key: 'plan', latestRevisionNumber: 2 } });
    fake.route(`POST /api/issues/ACC-7/comments`, { status: 201, body: { id: 'c1' } });
    const result = await run('paperclip_deliver', { issueId: 'ACC-7', document: { key: 'plan', body: 'p' }, comment: 'Plan à jour, voir /ACC/issues/ACC-7#document-plan' });
    expect(result.isError).toBe(false);
    const writes = fake.requests.filter((r) => r.method !== 'GET');
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
      `PUT /api/issues/ACC-7/documents/plan`,
      `POST /api/issues/ACC-7/comments`,
    ]);
    // Le lien était déjà là : pas de doublon.
    expect((writes[1]?.body as { body: string }).body).toBe('Plan à jour, voir /ACC/issues/ACC-7#document-plan');
  });

  it('s’arrête au premier échec (document) : ni commentaire ni statut', async () => {
    fake.route(`GET /api/issues/${TASK}`, { body: issue() });
    fake.route(`GET /api/issues/${TASK}/documents/analyse`, { status: 404, body: { error: 'Document not found' } });
    fake.route(`PUT /api/issues/${TASK}/documents/analyse`, { status: 409, body: { error: 'Document locked' } });
    fake.route(`PATCH /api/issues/${TASK}`, { body: issue({ status: 'done' }) });
    fake.route(`POST /api/issues/${TASK}/comments`, { status: 201, body: { id: 'c1' } });

    const result = await run('paperclip_deliver', {
      document: { key: 'analyse', body: '# A' },
      comment: 'Livré.',
      status: 'done',
    });

    expect(result.isError).toBe(true);
    expect(fake.requests.some((r) => r.method === 'PATCH' || r.method === 'POST')).toBe(false);
    expect(result.content).toContain('409');
    expect(result.content).toMatch(/non fait/i);
    expect(result.content).toMatch(/commentaire/i);
  });

  it('échec de la 2e étape : le rapport dit ce qui est fait et ce qui ne l’est pas', async () => {
    fake.route(`GET /api/issues/${TASK}`, { body: issue() });
    fake.route(`GET /api/issues/${TASK}/documents/analyse`, { status: 404, body: { error: 'Document not found' } });
    fake.route(`PUT /api/issues/${TASK}/documents/analyse`, { status: 201, body: { key: 'analyse', latestRevisionNumber: 1 } });
    fake.route(`PATCH /api/issues/${TASK}`, { status: 422, body: { error: 'Transition interdite' } });

    const result = await run('paperclip_deliver', {
      document: { key: 'analyse', body: '# A' },
      comment: 'Livré.',
      status: 'done',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/fait.*document/is);
    expect(result.content).toContain('422');
    expect(result.content).toContain('Transition interdite');
    expect(result.content).toMatch(/non fait/i);
  });
});

describe('lot 9 — outils de connexion runtime', () => {
  it('fournit connections_search et connection_request quand l’hôte les donne', async () => {
    fake.route('POST /api/runtime-tools/connections/search', { body: { results: [{ service: 'gitea', state: 'ready' }] } });
    fake.route('POST /api/runtime-tools/connections/request', (req) => ({ body: { echo: String(req.headers['authorization']) } }));
    const runtimeTools = {
      connectionsSearchUrl: `${fake.baseUrl}/api/runtime-tools/connections/search`,
      connectionRequestUrl: `${fake.baseUrl}/api/runtime-tools/connections/request`,
      bearerToken: RT_TOKEN,
    };
    const search = await run('connections_search', { query: 'gitea' }, { runtimeTools });
    const request = await run('connection_request', { service: 'gitea' }, { runtimeTools });
    expect(search.isError).toBe(false);
    expect(search.content).toContain('gitea');
    expect(fake.requests[0]?.headers['authorization']).toBe(`Bearer ${RT_TOKEN}`);
    expect(fake.requests[0]?.body).toEqual({ query: 'gitea' });
    expect(fake.requests[1]?.body).toEqual({ service: 'gitea' });
    expect(request.content).not.toContain(RT_TOKEN);
  });
});

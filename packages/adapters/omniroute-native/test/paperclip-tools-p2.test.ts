import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIssueWorkProductSchema, companySearchQuerySchema } from '/opt/data/cache/scratch/paperclip-upstream/packages/shared/dist/index.js';

import { buildPaperclipTools, type PaperclipToolsOptions } from '../src/server/paperclip-tools.js';
import type { WorkspaceTool } from '../src/server/tools.js';
import { startFakePaperclip, type FakePaperclip } from './support/fake-paperclip.js';

const TOKEN = 'FAKE-RUN-JWT-p2-0001';
const RT_TOKEN = 'FAKE-TOOLS-BEARER-p2-0002';
const RUN = 'run-p2-0001';
const AGENT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const DELIVERABLE_ID = '55555555-5555-4555-8555-555555555555';

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

function expectAuthHeaders() {
  expect(fake.requests.length).toBeGreaterThan(0);
  for (const req of fake.requests) {
    expect(req.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['x-paperclip-run-id']).toBe(RUN);
  }
}

describe('P2 — paperclip_register_deliverable', () => {
  it('enregistre un livrable formel minimal conforme au schéma Zod upstream', async () => {
    fake.route(`POST /api/issues/${TASK}/work-products`, {
      body: {
        id: DELIVERABLE_ID,
        issueId: TASK,
        type: 'document',
        provider: 'paperclip',
        title: 'Rapport technique P2',
        status: 'active',
        isPrimary: false,
        createdAt: '2026-11-01T12:00:00.000Z',
      },
    });

    const result = await run('paperclip_register_deliverable', {
      type: 'document',
      title: 'Rapport technique P2',
    });

    expect(result.isError).toBe(false);
    expectAuthHeaders();
    expect(fake.requests).toHaveLength(1);
    const sentReq = fake.requests[0]!;
    expect(sentReq.path).toBe(`/api/issues/${TASK}/work-products`);
    expect(sentReq.method).toBe('POST');

    // Validation réelle contre le schéma Zod upstream
    const validated = createIssueWorkProductSchema.safeParse(sentReq.body);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.type).toBe('document');
      expect(validated.data.title).toBe('Rapport technique P2');
      expect(validated.data.provider).toBe('paperclip');
    }

    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.deliverable).toMatchObject({
      id: DELIVERABLE_ID,
      type: 'document',
      title: 'Rapport technique P2',
    });
  });

  it('enregistre un livrable complet (type, provider, url, status, summary, isPrimary, externalId)', async () => {
    fake.route(`POST /api/issues/${TASK}/work-products`, {
      body: {
        id: DELIVERABLE_ID,
        issueId: TASK,
        type: 'pull_request',
        provider: 'github',
        title: 'PR #12: Outils P2',
        url: 'https://github.com/org/repo/pull/12',
        status: 'ready_for_review',
        summary: 'Ajout de 4 outils formels',
        isPrimary: true,
        externalId: 'PR-12',
        createdAt: '2026-11-01T12:05:00.000Z',
      },
    });

    const result = await run('paperclip_register_deliverable', {
      issueId: TASK,
      type: 'pull_request',
      provider: 'github',
      title: 'PR #12: Outils P2',
      url: 'https://github.com/org/repo/pull/12',
      status: 'ready_for_review',
      summary: 'Ajout de 4 outils formels',
      isPrimary: true,
      externalId: 'PR-12',
    });

    expect(result.isError).toBe(false);
    const sentBody = fake.requests[0]!.body;
    const validated = createIssueWorkProductSchema.safeParse(sentBody);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.type).toBe('pull_request');
      expect(validated.data.provider).toBe('github');
      expect(validated.data.url).toBe('https://github.com/org/repo/pull/12');
      expect(validated.data.status).toBe('ready_for_review');
      expect(validated.data.isPrimary).toBe(true);
    }
  });

  it('gère l’alias ticket ACC-2285 comme issueId', async () => {
    fake.route('POST /api/issues/ACC-2285/work-products', {
      body: { id: DELIVERABLE_ID, issueId: TASK, type: 'document', title: 'Livrable alias' },
    });

    const result = await run('paperclip_register_deliverable', {
      issueId: 'ACC-2285',
      type: 'document',
      title: 'Livrable alias',
    });

    expect(result.isError).toBe(false);
    expect(fake.requests[0]!.path).toBe('/api/issues/ACC-2285/work-products');
  });

  it('refuse une requête sans titre ou sans type sans appel réseau', async () => {
    const resNoTitle = await run('paperclip_register_deliverable', { type: 'document' });
    expect(resNoTitle.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);

    const resNoType = await run('paperclip_register_deliverable', { title: 'Sans type' });
    expect(resNoType.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);

    const resBadType = await run('paperclip_register_deliverable', { type: 'invalid_type', title: 'Titre' });
    expect(resBadType.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('masque le jeton dans les réponses et erreurs de register_deliverable', async () => {
    fake.route(`POST /api/issues/${TASK}/work-products`, (req) => ({
      status: 400,
      body: { error: `Échec avec token ${String(req.headers['authorization'])}` },
    }));

    const result = await run('paperclip_register_deliverable', {
      type: 'document',
      title: 'Titre',
    });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(TOKEN);
    expect(result.content).toContain('[REDACTED]');
  });
});

describe('P2 — paperclip_list_deliverables', () => {
  it('liste les livrables du ticket avec projection compacte', async () => {
    fake.route(`GET /api/issues/${TASK}/work-products`, {
      body: [
        {
          id: DELIVERABLE_ID,
          issueId: TASK,
          type: 'document',
          provider: 'paperclip',
          title: 'Dossier d’architecture',
          status: 'ready_for_review',
          url: null,
          isPrimary: true,
          internalDetails: 'ne pas renvoyer de champs internes superflus',
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ],
    });

    const result = await run('paperclip_list_deliverables', {});
    expect(result.isError).toBe(false);
    expectAuthHeaders();
    expect(fake.requests[0]!.path).toBe(`/api/issues/${TASK}/work-products`);

    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(1);
    expect(parsed.deliverables[0]).toMatchObject({
      id: DELIVERABLE_ID,
      title: 'Dossier d’architecture',
      type: 'document',
      isPrimary: true,
    });
    expect(parsed.deliverables[0].internalDetails).toBeUndefined();
  });

  it('accepte un issueId explicite (alias ou UUID)', async () => {
    fake.route('GET /api/issues/ACC-2285/work-products', { body: [] });
    const result = await run('paperclip_list_deliverables', { issueId: 'ACC-2285' });
    expect(result.isError).toBe(false);
    expect(fake.requests[0]!.path).toBe('/api/issues/ACC-2285/work-products');
  });

  it('borne une liste volumineuse de livrables', async () => {
    const list = Array.from({ length: 400 }, (_, i) => ({
      id: `deliv-${i}`,
      type: 'artifact',
      provider: 'paperclip',
      title: `Livrable numéro ${i} ${'w'.repeat(100)}`,
      status: 'active',
      createdAt: '2026-11-01T10:00:00.000Z',
    }));
    fake.route(`GET /api/issues/${TASK}/work-products`, { body: list });

    const result = await run('paperclip_list_deliverables', {});
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThanOrEqual(12_500);
  });
});

describe('P2 — paperclip_get_instructions', () => {
  it('lit les consignes AGENTS.md de cet agent par défaut', async () => {
    fake.route(`GET /api/agents/${AGENT}/instructions-bundle/file`, {
      body: {
        path: 'AGENTS.md',
        size: 42,
        content: '# Directives Agent\n- Agir de façon autonome et rigoureuse.',
      },
    });

    const result = await run('paperclip_get_instructions', {});
    expect(result.isError).toBe(false);
    expectAuthHeaders();
    expect(fake.requests[0]!.path).toBe(`/api/agents/${AGENT}/instructions-bundle/file`);
    expect(fake.requests[0]!.query).toBe('path=AGENTS.md');
    expect(result.content).toContain('# Directives Agent');
  });

  it('lit un fichier de consigne spécifique (ex. CONSIGNES.md)', async () => {
    fake.route(`GET /api/agents/${AGENT}/instructions-bundle/file`, {
      body: {
        path: 'CONSIGNES.md',
        content: 'Règles spécifiques au rôle.',
      },
    });

    const result = await run('paperclip_get_instructions', { fileName: 'CONSIGNES.md' });
    expect(result.isError).toBe(false);
    expect(fake.requests[0]!.query).toBe('path=CONSIGNES.md');
    expect(result.content).toContain('Règles spécifiques au rôle.');
  });

  it('fenêtre les consignes volumineuses avec offset', async () => {
    const content = 'x'.repeat(15_000);
    fake.route(`GET /api/agents/${AGENT}/instructions-bundle/file`, {
      body: { path: 'AGENTS.md', content },
    });

    const page1 = await run('paperclip_get_instructions', { offset: 0 });
    expect(page1.isError).toBe(false);
    expect(page1.content).toContain('[caractères 0-10000 sur 15000 — suite avec offset=10000]');

    const page2 = await run('paperclip_get_instructions', { offset: 10000 });
    expect(page2.isError).toBe(false);
    expect(page2.content).toContain('[caractères 10000-15000 sur 15000 — fin]');
  });

  it('refuse si agentId est manquant sans émettre d’appel HTTP', async () => {
    const result = await run('paperclip_get_instructions', {}, { agentId: null });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
    expect(result.content).toMatch(/agent/i);
  });

  it('garantit l’omission stricte d’écriture de consignes ou d’auto-modification de droits', () => {
    const allTools = tools();
    const names = Array.from(allTools.keys());
    expect(names).not.toContain('paperclip_update_instructions');
    expect(names).not.toContain('paperclip_write_instructions');
    expect(names).not.toContain('paperclip_modify_rights');
    expect(names).not.toContain('paperclip_resolve_review');
    expect(names).not.toContain('resolve_review');
  });
});

describe('P2 — paperclip_search_tasks', () => {
  it('recherche les tickets existants et valide la requête contre le schéma amont', async () => {
    fake.route(`GET /api/companies/${COMPANY}/search`, {
      body: {
        query: 'auth refactor',
        scope: 'issues',
        limit: 20,
        offset: 0,
        results: [
          {
            id: 'res-1',
            type: 'issue',
            title: 'Refactor authentification',
            snippet: 'Mise à niveau de la vérification de jeton',
            issue: {
              id: TASK,
              identifier: 'ACC-2280',
              title: 'Refactor authentification',
              status: 'in_progress',
              priority: 'high',
            },
          },
        ],
        hasMore: false,
      },
    });

    const result = await run('paperclip_search_tasks', { query: 'auth refactor' });
    expect(result.isError).toBe(false);
    expectAuthHeaders();
    expect(fake.requests).toHaveLength(1);
    const sentReq = fake.requests[0]!;
    expect(sentReq.path).toBe(`/api/companies/${COMPANY}/search`);

    // Analyse query parameters contre companySearchQuerySchema upstream
    const qs = new URLSearchParams(sentReq.query);
    const queryObj = Object.fromEntries(qs.entries());
    const validated = companySearchQuerySchema.safeParse(queryObj);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.q).toBe('auth refactor');
      expect(validated.data.scope).toBe('issues');
    }

    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(1);
    expect(parsed.tasks[0]).toMatchObject({
      id: TASK,
      identifier: 'ACC-2280',
      title: 'Refactor authentification',
      status: 'in_progress',
      priority: 'high',
    });
  });

  it('transmet les filtres status, limit et offset', async () => {
    fake.route(`GET /api/companies/${COMPANY}/search`, {
      body: { query: 'sync', scope: 'issues', results: [], hasMore: false },
    });

    const result = await run('paperclip_search_tasks', {
      query: 'sync',
      status: 'todo',
      limit: 10,
      offset: 20,
    });
    expect(result.isError).toBe(false);

    const qs = new URLSearchParams(fake.requests[0]!.query);
    expect(qs.get('q')).toBe('sync');
    expect(qs.get('status')).toBe('todo');
    expect(qs.get('limit')).toBe('10');
    expect(qs.get('offset')).toBe('20');
  });

  it('refuse une requête vide ou sans companyId sans appel réseau', async () => {
    const resNoQuery = await run('paperclip_search_tasks', { query: '   ' });
    expect(resNoQuery.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);

    const resNoCompany = await run('paperclip_search_tasks', { query: 'test' }, { companyId: null });
    expect(resNoCompany.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});

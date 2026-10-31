import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPaperclipTools, type PaperclipToolsOptions } from '../src/server/paperclip-tools.js';
import {
  buildDecisionCardTools,
  ASK_USER_TOOL_SCHEMA,
  REQUEST_CONFIRMATION_TOOL_SCHEMA,
} from '../src/server/decision-cards.js';
import type { WorkspaceTool } from '../src/server/tools.js';
import { startFakePaperclip, type FakePaperclip } from './support/fake-paperclip.js';

const TOKEN = 'FAKE-RUN-JWT-dec-0001';
const RUN = 'run-dec-0001';
const AGENT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';

let fake: FakePaperclip;

beforeEach(async () => {
  fake = await startFakePaperclip();
});
afterEach(async () => {
  await fake.close();
});

function getTools(overrides: Partial<PaperclipToolsOptions> = {}): Map<string, WorkspaceTool> {
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

async function runTool(name: string, input: unknown, overrides: Partial<PaperclipToolsOptions> = {}) {
  const tool = getTools(overrides).get(name);
  if (!tool) throw new Error(`Outil absent : ${name}`);
  return tool.run(input);
}

describe('TC-DEC-01 — Schéma valide paperclip_ask_user (single_select & selectionMode)', () => {
  it('construit questions avec selectionMode single et options compatibles Zod, et passe en in_review', async () => {
    let interactionPosted: any = null;
    let issuePatched: any = null;

    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));
    fake.route(`POST /api/issues/${TASK}/interactions`, (req) => {
      interactionPosted = req.body;
      return { status: 201, body: { id: 'inter-123', status: 'pending' } };
    });
    fake.route(`PATCH /api/issues/${TASK}`, (req) => {
      issuePatched = req.body;
      return { status: 200, body: { id: TASK, status: 'in_review' } };
    });

    const result = await runTool('paperclip_ask_user', {
      title: "Choix de l'architecture d'indexation",
      questions: [
        {
          id: 'embedding_provider',
          prompt: 'Quel modèle d’embedding souhaitez-vous utiliser ?',
          selectionMode: 'single',
          required: true,
          options: [
            { id: 'qwen_local', label: 'Qwen local (DGX Spark)', description: 'Gratuit et local.' },
            { id: 'openai_api', label: 'OpenAI API', description: 'Distant payant.' },
          ],
          customAnswer: true,
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.waitingForHuman).toBe(true);

    const parsedContent = JSON.parse(result.content);
    expect(parsedContent.ok).toBe(true);
    expect(parsedContent.interactionId).toBe('inter-123');
    expect(parsedContent.status).toBe('pending');
    expect(parsedContent.waitingForHuman).toBe(true);

    // Vérification du payload de l'interaction
    expect(interactionPosted).toBeDefined();
    expect(interactionPosted.kind).toBe('ask_user_questions');
    expect(interactionPosted.resolverPolicy).toBe('human_only');
    expect(interactionPosted.continuationPolicy).toBe('wake_assignee');
    expect(interactionPosted.payload.version).toBe(1);

    // questions normalisées pour le schéma d'interaction Paperclip (askUserQuestionsPayloadSchema)
    expect(interactionPosted.payload.questions).toBeDefined();
    expect(interactionPosted.payload.questions).toHaveLength(1);
    const storageQ = interactionPosted.payload.questions[0];
    expect(storageQ.id).toBe('embedding_provider');
    expect(storageQ.selectionMode).toBe('single');
    expect(storageQ.answerMode).toBeUndefined();
    expect(storageQ.required).toBe(true);
    expect(storageQ.allowOther).toBe(true);
    // 2 choix initiaux + 1 sentinelle freeText pour customAnswer
    expect(storageQ.options).toHaveLength(3);
    expect(storageQ.options[0]).toEqual({ id: 'qwen_local', label: 'Qwen local (DGX Spark)', description: 'Gratuit et local.' });
    expect(storageQ.options[1]).toEqual({ id: 'openai_api', label: 'OpenAI API', description: 'Distant payant.' });
    expect(storageQ.options[2]).toMatchObject({ freeText: true });

    // questionSet canonique v1 pour la présentation UI
    expect(interactionPosted.payload.questionSet).toBeDefined();
    expect(interactionPosted.payload.questionSet.schema).toBe('paperclip.question_set.v1');
    expect(interactionPosted.payload.questionSet.title).toBe("Choix de l'architecture d'indexation");
    expect(interactionPosted.payload.questionSet.questions).toHaveLength(1);
    const canonicalQ = interactionPosted.payload.questionSet.questions[0];
    expect(canonicalQ.id).toBe('embedding_provider');
    expect(canonicalQ.answerMode).toBe('single_select');
    expect(canonicalQ.options).toHaveLength(2);
    expect(canonicalQ.customAnswer).toEqual({ enabled: true, label: 'Autre choix' });

    // Vérification du patch in_review
    expect(issuePatched).toBeDefined();
    expect(issuePatched.status).toBe('in_review');
    expect(issuePatched.comment).toContain("Choix de l'architecture d'indexation");
  });

  it('génère une question de texte libre valide avec option freeText sentinelle', async () => {
    let interactionPosted: any = null;
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));
    fake.route(`POST /api/issues/${TASK}/interactions`, (req) => {
      interactionPosted = req.body;
      return { status: 201, body: { id: 'inter-text-1', status: 'pending' } };
    });
    fake.route(`PATCH /api/issues/${TASK}`, () => ({ status: 200, body: { id: TASK, status: 'in_review' } }));

    const result = await runTool('paperclip_ask_user', {
      title: 'Question texte libre',
      questions: [
        {
          id: 'user_comment',
          prompt: 'Quelles sont vos remarques ?',
          answerMode: 'text',
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.waitingForHuman).toBe(true);

    expect(interactionPosted).toBeDefined();
    const q = interactionPosted.payload.questions[0];
    expect(q.id).toBe('user_comment');
    expect(q.selectionMode).toBe('single');
    expect(q.allowOther).toBe(true);
    expect(q.options).toHaveLength(1);
    expect(q.options[0].freeText).toBe(true);

    const cq = interactionPosted.payload.questionSet.questions[0];
    expect(cq.id).toBe('user_comment');
    expect(cq.answerMode).toBe('text');
  });

  it('génère une question multi-select avec selectionMode multi', async () => {
    let interactionPosted: any = null;
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));
    fake.route(`POST /api/issues/${TASK}/interactions`, (req) => {
      interactionPosted = req.body;
      return { status: 201, body: { id: 'inter-multi-1', status: 'pending' } };
    });
    fake.route(`PATCH /api/issues/${TASK}`, () => ({ status: 200, body: { id: TASK, status: 'in_review' } }));

    const result = await runTool('paperclip_ask_user', {
      title: 'Question multi',
      questions: [
        {
          id: 'features',
          prompt: 'Quelles options activer ?',
          selectionMode: 'multi',
          options: [
            { id: 'f1', label: 'Feature 1' },
            { id: 'f2', label: 'Feature 2' },
          ],
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.waitingForHuman).toBe(true);

    const q = interactionPosted.payload.questions[0];
    expect(q.id).toBe('features');
    expect(q.selectionMode).toBe('multi');
    expect(q.options).toHaveLength(2);

    const cq = interactionPosted.payload.questionSet.questions[0];
    expect(cq.answerMode).toBe('multi_select');
  });
});

describe('TC-DEC-02 — Refus de question à choix avec moins de 2 options', () => {
  it('lève une erreur claire quand single_select ou multi_select a moins de 2 options', async () => {
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));

    const result = await runTool('paperclip_ask_user', {
      title: 'Choix invalide',
      questions: [
        {
          id: 'bad_choice',
          prompt: 'Un seul choix ?',
          answerMode: 'single_select',
          options: [{ id: 'opt1', label: 'Option 1' }],
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/au moins 2 options/i);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.includes('/interactions'))).toHaveLength(0);
  });
});

describe('TC-DEC-03 — Génération d’une clé d’idempotence automatique', () => {
  it('génère une clé déterministe préfixée questions:{issueId}: si omise', async () => {
    let capturedBody: any = null;
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));
    fake.route(`POST /api/issues/${TASK}/interactions`, (req) => {
      capturedBody = req.body;
      return { status: 201, body: { id: 'inter-idem', status: 'pending' } };
    });
    fake.route(`PATCH /api/issues/${TASK}`, () => ({ status: 200, body: { id: TASK, status: 'in_review' } }));

    await runTool('paperclip_ask_user', {
      title: 'Choix de DB',
      questions: [
        {
          id: 'db',
          prompt: 'Quelle base ?',
          options: [
            { id: 'pg', label: 'PostgreSQL' },
            { id: 'sqlite', label: 'SQLite' },
          ],
        },
      ],
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody.idempotencyKey).toMatch(new RegExp(`^questions:${TASK}:`));
  });
});

describe('TC-DEC-04 — Enchaînement atomique interaction + PATCH in_review', () => {
  it('exécute POST interaction puis PATCH in_review dans l’ordre', async () => {
    const sequence: string[] = [];
    fake.route(`GET /api/issues/${TASK}/interactions`, () => {
      sequence.push('GET_INTERACTIONS');
      return { status: 200, body: [] };
    });
    fake.route(`POST /api/issues/${TASK}/interactions`, () => {
      sequence.push('POST_INTERACTION');
      return { status: 201, body: { id: 'inter-atom', status: 'pending' } };
    });
    fake.route(`PATCH /api/issues/${TASK}`, () => {
      sequence.push('PATCH_ISSUE');
      return { status: 200, body: { id: TASK, status: 'in_review' } };
    });

    const result = await runTool('paperclip_ask_user', {
      title: 'Question test',
      questions: [
        {
          id: 'q1',
          prompt: 'Option ?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(sequence).toEqual(['GET_INTERACTIONS', 'POST_INTERACTION', 'PATCH_ISSUE']);
  });

  it('annule l’interaction créée si le PATCH in_review échoue (rollback via /withdraw)', async () => {
    let withdrawCalled = false;
    let withdrawBody: any = null;
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));
    fake.route(`POST /api/issues/${TASK}/interactions`, () => ({
      status: 201,
      body: { id: 'inter-fail-patch', status: 'pending' },
    }));
    fake.route(`PATCH /api/issues/${TASK}`, () => ({
      status: 500,
      body: { error: 'Erreur interne de base de données' },
    }));
    fake.route(`POST /api/issues/${TASK}/interactions/inter-fail-patch/withdraw`, (req) => {
      withdrawCalled = true;
      withdrawBody = req.body;
      return { status: 200, body: { ok: true } };
    });

    const result = await runTool('paperclip_ask_user', {
      title: 'Question test rollback',
      questions: [
        {
          id: 'q1',
          prompt: 'Option ?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(withdrawCalled).toBe(true);
    expect(withdrawBody).toEqual({ reason: 'Échec de synchronisation de la posture in_review' });
  });

  it('annule l’interaction request_confirmation via /withdraw si le PATCH in_review échoue', async () => {
    let withdrawCalled = false;
    let withdrawBody: any = null;
    fake.route(`GET /api/issues/${TASK}/documents/plan`, () => ({
      status: 200,
      body: { latestRevisionId: 'rev-xyz' },
    }));
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));
    fake.route(`POST /api/issues/${TASK}/interactions`, () => ({
      status: 201,
      body: { id: 'conf-fail-patch', status: 'pending' },
    }));
    fake.route(`PATCH /api/issues/${TASK}`, () => ({
      status: 500,
      body: { error: 'Erreur patch' },
    }));
    fake.route(`POST /api/issues/${TASK}/interactions/conf-fail-patch/withdraw`, (req) => {
      withdrawCalled = true;
      withdrawBody = req.body;
      return { status: 200, body: { ok: true } };
    });

    const result = await runTool('paperclip_request_confirmation', {
      title: 'Validation test rollback',
      prompt: 'Valider ?',
      targetKey: 'plan',
    });

    expect(result.isError).toBe(true);
    expect(withdrawCalled).toBe(true);
    expect(withdrawBody).toEqual({ reason: 'Échec de synchronisation de la posture in_review' });
  });
});

describe('TC-DEC-05 — paperclip_request_confirmation avec doc existant', () => {
  it('résout latestRevisionId via GET /documents/{targetKey} et lie target', async () => {
    fake.route(`GET /api/issues/${TASK}/documents/plan`, () => ({
      status: 200,
      body: {
        key: 'plan',
        title: 'Plan de migration',
        latestRevisionId: 'rev-xyz-42',
        latestRevisionNumber: 3,
      },
    }));
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));

    let interactionPosted: any = null;
    fake.route(`POST /api/issues/${TASK}/interactions`, (req) => {
      interactionPosted = req.body;
      return { status: 201, body: { id: 'inter-conf-1', status: 'pending' } };
    });
    fake.route(`PATCH /api/issues/${TASK}`, () => ({ status: 200, body: { id: TASK, status: 'in_review' } }));

    const result = await runTool('paperclip_request_confirmation', {
      title: 'Validation du plan de migration',
      prompt: 'Validez-vous le plan de migration v1.2 ?',
      targetKey: 'plan',
    });

    expect(result.isError).toBe(false);
    expect(result.waitingForHuman).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.target).toEqual({ key: 'plan', revisionId: 'rev-xyz-42' });

    expect(interactionPosted).toBeDefined();
    expect(interactionPosted.kind).toBe('request_confirmation');
    expect(interactionPosted.idempotencyKey).toBe(`confirmation:${TASK}:plan:rev-xyz-42`);
    expect(interactionPosted.continuationPolicy).toBe('wake_assignee');
    expect(interactionPosted.payload.target).toEqual({
      type: 'issue_document',
      issueId: TASK,
      key: 'plan',
      revisionId: 'rev-xyz-42',
    });
  });
});

describe('TC-DEC-06 — paperclip_request_confirmation sans doc existant', () => {
  it('refuse immédiatement si le document cible n’existe pas (404)', async () => {
    fake.route(`GET /api/issues/${TASK}/documents/plan`, () => ({
      status: 404,
      body: { error: 'Document not found' },
    }));

    const result = await runTool('paperclip_request_confirmation', {
      title: 'Validation plan inexistant',
      prompt: 'Validez-vous ?',
      targetKey: 'plan',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Le document 'plan' n'existe pas/i);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.includes('/interactions'))).toHaveLength(0);
  });
});

describe('TC-DEC-07 — Présence obligatoire de continuationPolicy: "wake_assignee"', () => {
  it('définit explicitement continuationPolicy à wake_assignee pour request_confirmation', async () => {
    fake.route(`GET /api/issues/${TASK}/documents/plan`, () => ({
      status: 200,
      body: { latestRevisionId: 'rev-10' },
    }));
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));

    let posted: any = null;
    fake.route(`POST /api/issues/${TASK}/interactions`, (req) => {
      posted = req.body;
      return { status: 201, body: { id: 'inter-policy', status: 'pending' } };
    });
    fake.route(`PATCH /api/issues/${TASK}`, () => ({ status: 200, body: { id: TASK, status: 'in_review' } }));

    await runTool('paperclip_request_confirmation', {
      title: 'Validation',
      prompt: 'OK ?',
      targetKey: 'plan',
    });

    expect(posted).toBeDefined();
    expect(posted.continuationPolicy).toBe('wake_assignee');
  });
});

describe('TC-DEC-08 — Erreur HTTP 409 ou interaction déjà pendante', () => {
  it('refuse si une interaction de même kind est déjà pending', async () => {
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({
      status: 200,
      body: [{ id: 'existing-pending-1', kind: 'ask_user_questions', status: 'pending' }],
    }));

    const result = await runTool('paperclip_ask_user', {
      title: 'Nouvelle question doublon',
      questions: [
        {
          id: 'q1',
          prompt: 'Q ?',
          options: [
            { id: '1', label: '1' },
            { id: '2', label: '2' },
          ],
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/déjà en attente sur ce ticket/i);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.includes('/interactions'))).toHaveLength(0);
  });

  it('renvoie une erreur propre sans crash en cas de réponse HTTP 409 du serveur', async () => {
    fake.route(`GET /api/issues/${TASK}/interactions`, () => ({ status: 200, body: [] }));
    fake.route(`POST /api/issues/${TASK}/interactions`, () => ({
      status: 409,
      body: { error: 'Conflict: interaction with this idempotency key already exists' },
    }));

    const result = await runTool('paperclip_ask_user', {
      title: 'Question avec conflit serveur',
      questions: [
        {
          id: 'q1',
          prompt: 'Q ?',
          options: [
            { id: '1', label: '1' },
            { id: '2', label: '2' },
          ],
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/HTTP 409/);
  });
});

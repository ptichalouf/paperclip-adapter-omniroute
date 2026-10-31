import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import type { WorkspaceTool } from '../src/server/tools.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';
import { startFakePaperclip, type FakePaperclip } from './support/fake-paperclip.js';
import { startFakeGateway } from './support/fake-gateway.js';

let outer: string;
let root: string;
let fakePaperclip: FakePaperclip;
const TASK = '33333333-3333-4333-8333-333333333333';

beforeEach(async () => {
  outer = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-dec-loop-'));
  root = path.join(outer, 'workspace');
  await fs.mkdir(root);
  fakePaperclip = await startFakePaperclip();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fakePaperclip.close();
  await fs.rm(outer, { recursive: true, force: true });
});

function modelResult(content: unknown[], stopReason = 'tool_calls') {
  return {
    content,
    stopReason,
    model: 'fake',
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    gatewayHeaders: {},
    costUsd: null,
  };
}

describe('TC-LOOP-01 & TC-LOOP-02 — Interception dans agent-loop (Yield & pas de synthèse)', () => {
  it('TC-LOOP-01: la boucle s’arrête immédiatement après l’outil d’interaction (turns = 1)', async () => {
    const askUserTool: WorkspaceTool = {
      spec: {
        name: 'paperclip_ask_user',
        description: 'Pose une question',
        input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
      run: async () => ({
        content: JSON.stringify({ ok: true, waitingForHuman: true, message: 'Attente utilisateur' }),
        isError: false,
        waitingForHuman: true,
      }),
    };

    const responses = [
      modelResult([
        { type: 'text', text: 'Je demande confirmation à l’utilisateur.' },
        { type: 'tool_use', id: 'call_1', name: 'paperclip_ask_user', input: { title: 'Choix' } },
      ]),
      // Si la boucle continuait, elle consommerait ce second appel
      modelResult([{ type: 'text', text: 'Second tour imprévu !' }]),
    ];

    const mockClient = {
      streamMessage: vi.fn(async () => responses.shift()!),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'fake',
      system: 'system',
      initialUserMessage: 'Go',
      tools: [askUserTool],
      maxTokens: 100,
      reasoningEffort: 'none',
      maxTurns: 10,
      emit: async () => {},
      warn: async () => {},
    };

    const result = await runAgentLoop(options);

    expect(result.turns).toBe(1);
    expect(result.completion).toBe('completed');
    expect(result.finalSynthesized).toBe(false);
    expect(mockClient.streamMessage).toHaveBeenCalledTimes(1);
    // Pas de dump JSON dans finalText lors d'une attente humaine
    expect(result.finalText).toBe('');
  });

  it('TC-LOOP-02: désactive le tour de synthèse forcée FINAL_ANSWER_PROMPT sur attente humaine', async () => {
    const confirmTool: WorkspaceTool = {
      spec: {
        name: 'paperclip_request_confirmation',
        description: 'Demande confirmation',
        input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
      run: async () => ({
        content: JSON.stringify({ ok: true, waitingForHuman: true, message: 'Plan soumis' }),
        isError: false,
        waitingForHuman: true,
      }),
    };

    const responses = [
      modelResult([
        { type: 'tool_use', id: 'call_1', name: 'paperclip_request_confirmation', input: { title: 'Plan' } },
      ]),
    ];

    const mockClient = {
      streamMessage: vi.fn(async () => responses.shift()!),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'fake',
      system: 'system',
      initialUserMessage: 'Valider plan',
      tools: [confirmTool],
      maxTokens: 100,
      reasoningEffort: 'none',
      maxTurns: 10,
      emit: async () => {},
      warn: async () => {},
    };

    const result = await runAgentLoop(options);

    expect(result.completion).toBe('completed');
    expect(result.finalSynthesized).toBe(false);
    // Aucun deuxième appel de synthèse
    expect(mockClient.streamMessage).toHaveBeenCalledTimes(1);
  });
});

describe('TC-LOOP-03 — Sauvegarde de session lors du yield d’attente', () => {
  it('appelle onCheckpoint avec les messages complets (tool_use + tool_result)', async () => {
    const askUserTool: WorkspaceTool = {
      spec: {
        name: 'paperclip_ask_user',
        description: 'Pose une question',
        input_schema: { type: 'object', properties: { title: { type: 'string' } } },
      },
      run: async () => ({
        content: JSON.stringify({ ok: true, waitingForHuman: true, message: 'Attente' }),
        isError: false,
        waitingForHuman: true,
      }),
    };

    let checkpointMessages: any[] = [];
    const mockClient = {
      streamMessage: vi.fn(async () =>
        modelResult([
          { type: 'tool_use', id: 'call_1', name: 'paperclip_ask_user', input: { title: 'Q' } },
        ]),
      ),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'fake',
      system: '',
      initialUserMessage: 'Initial',
      tools: [askUserTool],
      maxTokens: 100,
      reasoningEffort: 'none',
      maxTurns: 5,
      emit: async () => {},
      warn: async () => {},
      onCheckpoint: async (snap) => {
        checkpointMessages = snap.messages;
      },
    };

    const result = await runAgentLoop(options);

    expect(checkpointMessages.length).toBeGreaterThanOrEqual(3); // user initial, assistant tool_use, user tool_result
    const lastUser = checkpointMessages[checkpointMessages.length - 1];
    expect(lastUser.role).toBe('user');
    expect(lastUser.content[0].type).toBe('tool_result');
    expect(lastUser.content[0].content).toContain('waitingForHuman');
  });
});

describe('TC-LOOP-04 & TC-LOOP-05 — Réveil et reprise de contexte après interaction', () => {
  it('TC-LOOP-04: injecte les réponses utilisateur dans le prompt lors d’un réveil après validation', async () => {
    function streamResponse(chunks: unknown[]): Response {
      return new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }

    let capturedPrompt = '';
    vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      const userMsg = body.messages?.find((m: any) => m.role === 'user');
      capturedPrompt = userMsg ? (typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content)) : '';
      return streamResponse([
        { choices: [{ delta: { content: 'Plan validé, je commence le travail.' }, finish_reason: 'stop' }] },
      ]);
    }));

    const { ctx } = makeTestContext({
      config: { baseUrl: 'http://fake.invalid', apiKey: 'test-key', reasoningEffort: 'none' },
      context: {
        paperclipWorkspace: { cwd: root },
        wakeReason: 'issue_thread_interaction_response',
        paperclipWake: {
          planReviewContext: {
            interaction: {
              id: 'inter-conf-1',
              kind: 'request_confirmation',
              status: 'accepted',
              target: { key: 'plan', revisionId: 'rev-3', revisionNumber: 3 },
            },
          },
        },
      },
    });

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    // Le wake prompt doit contenir des indications sur l'interaction validée
    expect(capturedPrompt).toMatch(/accepted|plan|revision/i);
  });

  it('TC-LOOP-05: injecte le motif de rejet dans le prompt lors d’un réveil après refus', async () => {
    function streamResponse(chunks: unknown[]): Response {
      return new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }

    let capturedPrompt = '';
    vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      const userMsg = body.messages?.find((m: any) => m.role === 'user');
      capturedPrompt = userMsg ? (typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content)) : '';
      return streamResponse([
        { choices: [{ delta: { content: 'Plan rejeté, je corrige selon vos retours.' }, finish_reason: 'stop' }] },
      ]);
    }));

    const { ctx } = makeTestContext({
      config: { baseUrl: 'http://fake.invalid', apiKey: 'test-key', reasoningEffort: 'none' },
      context: {
        paperclipWorkspace: { cwd: root },
        wakeReason: 'issue_thread_interaction_response',
        paperclipWake: {
          planReviewContext: {
            interaction: {
              id: 'inter-conf-2',
              kind: 'request_confirmation',
              status: 'rejected',
              result: {
                reason: 'Privilégier une approche sans nouvelle table en base.',
              },
            },
          },
        },
      },
    });

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(capturedPrompt).toContain('Privilégier une approche sans nouvelle table en base.');
  });
});

describe('TC-LOOP-06 — Arrêt IMMÉDIAT des outils restants avec paires tool/result cohérentes', () => {
  it('interrompt l’exécution des outils suivants dès qu’un outil signale waitingForHuman mais génère des tool_result cohérents', async () => {
    let shellRan = false;
    const askUserTool: WorkspaceTool = {
      spec: {
        name: 'paperclip_ask_user',
        description: 'Pose une question',
        input_schema: { type: 'object', properties: { title: { type: 'string' } } },
      },
      run: async () => ({
        content: JSON.stringify({ ok: true, waitingForHuman: true, message: 'Attente' }),
        isError: false,
        waitingForHuman: true,
      }),
    };

    const shellTool: WorkspaceTool = {
      spec: {
        name: 'shell',
        description: 'Exécute une commande',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
      run: async () => {
        shellRan = true;
        return { content: 'Commande exécutée', isError: false };
      },
    };

    let checkpointMessages: any[] = [];
    const mockClient = {
      streamMessage: vi.fn(async () =>
        modelResult([
          { type: 'tool_use', id: 'call_ask', name: 'paperclip_ask_user', input: { title: 'Q' } },
          { type: 'tool_use', id: 'call_shell', name: 'shell', input: { command: 'rm -rf /' } },
        ]),
      ),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'fake',
      system: '',
      initialUserMessage: 'Go',
      tools: [askUserTool, shellTool],
      maxTokens: 100,
      reasoningEffort: 'none',
      maxTurns: 5,
      emit: async () => {},
      warn: async () => {},
      onCheckpoint: async (snap) => {
        checkpointMessages = snap.messages;
      },
    };

    const result = await runAgentLoop(options);

    expect(result.completion).toBe('completed');
    expect(result.waitingForHuman).toBe(true);
    // Le shell ne doit JAMAIS avoir été exécuté !
    expect(shellRan).toBe(false);

    // Les messages doivent contenir les 2 tool_results pour éviter d'invalider le fil chez les providers
    const lastUser = checkpointMessages[checkpointMessages.length - 1];
    expect(lastUser.role).toBe('user');
    expect(lastUser.content).toHaveLength(2);
    expect(lastUser.content[0].tool_use_id).toBe('call_ask');
    expect(lastUser.content[0].content).toContain('waitingForHuman');
    expect(lastUser.content[1].tool_use_id).toBe('call_shell');
    expect(lastUser.content[1].content).toMatch(/non exécuté|attente/i);
    // Pas d'erreur déclarée qui provoquerait un stuck
    expect(lastUser.content[1].is_error).toBeFalsy();
  });
});

describe('TC-LOOP-07 — Aucune finalResponse JSON en attente humaine dans execute()', () => {
  it('omet finalResponse et summary lorsque waitingForHuman est vrai pour ne pas polluer le ticket', async () => {
    fakePaperclip.route(`GET /api/issues/${TASK}/interactions`, () => ({
      status: 200,
      body: [],
    }));
    fakePaperclip.route(`POST /api/issues/${TASK}/interactions`, () => ({
      status: 201,
      body: { id: 'inter-999', status: 'pending' },
    }));
    fakePaperclip.route(`PATCH /api/issues/${TASK}`, () => ({
      status: 200,
      body: { id: TASK, status: 'in_review' },
    }));
    vi.stubEnv('PAPERCLIP_API_URL', fakePaperclip.baseUrl);

    const gateway = await startFakeGateway({
      toolCall: {
        name: 'paperclip_ask_user',
        input: {
          title: 'Question de cadrage',
          questions: [
            {
              id: 'q1',
              prompt: 'Architecture ?',
              selectionMode: 'single',
              options: [
                { id: 'a', label: 'Option A' },
                { id: 'b', label: 'Option B' },
              ],
            },
          ],
        },
      },
    });

    try {
      const { ctx } = makeTestContext({
        config: { baseUrl: gateway.baseUrl },
        context: {
          paperclipWorkspace: { cwd: root, agentHome: root },
          taskId: TASK,
        },
      });
      (ctx as Record<string, unknown>)['authToken'] = 'FAKE-JWT-FOR-TEST';

      const result = await execute(ctx as never);

      expect(result.exitCode).toBe(0);
      const resultJson = result.resultJson as Record<string, unknown> | undefined;
      expect(resultJson).toBeDefined();
      expect(resultJson?.['waitingForHuman']).toBe(true);
      // AUCUNE finalResponse ni summary ne doit être présente pour éviter le dump JSON Paperclip !
      expect(resultJson?.['finalResponse']).toBeUndefined();
      expect(resultJson?.['summary']).toBeUndefined();
    } finally {
      await gateway.close();
    }
  });
});

describe('TC-LOOP-08 — Pas d’escalade de modèle lors d’une attente humaine', () => {
  it('ne déclenche pas d’escalade vers escalationModels lorsque la boucle s’arrête sur waitingForHuman', async () => {
    const askUserTool: WorkspaceTool = {
      spec: {
        name: 'paperclip_ask_user',
        description: 'Pose une question',
        input_schema: { type: 'object', properties: { title: { type: 'string' } } },
      },
      run: async () => ({
        content: JSON.stringify({ ok: true, waitingForHuman: true, message: 'Attente' }),
        isError: false,
        waitingForHuman: true,
      }),
    };

    const mockClient = {
      streamMessage: vi.fn(async () =>
        modelResult([
          { type: 'tool_use', id: 'call_1', name: 'paperclip_ask_user', input: { title: 'Q' } },
        ]),
      ),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'primary-model',
      escalationModels: ['backup-model-1', 'backup-model-2'],
      maxEscalations: 2,
      system: '',
      initialUserMessage: 'Initial',
      tools: [askUserTool],
      maxTokens: 100,
      reasoningEffort: 'none',
      maxTurns: 5,
      emit: async () => {},
      warn: async () => {},
    };

    const result = await runAgentLoop(options);

    expect(result.completion).toBe('completed');
    expect(result.waitingForHuman).toBe(true);
    // Aucune escalade ne doit avoir eu lieu !
    expect(result.escalations).toHaveLength(0);
    expect(result.finalModel).toBe('primary-model');
    expect(mockClient.streamMessage).toHaveBeenCalledTimes(1);
  });
});

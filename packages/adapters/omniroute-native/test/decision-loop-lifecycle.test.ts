import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import type { WorkspaceTool } from '../src/server/tools.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';
import { startFakePaperclip, type FakePaperclip } from './support/fake-paperclip.js';

let outer: string;
let root: string;
let fakePaperclip: FakePaperclip;

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
    expect(result.finalText).toContain('Attente utilisateur');
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

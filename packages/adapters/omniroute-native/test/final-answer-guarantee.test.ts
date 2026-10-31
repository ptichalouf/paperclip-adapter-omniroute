/**
 * Lot 13 — réponse finale garantie et statut honnête (Paperclip ACC-2295).
 *
 * Mesuré sur 85 runs omniroute_native : 31 runs « réussis » sans aucun texte
 * final. Chaque test ci-dessous échouait sur main 1b6ff75.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FINAL_ANSWER_PROMPT, runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import { buildChatCompletionsPayload } from '../src/shared/chat-completions.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-lot13-')); });
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

function modelResult(content: unknown[], stopReason = 'tool_calls') {
  return { content, stopReason, model: 'fake', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, gatewayHeaders: {}, costUsd: null };
}
const noop = { spec: { name: 'noop', description: '', input_schema: { type: 'object', properties: {} } }, run: vi.fn(async () => ({ content: 'ok', isError: false })) };
function options(client: unknown, more: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return { client: client as never, model: 'fake', system: '', initialUserMessage: 'test', tools: [noop], maxTokens: 100, reasoningEffort: 'none', maxTurns: 0, emit: async () => {}, warn: async () => {}, ...more };
}
const toolTurn = (id: string) => modelResult([{ type: 'tool_use', id, name: 'noop', input: {} }]);

describe('lot 13 — tour de synthèse finale sans outils', () => {
  it('tours épuisés : un dernier tour sans outils produit la réponse finale', async () => {
    const responses = [toolTurn('a'), toolTurn('b'), modelResult([{ type: 'text', text: 'Bilan : fait X, reste Y.' }], 'stop')];
    const mock = { streamMessage: vi.fn(async () => responses.shift()!) };
    const result = await runAgentLoop(options(mock, { maxTurns: 2 }));
    expect(result).toMatchObject({ completion: 'completed', finalText: 'Bilan : fait X, reste Y.', finalSynthesized: true, turns: 3 });
    const last = (mock.streamMessage.mock.calls.at(-1) as unknown as [{ toolChoice?: string; tools: unknown[] }])[0];
    expect(last.toolChoice).toBe('none');
    expect(last.tools.length).toBe(1);
  });

  it('dernier tour vide : la synthèse est demandée', async () => {
    const responses = [toolTurn('a'), modelResult([], 'stop'), modelResult([{ type: 'text', text: 'Réponse.' }], 'stop')];
    const mock = { streamMessage: vi.fn(async () => responses.shift()!) };
    const result = await runAgentLoop(options(mock));
    expect(result).toMatchObject({ completion: 'completed', finalText: 'Réponse.', finalSynthesized: true });
  });

  it('un appel d’outil pendant la synthèse n’est pas exécuté ni laissé dans l’historique', async () => {
    noop.run.mockClear();
    const responses = [toolTurn('a'), toolTurn('b'), toolTurn('c')];
    const mock = { streamMessage: vi.fn(async () => responses.shift()!) };
    const result = await runAgentLoop(options(mock, { maxTurns: 2 }));
    expect(noop.run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ completion: 'max_turns', finalText: '', finalSynthesized: false });
    const lastUser = [...result.messages].reverse().find((m) => m.role === 'user')!;
    expect(JSON.stringify(lastUser.content)).not.toContain(FINAL_ANSWER_PROMPT.slice(0, 30));
  });

  it('une réponse normale ne déclenche pas de synthèse', async () => {
    const mock = { streamMessage: vi.fn(async () => modelResult([{ type: 'text', text: 'Direct.' }], 'stop')) };
    const result = await runAgentLoop(options(mock));
    expect(mock.streamMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ completion: 'completed', finalText: 'Direct.', finalSynthesized: false });
  });

  it('run annulé : pas de tour de synthèse', async () => {
    const controller = new AbortController();
    const mock = { streamMessage: vi.fn(async () => { controller.abort(); return toolTurn('a'); }) };
    const result = await runAgentLoop(options(mock, { signal: controller.signal }));
    expect(mock.streamMessage).toHaveBeenCalledTimes(1);
    expect(result.completion).toBe('cancelled');
  });

  it('tool_choice=none est émis seulement quand des outils sont déclarés', () => {
    const base = { model: 'm', system: '', messages: [], maxTokens: 10, reasoningEffort: 'none' as const, toolChoice: 'none' as const };
    expect(buildChatCompletionsPayload({ ...base, tools: [{ name: 'x', description: '', input_schema: {} }] })['tool_choice']).toBe('none');
    expect(buildChatCompletionsPayload({ ...base, tools: [] })['tool_choice']).toBeUndefined();
  });
});

describe('lot 13 — statut honnête', () => {
  it('sans réponse finale même après synthèse : échec explicite, session conservée', async () => {
    const empty = () => new Response('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn(async () => empty()));
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://fake.invalid', reasoningEffort: 'none' }, context: { paperclipWorkspace: { cwd: root } } });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('omniroute_no_final_response');
    expect((result.resultJson ?? {})['finalResponse']).toBeUndefined();
    expect(result.sessionParams).toBeTruthy();
  });
});

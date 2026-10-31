/**
 * Lot 20 (A) — outil `subtask` : confier une lecture/recherche/synthèse à un
 * modèle rapide à gros quota (ex. combo AC-task), en lecture seule.
 *
 * Chaque test échouait sur main 317b564 (outil absent, réglages ignorés).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import { OmniRouteError, remainingMs, withDeadline } from '../src/shared/client.js';
import { classifyGatewayError } from '../src/shared/errors.js';
import { resolveConfig } from '../src/shared/config.js';
import { configSchema } from '../src/server/config-schema.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Params = { model: string; tools: Array<{ name: string }>; system: string; messages: Array<{ role: string; content: unknown[] }> };
type Mock = ReturnType<typeof vi.fn>;

function modelResult(content: unknown[], stopReason = 'tool_calls', model = 'served', usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: number | null = null) {
  return { content, stopReason, model, usage, gatewayHeaders: {}, costUsd };
}
const text = (t: string, model = 'served', usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, cost: number | null = null) =>
  modelResult([{ type: 'text', text: t }], 'stop', model, usage, cost);
const call = (id: string, name: string, input: unknown) => modelResult([{ type: 'tool_use', id, name, input }]);

function fakeTool(name: string, content = `${name} ok`) {
  return { spec: { name, description: name, input_schema: { type: 'object', properties: { path: { type: 'string' } } } }, run: vi.fn(async () => ({ content, isError: false })) };
}
function options(client: unknown, more: Record<string, unknown> = {}): AgentLoopOptions {
  return {
    client: client as never, model: 'AC-pro-coding', system: 'principal', initialUserMessage: 'mission',
    tools: [], maxTokens: 100, reasoningEffort: 'none', maxTurns: 20,
    emit: async () => {}, warn: async () => {}, ...more,
  } as AgentLoopOptions;
}
const SUB = { model: 'AC-task', maxTurns: 6, timeoutSec: 300 };
const names = (p: Params) => p.tools.map((t) => t.name).sort();
const paramsOf = (client: { streamMessage: Mock }, i: number) => (client.streamMessage.mock.calls[i] as unknown as [Params])[0];

/** Faux client : file de réponses par modèle demandé. */
function routed(queues: Record<string, Array<unknown | ((p: Params, signal?: AbortSignal) => unknown)>>) {
  return {
    streamMessage: vi.fn(async (params: Params, cb: { onTextDelta?: (t: string) => void } | undefined, signal?: AbortSignal) => {
      const queue = queues[params.model];
      if (!queue || queue.length === 0) throw new Error(`aucune réponse prévue pour ${params.model}`);
      const next = queue.shift()!;
      const result = (typeof next === 'function' ? await (next as (p: Params, s?: AbortSignal) => unknown)(params, signal) : next) as { content: Array<{ type: string; text?: string }> };
      // Comme le vrai client : le texte arrive aussi en flux (pour le transcript).
      for (const block of result.content) if (block.type === 'text' && block.text) cb?.onTextDelta?.(block.text);
      return result;
    }),
  };
}

describe('lot 20 — outil subtask : exposition', () => {
  it('sans réglage subtask, l’outil n’est pas proposé (comportement inchangé)', async () => {
    const mock = routed({ 'AC-pro-coding': [text('fini')] });
    const result = await runAgentLoop(options(mock, { tools: [fakeTool('read_file')] }));
    expect(names(paramsOf(mock, 0))).toEqual(['read_file']);
    expect(result.finalText).toBe('fini');
    expect((result as unknown as { subtasks?: unknown[] }).subtasks ?? []).toEqual([]);
  });

  it('avec subtaskModel, l’outil subtask est proposé au modèle principal et décrit quand l’utiliser', async () => {
    const mock = routed({ 'AC-pro-coding': [text('fini')] });
    await runAgentLoop(options(mock, { tools: [fakeTool('read_file')], subtask: SUB }));
    const spec = paramsOf(mock, 0).tools.find((t) => t.name === 'subtask') as unknown as { description: string; input_schema: { required: string[] } };
    expect(spec).toBeTruthy();
    expect(spec.input_schema.required).toEqual(['task']);
    expect(spec.description).toMatch(/lecture/i);
    expect(spec.description).toMatch(/pas .*(écrire|modifier)/i);
  });
});

describe('lot 20 — outil subtask : exécution', () => {
  it('l’enfant tourne sur subtaskModel, outils en lecture seule seulement, sans subtask imbriqué', async () => {
    const writer = fakeTool('write_file');
    const shell = fakeTool('shell');
    const updater = fakeTool('paperclip_update_issue');
    const tools = [fakeTool('read_file', 'contenu a.ts'), writer, fakeTool('list_dir'), fakeTool('search'), shell,
      fakeTool('grep'), fakeTool('glob'), fakeTool('read_skill'), fakeTool('paperclip_get_issue'), fakeTool('paperclip_list_comments'), updater];
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 'Trouve où est défini X', context: 'dépôt TS' }), text('Décision prise.')],
      'AC-task': [
        call('c1', 'read_file', { path: 'a.ts' }),
        call('c2', 'write_file', { path: 'a.ts' }),
        text('X est défini dans a.ts:12 (preuve : `export const X`).', 'MiniMax-M3.1-Flash'),
      ],
    });
    const result = await runAgentLoop(options(mock, { tools, subtask: SUB }));
    const child = paramsOf(mock, 1);
    expect(child.model).toBe('AC-task');
    expect(names(child)).toEqual(['glob', 'grep', 'list_dir', 'paperclip_get_issue', 'paperclip_list_comments', 'read_file', 'read_skill', 'search']);
    expect(child.system).not.toBe('principal');
    expect(JSON.stringify(child.messages)).toContain('Trouve où est défini X');
    expect(JSON.stringify(child.messages)).toContain('dépôt TS');
    // L'appel d'écriture inventé par l'enfant n'est jamais exécuté.
    expect(writer.run).not.toHaveBeenCalled();
    expect(shell.run).not.toHaveBeenCalled();
    expect(updater.run).not.toHaveBeenCalled();
    const toolResult = result.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.tool_use_id === 'p1') as { content: string; is_error?: boolean };
    expect(toolResult.is_error).toBeFalsy();
    expect(toolResult.content).toContain('a.ts:12');
    expect(result.finalText).toBe('Décision prise.');
  });

  it('usage, coût et modèle servi de la sous-tâche sont ajoutés au run et détaillés', async () => {
    const usage = { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, cacheWriteTokens: 3 };
    const mock = routed({
      'AC-pro-coding': [
        modelResult([{ type: 'tool_use', id: 'p1', name: 'subtask', input: { task: 'résume' } }], 'tool_calls', 'opus', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.5),
        text('ok', 'opus', { inputTokens: 20, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 }, 0.25),
      ],
      'AC-task': [text('résumé', 'MiniMax-M3.1-Flash', usage, 0.01)],
    });
    const result = await runAgentLoop(options(mock, { subtask: SUB }));
    expect(result).toMatchObject({ inputTokens: 130, outputTokens: 10, cacheReadTokens: 45, cacheWriteTokens: 3, servedModel: 'opus' });
    expect(result.costUsd).toBeCloseTo(0.76, 10);
    const subtasks = (result as unknown as { subtasks: Array<Record<string, unknown>> }).subtasks;
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]).toMatchObject({ model: 'AC-task', servedModel: 'MiniMax-M3.1-Flash', turns: 1, inputTokens: 100, cacheReadTokens: 40, outputTokens: 7, ok: true });
    expect(typeof subtasks[0]!.durationMs).toBe('number');
  });

  it('borne en tours : l’enfant qui ne conclut pas rend une erreur d’outil, le run continue', async () => {
    const reader = fakeTool('read_file');
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 'lis tout' }), text('Je conclus moi-même.')],
      'AC-task': [call('c1', 'read_file', {}), call('c2', 'read_file', {}), call('c3', 'read_file', {})],
    });
    const result = await runAgentLoop(options(mock, { tools: [reader], subtask: { ...SUB, maxTurns: 2 } }));
    expect(reader.run).toHaveBeenCalledTimes(2);
    const toolResult = result.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.tool_use_id === 'p1') as { content: string; is_error?: boolean };
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/sous-tâche/i);
    expect(result.finalText).toBe('Je conclus moi-même.');
    expect((result as unknown as { subtasks: Array<{ ok: boolean; turns: number }> }).subtasks[0]).toMatchObject({ ok: false, turns: 3 });
  });

  it('borne en temps : subtaskTimeoutSec interrompt l’enfant, pas le run', async () => {
    let childSignal: AbortSignal | undefined;
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 'lent' }), text('fini sans elle')],
      'AC-task': [(_p: Params, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        childSignal = signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })],
    });
    const started = Date.now();
    const result = await runAgentLoop(options(mock, { subtask: { ...SUB, timeoutSec: 0.05 } }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(childSignal?.aborted).toBe(true);
    const toolResult = result.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.tool_use_id === 'p1') as { content: string; is_error?: boolean };
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/délai/i);
    expect(result).toMatchObject({ completion: 'completed', finalText: 'fini sans elle' });
  });

  it('le délai de l’enfant ne dépasse jamais le délai restant du run', async () => {
    let childRemaining: number | null = null;
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 't' }), text('fin')],
      'AC-task': [(_p: Params, signal?: AbortSignal) => { childRemaining = signal ? remainingMs(signal) : null; return text('r'); }],
    });
    await runAgentLoop(options(mock, { subtask: { ...SUB, timeoutSec: 300 }, signal: withDeadline(5_000) }));
    expect(childRemaining).not.toBeNull();
    expect(childRemaining!).toBeLessThanOrEqual(5_000);
  });

  it('annulation du run propagée à l’enfant', async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 't' })],
      'AC-task': [(_p: Params, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        childSignal = signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(() => controller.abort(), 10);
      })],
    });
    const result = await runAgentLoop(options(mock, { subtask: SUB, signal: controller.signal }));
    expect(childSignal?.aborted).toBe(true);
    expect(result.completion).toBe('cancelled');
  });

  it('échec de l’enfant (erreur passerelle) = erreur d’outil claire, pas d’exception', async () => {
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 't' }), text('je continue')],
      'AC-task': [() => { throw new OmniRouteError('Service Unavailable', classifyGatewayError({ status: 503, message: 'Service Unavailable' }), 503); }],
    });
    const result = await runAgentLoop(options(mock, { subtask: SUB }));
    const toolResult = result.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.tool_use_id === 'p1') as { content: string; is_error?: boolean };
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/Service Unavailable/);
    expect(result.finalText).toBe('je continue');
    expect((result as unknown as { subtasks: Array<{ ok: boolean }> }).subtasks[0]!.ok).toBe(false);
  });

  it('compte rendu trop long : tronqué proprement et signalé', async () => {
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 't' }), text('fin')],
      'AC-task': [text('x'.repeat(50_000))],
    });
    const result = await runAgentLoop(options(mock, { subtask: SUB }));
    const toolResult = result.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.tool_use_id === 'p1') as { content: string };
    expect(toolResult.content.length).toBeLessThan(20_000);
    expect(toolResult.content).toMatch(/tronqué/i);
  });

  it('plusieurs subtask dans un même tour : exécutées en parallèle, résultats dans l’ordre', async () => {
    let active = 0;
    let peak = 0;
    const slow = (label: string) => async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return text(label);
    };
    const mock = routed({
      'AC-pro-coding': [
        modelResult([
          { type: 'tool_use', id: 'p1', name: 'subtask', input: { task: 'A' } },
          { type: 'tool_use', id: 'p2', name: 'subtask', input: { task: 'B' } },
        ]),
        text('fin'),
      ],
      'AC-task': [slow('rapport A'), slow('rapport B')],
    });
    const result = await runAgentLoop(options(mock, { subtask: SUB }));
    expect(peak).toBe(2);
    const results = result.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ tool_use_id: string; content: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(['p1', 'p2']);
    expect((result as unknown as { subtasks: unknown[] }).subtasks).toHaveLength(2);
  });

  it('transcript : les étapes de l’enfant sont visibles avec un préfixe', async () => {
    const entries: Array<Record<string, unknown>> = [];
    const mock = routed({
      'AC-pro-coding': [call('p1', 'subtask', { task: 't' }), text('fin')],
      'AC-task': [call('c1', 'read_file', {}), text('rapport')],
    });
    await runAgentLoop(options(mock, { tools: [fakeTool('read_file')], subtask: SUB, emit: async (e: Record<string, unknown>) => { entries.push(e); } }));
    const childCall = entries.find((e) => e.kind === 'tool_call' && String(e.name).includes('read_file'))!;
    expect(String(childCall.name)).toMatch(/sous-tâche/i);
    expect(String(childCall.toolUseId)).not.toBe('c1');
    const childText = entries.find((e) => e.kind === 'assistant' && String(e.text).includes('rapport'))!;
    expect(String(childText.text)).toMatch(/sous-tâche/i);
    const childResult = entries.find((e) => e.kind === 'tool_result' && String(e.toolUseId).endsWith('c1'))!;
    expect(String(childResult.toolUseId)).toBe(String(childCall.toolUseId));
    // Les étapes du modèle principal ne sont pas préfixées.
    expect(entries.find((e) => e.kind === 'assistant' && e.text === 'fin')).toBeTruthy();
  });
});

describe('lot 20 — réglages', () => {
  it('désactivé par défaut', () => {
    const config = resolveConfig({});
    expect(config).toMatchObject({ subtaskModel: null, escalationModels: [], maxEscalations: 2 }); // lot 21a : 2 par défaut (deux menus)
  });
  it('parsing des réglages, valeurs invalides ignorées', () => {
    const config = resolveConfig({ subtaskModel: ' AC-task ', subtaskMaxTurns: '5', subtaskTimeoutSec: 120, escalationModels: 'AC-code, AC-pro-coding,,AC-code', maxEscalations: '2' });
    expect(config).toMatchObject({ subtaskModel: 'AC-task', subtaskMaxTurns: 5, subtaskTimeoutSec: 120, escalationModels: ['AC-code', 'AC-pro-coding'], maxEscalations: 2 });
    const invalid = resolveConfig({ subtaskModel: 42, subtaskMaxTurns: 'abc', subtaskTimeoutSec: -3, escalationModels: [1, ' ', 'AC-code'], maxEscalations: 'x' });
    expect(invalid).toMatchObject({ subtaskModel: null, escalationModels: ['AC-code'], maxEscalations: 2 }); // lot 21a
    expect(invalid.subtaskMaxTurns).toBeGreaterThan(0);
    expect(invalid.subtaskTimeoutSec).toBeGreaterThan(0);
  });
  it('les champs sont déclarés dans le formulaire', () => {
    const keys = configSchema.fields.map((f) => f.key);
    for (const key of ['subtaskModel', 'subtaskMaxTurns', 'subtaskTimeoutSec', 'escalationModel', 'escalationModel2', 'maxEscalations']) expect(keys).toContain(key); // lot 21a : menus au lieu du champ texte
  });
});

describe('lot 20 — execute : détail des sous-tâches dans resultJson', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-lot20-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('resultJson.subtasks rempli quand subtaskModel est réglé', async () => {
    const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    let mainCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { model: string };
      if (body.model === 'AC-task') return sse([{ model: 'MiniMax-M3.1-Flash', choices: [{ delta: { content: 'rapport' }, finish_reason: 'stop' }] }]);
      mainCalls += 1;
      return mainCalls === 1
        ? sse([{ model: 'opus', choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'subtask', arguments: '{"task":"lis"}' } }] }, finish_reason: 'tool_calls' }] }])
        : sse([{ model: 'opus', choices: [{ delta: { content: 'Terminé.' }, finish_reason: 'stop' }] }]);
    }));
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://fake.invalid', reasoningEffort: 'none', subtaskModel: 'AC-task' }, context: { paperclipWorkspace: { cwd: root } } });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    expect((result.resultJson as { subtasks?: unknown[] }).subtasks).toEqual([
      expect.objectContaining({ model: 'AC-task', servedModel: 'MiniMax-M3.1-Flash', ok: true }),
    ]);
  });
});

/**
 * Lot 20 (B) — escalade : reprendre la tâche sur un modèle supérieur quand
 * elle échoue RÉELLEMENT (pas de réponse finale, boucle bloquée, erreur modèle
 * non récupérable). À ne pas confondre avec `fallbackModel` (disponibilité).
 *
 * Chaque test échouait sur main 317b564.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import { OmniRouteError, withDeadline } from '../src/shared/client.js';
import { classifyGatewayError } from '../src/shared/errors.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Params = { model: string; tools: Array<{ name: string }>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; toolChoice?: string };
type Escalation = { from: string; to: string; reason: string; turnsBefore: number };

const usage1 = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 };
function modelResult(content: unknown[], stopReason = 'tool_calls', model = 'served') {
  return { content, stopReason, model, usage: usage1, gatewayHeaders: {}, costUsd: 0.1 };
}
const text = (t: string, model = 'served') => modelResult([{ type: 'text', text: t }], 'stop', model);
const call = (id: string, name = 'noop', input: unknown = {}) => modelResult([{ type: 'tool_use', id, name, input }]);
const noop = () => ({ spec: { name: 'noop', description: '', input_schema: { type: 'object', properties: {} } }, run: vi.fn(async () => ({ content: 'ok', isError: false })) });
const broken = () => ({ spec: { name: 'broken', description: '', input_schema: { type: 'object', properties: {} } }, run: vi.fn(async () => ({ content: 'Erreur : fichier introuvable', isError: true })) });

function options(client: unknown, more: Record<string, unknown> = {}): AgentLoopOptions {
  return {
    client: client as never, model: 'AC-task', system: '', initialUserMessage: 'mission',
    tools: [noop()], maxTokens: 100, reasoningEffort: 'none', maxTurns: 20,
    emit: async () => {}, warn: async () => {}, ...more,
  } as AgentLoopOptions;
}
/** Faux client : une fonction de réponse par modèle demandé. */
function routed(byModel: Record<string, (p: Params, n: number) => unknown>) {
  const counts: Record<string, number> = {};
  return {
    streamMessage: vi.fn(async (params: Params) => {
      const fn = byModel[params.model];
      if (!fn) throw new Error(`modèle inattendu ${params.model}`);
      counts[params.model] = (counts[params.model] ?? 0) + 1;
      return fn(params, counts[params.model]!);
    }),
  };
}
const models = (client: { streamMessage: ReturnType<typeof vi.fn> }) =>
  client.streamMessage.mock.calls.map((c) => (c as unknown as [Params])[0].model);
const escalationsOf = (r: unknown) => ((r as { escalations?: Escalation[] }).escalations ?? []);
/** Toujours un appel d'outil, même au tour de synthèse : jamais de finale. */
const neverFinal = (_p: Params, n: number) => call(`t${n}`);

describe('lot 20 — escalade : déclencheurs', () => {
  it('pas de réponse finale (tours épuisés + synthèse vaine) : reprise sur le modèle suivant avec l’historique', async () => {
    const mock = routed({ 'AC-task': neverFinal, 'AC-code': () => text('Terminé sur AC-code.', 'gpt-6.1-sol') });
    const result = await runAgentLoop(options(mock, { maxTurns: 2, escalationModels: ['AC-code', 'AC-pro-coding'], maxEscalations: 1 }));
    expect(models(mock)).toEqual(['AC-task', 'AC-task', 'AC-task', 'AC-code']);
    expect(result).toMatchObject({ completion: 'completed', finalText: 'Terminé sur AC-code.', servedModel: 'gpt-6.1-sol' });
    expect(escalationsOf(result)).toEqual([{ from: 'AC-task', to: 'AC-code', reason: 'no_final_response', turnsBefore: 3 }]);
    // Historique conservé : l'appel sur AC-code voit les tours précédents et le motif.
    const escalated = (mock.streamMessage.mock.calls[3] as unknown as [Params])[0];
    const sent = JSON.stringify(escalated.messages);
    expect(sent).toContain('mission');
    expect(sent).toContain('"t1"');
    expect(sent).toContain('"t2"');
    expect(sent).toMatch(/AC-task.*a échoué/);
    expect(escalated.tools.map((t) => t.name)).toContain('noop');
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant' });
  });

  it('3 erreurs d’outil identiques de suite : boucle bloquée, escalade', async () => {
    const tool = broken();
    const mock = routed({ 'AC-task': (_p, n) => call(`b${n}`, 'broken'), 'AC-code': () => text('Débloqué.') });
    const result = await runAgentLoop(options(mock, { tools: [tool], escalationModels: ['AC-code'] }));
    expect(tool.run).toHaveBeenCalledTimes(3);
    expect(escalationsOf(result)).toEqual([{ from: 'AC-task', to: 'AC-code', reason: 'stuck_tool_errors', turnsBefore: 3 }]);
    expect(result.finalText).toBe('Débloqué.');
  });

  it('erreurs d’outil différentes ou entrecoupées d’un succès : pas de blocage détecté', async () => {
    let i = 0;
    const flaky = { spec: { name: 'broken', description: '', input_schema: { type: 'object', properties: {} } }, run: vi.fn(async () => ({ content: `Erreur ${i++}`, isError: true })) };
    const mock = routed({ 'AC-task': (_p, n) => (n <= 4 ? call(`b${n}`, 'broken') : text('fini seul')), 'AC-code': () => text('non') });
    const result = await runAgentLoop(options(mock, { tools: [flaky], escalationModels: ['AC-code'] }));
    expect(escalationsOf(result)).toEqual([]);
    expect(result.finalText).toBe('fini seul');
  });

  it('sans escalade réglée, 3 erreurs identiques n’arrêtent pas la boucle (comportement inchangé)', async () => {
    const tool = broken();
    const mock = routed({ 'AC-task': (_p, n) => (n <= 4 ? call(`b${n}`, 'broken') : text('fini seul')) });
    const result = await runAgentLoop(options(mock, { tools: [tool] }));
    expect(tool.run).toHaveBeenCalledTimes(4);
    expect(result.finalText).toBe('fini seul');
  });

  it('erreur modèle non récupérable (refus) : escalade au lieu de faire tomber le run', async () => {
    const refusal = () => { throw new OmniRouteError('The model refused to answer: content policy', classifyGatewayError({ status: 400, message: 'The model refused to answer: content policy' }), 400); };
    const mock = routed({ 'AC-task': (_p, n) => (n === 1 ? call('a') : refusal()), 'AC-code': () => text('Repris.') });
    const result = await runAgentLoop(options(mock, { escalationModels: ['AC-code'] }));
    expect(escalationsOf(result)).toEqual([{ from: 'AC-task', to: 'AC-code', reason: 'model_error:omniroute_model_refusal', turnsBefore: 2 }]);
    expect(result.finalText).toBe('Repris.');
    // Le tour réussi avant l'erreur est conservé dans l'historique.
    const sent = JSON.stringify((mock.streamMessage.mock.calls.at(-1) as unknown as [Params])[0].messages);
    expect(sent).toContain('"a"');
  });

  it('dépassement de contexte et quota sur tous les modèles (après repli) : escalade', async () => {
    const quota = () => { throw new OmniRouteError('quota exceeded', classifyGatewayError({ status: 429, message: 'quota exceeded' }), 429); };
    const mock = routed({ 'AC-task': quota, 'AC-fallback': quota, 'AC-code': () => text('ok') });
    const result = await runAgentLoop(options(mock, { fallbackModel: 'AC-fallback', escalationModels: ['AC-code'] }));
    expect(models(mock)).toEqual(['AC-task', 'AC-fallback', 'AC-code']);
    expect(escalationsOf(result)[0]).toMatchObject({ from: 'AC-fallback', to: 'AC-code', reason: 'model_error:omniroute_provider_quota' });
  });

  it('sans escalade réglée, l’erreur non récupérable remonte comme avant', async () => {
    const mock = routed({ 'AC-task': () => { throw new OmniRouteError('prompt is too long', classifyGatewayError({ status: 400, message: 'prompt is too long' }), 400); } });
    await expect(runAgentLoop(options(mock))).rejects.toThrow(/too long/);
  });

  it('identifiants refusés : pas d’escalade (un autre modèle ne répare pas une clé)', async () => {
    const mock = routed({ 'AC-task': () => { throw new OmniRouteError('Unauthorized', classifyGatewayError({ status: 401, message: 'Unauthorized' }), 401); }, 'AC-code': () => text('non') });
    await expect(runAgentLoop(options(mock, { escalationModels: ['AC-code'] }))).rejects.toThrow(/Unauthorized/);
    expect(models(mock)).toEqual(['AC-task']);
  });
});

describe('lot 20 — escalade : garde-fous', () => {
  it('pas d’escalade si le run est annulé', async () => {
    const controller = new AbortController();
    const tool = { ...noop(), run: vi.fn(async () => { controller.abort(); return { content: 'ok', isError: false }; }) };
    const mock = routed({ 'AC-task': neverFinal, 'AC-code': () => text('non') });
    const result = await runAgentLoop(options(mock, { tools: [tool], signal: controller.signal, escalationModels: ['AC-code'] }));
    expect(result.completion).toBe('cancelled');
    expect(escalationsOf(result)).toEqual([]);
    expect(models(mock)).not.toContain('AC-code');
  });

  it('pas d’escalade si le délai restant du run est trop court', async () => {
    const mock = routed({ 'AC-task': neverFinal, 'AC-code': () => text('non') });
    const result = await runAgentLoop(options(mock, { maxTurns: 1, signal: withDeadline(20_000), escalationModels: ['AC-code'] }));
    expect(escalationsOf(result)).toEqual([]);
    expect(result.completion).toBe('max_turns');
  });

  it('maxEscalations respecté (plafond 1 explicite ; 2 par défaut depuis le lot 21a)', async () => {
    const mock = routed({ 'AC-task': neverFinal, 'AC-code': neverFinal, 'AC-pro-coding': () => text('non') });
    const result = await runAgentLoop(options(mock, { maxTurns: 1, escalationModels: ['AC-code', 'AC-pro-coding'], maxEscalations: 1 }));
    expect(escalationsOf(result).map((e) => e.to)).toEqual(['AC-code']);
    expect(models(mock)).not.toContain('AC-pro-coding');
    expect(result.completion).toBe('max_turns');
  });

  it('maxEscalations=2 : on monte toute l’échelle, usage cumulé sur toutes les tentatives', async () => {
    const mock = routed({ 'AC-task': neverFinal, 'AC-code': neverFinal, 'AC-pro-coding': () => text('Enfin.', 'opus') });
    const result = await runAgentLoop(options(mock, { maxTurns: 1, escalationModels: ['AC-code', 'AC-pro-coding'], maxEscalations: 2 }));
    expect(escalationsOf(result)).toEqual([
      { from: 'AC-task', to: 'AC-code', reason: 'no_final_response', turnsBefore: 2 },
      { from: 'AC-code', to: 'AC-pro-coding', reason: 'no_final_response', turnsBefore: 4 },
    ]);
    // 2 + 2 + 1 tours à 10 tokens d'entrée chacun.
    expect(result).toMatchObject({ turns: 5, inputTokens: 50, outputTokens: 5, cacheReadTokens: 10, finalText: 'Enfin.', servedModel: 'opus' });
    expect(result.costUsd).toBeCloseTo(0.5, 10);
  });

  it('le modèle courant est sauté s’il figure déjà dans l’échelle', async () => {
    const mock = routed({ 'AC-code': neverFinal, 'AC-pro-coding': () => text('ok') });
    const result = await runAgentLoop(options(mock, { model: 'AC-code', maxTurns: 1, escalationModels: ['AC-code', 'AC-pro-coding'] }));
    expect(escalationsOf(result).map((e) => [e.from, e.to])).toEqual([['AC-code', 'AC-pro-coding']]);
  });

  it('motif tracé en avertissement dans le transcript', async () => {
    const entries: Array<Record<string, unknown>> = [];
    const mock = routed({ 'AC-task': neverFinal, 'AC-code': () => text('ok') });
    await runAgentLoop(options(mock, { maxTurns: 1, escalationModels: ['AC-code'], emit: async (e: Record<string, unknown>) => { entries.push(e); } }));
    const notice = entries.find((e) => e.kind === 'system' && /escalade/i.test(String(e.text)));
    expect(notice).toBeTruthy();
    expect(String(notice!.text)).toContain('AC-code');
    expect(String(notice!.text)).toContain('no_final_response');
  });
});

describe('lot 20 — execute : resultJson.escalations', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-lot20e-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('run sauvé par l’escalade : succès, modèle final = modèle escaladé, motif dans resultJson', async () => {
    const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { model: string };
      if (body.model === 'AC-code') return sse([{ model: 'gpt-6.1-sol', choices: [{ delta: { content: 'Livré.' }, finish_reason: 'stop' }] }]);
      n += 1;
      return sse([{ model: 'MiniMax-M3.1-Flash', choices: [{ delta: { tool_calls: [{ index: 0, id: `l${n}`, function: { name: 'list_dir', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }]);
    }));
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://fake.invalid', model: 'AC-task', reasoningEffort: 'none', maxTurns: 1, escalationModels: 'AC-code' }, context: { paperclipWorkspace: { cwd: root } } });
    const result = await execute(ctx as never);
    expect({ exitCode: result.exitCode, model: result.model }).toEqual({ exitCode: 0, model: 'gpt-6.1-sol' });
    const json = result.resultJson as { escalations?: Escalation[]; finalResponse?: { text: string } };
    expect(json.escalations).toEqual([{ from: 'AC-task', to: 'AC-code', reason: 'no_final_response', turnsBefore: 2 }]);
    expect(json.finalResponse?.text).toBe('Livré.');
  });

  it('sans réglage, resultJson ne porte ni escalations ni subtasks (inchangé)', async () => {
    const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ model: 'm', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])));
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://fake.invalid', reasoningEffort: 'none' }, context: { paperclipWorkspace: { cwd: root } } });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.resultJson ?? {})).not.toContain('escalations');
    expect(Object.keys(result.resultJson ?? {})).not.toContain('subtasks');
  });
});

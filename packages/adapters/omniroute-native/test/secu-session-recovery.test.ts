/**
 * Lot solidité — reprise de session et reprise d'un run coupé
 * (ACC-2297, ACC-2289).
 *
 * - Historique refusé par le modèle (400, contexte dépassé) : un nouvel essai
 *   à neuf avec une passation courte, puis nouvelle session signalée à
 *   l'hôte ; `clearSession` si l'essai à neuf échoue aussi.
 * - Session reprise : prompt de reprise compact (A-contrat manque 3).
 * - Rognage : la tâche courante reste dans l'historique.
 * - Point de contrôle à chaque tour d'outils : un run qui plante ne perd ni
 *   l'historique ni l'usage ; `executionRecovery` « interrupted » quand le
 *   run est coupé après le début du travail fournisseur.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FINAL_ANSWER_PROMPT, runAgentLoop } from '../src/server/agent-loop.js';
import { execute } from '../src/server/execute.js';
import { saveSessionMessages, sessionFilePath, trimSessionMessages } from '../src/server/session.js';
import { OmniRouteClient } from '../src/shared/client.js';
import type { WireMessage } from '../src/shared/wire.js';
import { makeTestContext } from './support/test-context.js';
import { startScriptedGateway, type ScriptedGateway } from './support/secu-gateway.js';

let gateway: ScriptedGateway | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await gateway?.close();
  gateway = null;
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

async function workspace(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const PREVIOUS: WireMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'ancienne consigne' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ancienne réponse' }] },
];

async function seedSession(dir: string, sessionId: string, messages: WireMessage[] = PREVIOUS): Promise<void> {
  await saveSessionMessages(path.join(dir, '.omniroute-sessions'), sessionId, messages);
}

function resumedRuntime(sessionId: string) {
  return { sessionId: null, sessionParams: { sessionId, omnirouteNativeSession: true }, sessionDisplayId: sessionId, taskKey: null };
}

const hasHistory = (raw: string) => raw.includes('ancienne consigne');

describe('secu — historique refusé : nouvel essai à neuf', () => {
  it('400 sur l’historique rejoué → essai à neuf réussi et nouvelle session', async () => {
    const dir = await workspace('secu-poison-');
    await seedSession(dir, 'poison-1');
    gateway = await startScriptedGateway((req) =>
      hasHistory(req.raw)
        ? { status: 400, error: { message: "messages.2: tool_call_id 'call_x' has no matching tool call", code: 'invalid_request_error' } }
        : { text: 'repris à neuf' },
    );
    const logs: string[] = [];
    const { ctx } = makeTestContext({
      logs,
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir }, paperclipTaskMarkdown: '# Tâche ACC-1\n\nFaire la recette.' },
      runtime: resumedRuntime('poison-1'),
    });
    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(gateway.requests.length).toBe(2);
    expect(hasHistory(gateway.requests[1]!.raw)).toBe(false);
    // Passation courte dans l'essai à neuf.
    expect(gateway.requests[1]!.raw).toMatch(/session précédente/i);
    const params = result.sessionParams as { sessionId: string };
    expect(params.sessionId).not.toBe('poison-1');
    expect(result.clearSession).not.toBe(true);
    expect(logs.join('')).toMatch(/essai à neuf/);
    // L'historique empoisonné n'est plus rechargé.
    await expect(fs.stat(sessionFilePath(path.join(dir, '.omniroute-sessions'), 'poison-1'))).rejects.toThrow();
  });

  it('contexte dépassé sur l’historique → essai à neuf', async () => {
    const dir = await workspace('secu-ctx-');
    await seedSession(dir, 'ctx-1');
    gateway = await startScriptedGateway((req) =>
      hasHistory(req.raw)
        ? { status: 400, error: { message: 'This model maximum context length is 8192 tokens', code: 'context_length_exceeded' } }
        : { text: 'ok' },
    );
    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
      runtime: resumedRuntime('ctx-1'),
    });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    expect(gateway.requests.length).toBe(2);
  });

  it('si l’essai à neuf échoue aussi → clearSession', async () => {
    const dir = await workspace('secu-clear-');
    await seedSession(dir, 'clear-1');
    gateway = await startScriptedGateway(() => ({ status: 400, error: { message: 'invalid messages' } }));
    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
      runtime: resumedRuntime('clear-1'),
    });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(gateway.requests.length).toBe(2);
    expect(result.clearSession).toBe(true);
  });

  it('sans historique rejoué, un 400 n’entraîne ni nouvel essai ni clearSession', async () => {
    const dir = await workspace('secu-noretry-');
    gateway = await startScriptedGateway(() => ({ status: 400, error: { message: 'invalid messages' } }));
    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
    });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(gateway.requests.length).toBe(1);
    expect(result.clearSession).not.toBe(true);
  });
});

describe('secu — prompt de reprise compact', () => {
  const taskContext = (dir: string) => ({
    paperclipWorkspace: { cwd: dir, agentHome: dir },
    paperclipTaskMarkdown: '# ACC-9\n\nDESCRIPTION-COMPLETE-DU-TICKET',
    paperclipTaskMarkdownCompact: '# ACC-9 (compact)',
    paperclipWake: { reason: 'issue_commented', issue: { id: 'i-9', identifier: 'ACC-9', title: 'Recette' }, comments: [{ id: 'c1', body: 'nouveau commentaire', authorType: 'user' }] },
  });

  it('session reprise → variante compacte, sans la description complète', async () => {
    const dir = await workspace('secu-delta-');
    await seedSession(dir, 'delta-1');
    gateway = await startScriptedGateway(() => ({ text: 'ok' }));
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, context: taskContext(dir), runtime: resumedRuntime('delta-1') });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    const raw = gateway.requests[0]!.raw;
    expect(raw).toContain('ACC-9 (compact)');
    expect(raw).not.toContain('DESCRIPTION-COMPLETE-DU-TICKET');
    // Le gabarit heartbeat complet n'est pas renvoyé sur un delta de reprise.
    expect(raw).not.toContain('Continue your Paperclip work.');
    expect((result.resultJson as Record<string, unknown>)['resumedSession']).toBe(true);
  });

  it('session neuve → brief complet', async () => {
    const dir = await workspace('secu-full-');
    gateway = await startScriptedGateway(() => ({ text: 'ok' }));
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, context: taskContext(dir) });
    await execute(ctx as never);
    expect(gateway.requests[0]!.raw).toContain('DESCRIPTION-COMPLETE-DU-TICKET');
    expect(gateway.requests[0]!.raw).toContain('Continue your Paperclip work.');
  });
});

describe('secu — rognage qui garde la tâche courante', () => {
  it('le tour de synthèse ne fait pas perdre la tâche du run', () => {
    const big = 'x'.repeat(5_000);
    const messages: WireMessage[] = [
      ...PREVIOUS,
      { role: 'user', content: [{ type: 'text', text: 'TÂCHE COURANTE' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
      { role: 'user', content: [{ type: 'text', text: FINAL_ANSWER_PROMPT }] },
      { role: 'assistant', content: [{ type: 'text', text: 'synthèse' }] },
    ];
    const kept = trimSessionMessages(messages, 1_000);
    const text = JSON.stringify(kept);
    expect(text).toContain('TÂCHE COURANTE');
    expect(text).toContain('synthèse');
    expect(kept[0]!.role).toBe('user');
  });
});

describe('secu — point de contrôle à chaque tour d’outils', () => {
  it('runAgentLoop appelle onCheckpoint après chaque tour d’outils', async () => {
    const dir = await workspace('secu-loop-');
    let call = 0;
    gateway = await startScriptedGateway(() => {
      call += 1;
      return call <= 2 ? { toolCalls: [{ id: `c${call}`, name: 'noop', input: {} }] } : { text: 'fin' };
    });
    void dir;
    const client = new OmniRouteClient({ baseUrl: gateway.baseUrl, apiKey: 'cle-fictive', requestTimeoutMs: 5_000 });
    const snapshots: Array<{ messages: WireMessage[]; inputTokens: number }> = [];
    await runAgentLoop({
      client,
      model: 'auto/best-coding',
      system: 's',
      initialUserMessage: 'tâche',
      tools: [{ spec: { name: 'noop', description: 'rien', input_schema: { type: 'object', properties: {} } }, run: async () => ({ content: 'ok', isError: false }) }],
      maxTokens: 100,
      reasoningEffort: 'none',
      maxTurns: 10,
      emit: async () => {},
      warn: async () => {},
      onCheckpoint: async (snapshot: { messages: WireMessage[]; inputTokens: number }) => {
        snapshots.push({ messages: snapshot.messages, inputTokens: snapshot.inputTokens });
      },
    } as never);
    expect(snapshots.length).toBe(2);
    expect(snapshots[0]!.messages.length).toBe(3);
    expect(snapshots[1]!.messages.length).toBe(5);
    expect(snapshots[1]!.inputTokens).toBeGreaterThan(snapshots[0]!.inputTokens);
  });

  it('une panne au 3ᵉ appel garde l’historique et l’usage des 2 premiers tours', async () => {
    const dir = await workspace('secu-crash-');
    gateway = await startScriptedGateway((_req, index) =>
      index < 2
        ? { toolCalls: [{ id: `c${index}`, name: 'shell', input: { command: `echo tour${index}` } }], usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.01 } }
        : { status: 503, error: { message: 'service unavailable' } },
    );
    const onUsage = vi.fn(async () => {});
    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
    });
    (ctx as Record<string, unknown>)['onUsage'] = onUsage;
    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(1);
    expect(result.usage?.inputTokens).toBe(2000);
    expect(result.usage?.outputTokens).toBe(100);
    expect(onUsage).toHaveBeenCalledTimes(2);
    const receipts = onUsage.mock.calls.map((args) => (args as unknown[])[0] as { usage: { inputTokens: number }; complete: boolean; attemptId?: string });
    expect(receipts[1]!.usage.inputTokens).toBe(2000);
    expect(receipts.every((r) => r.complete === false)).toBe(true);
    expect(receipts[0]!.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipts[0]!.attemptId).toBe(receipts[1]!.attemptId);

    const params = result.sessionParams as { sessionId: string };
    expect(params?.sessionId).toBeTruthy();
    const stored = await fs.readFile(sessionFilePath(path.join(dir, '.omniroute-sessions'), params.sessionId), 'utf8');
    expect(stored).toContain('tour0');
    expect(stored).toContain('tour1');
  });

  it('run annulé pendant un outil → executionRecovery « interrupted » et session conservée', async () => {
    const dir = await workspace('secu-cancel-');
    const controller = new AbortController();
    gateway = await startScriptedGateway((_req, index) => {
      if (index === 0) {
        setTimeout(() => controller.abort(), 300);
        return { toolCalls: [{ id: 'c0', name: 'shell', input: { command: 'sleep 5; echo trop-tard' } }] };
      }
      return { text: 'jamais' };
    });
    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
      signal: controller.signal,
    });
    const result = await execute(ctx as never);
    expect(result.errorCode).toBe('cancelled');
    expect(result.executionRecovery).toEqual({
      kind: 'interrupted',
      providerStopped: true,
      sessionPreserved: true,
      actionOutcomes: 'settled',
    });
    const params = result.sessionParams as { sessionId: string };
    expect(params?.sessionId).toBeTruthy();
    const stored = await fs.readFile(sessionFilePath(path.join(dir, '.omniroute-sessions'), params.sessionId), 'utf8');
    expect(stored).toContain('c0');
  }, 15_000);
});

import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import { buildWorkspaceTools, detectsRemotePublication, detectsWorkspaceEscape } from '../src/server/tools.js';
import { loadSessionMessages, sessionFilePath, trimSessionMessages } from '../src/server/session.js';
import { OmniRouteClient } from '../src/shared/client.js';
import { wireMessagesToOpenAi } from '../src/shared/chat-completions.js';
import { buildReadSkillTool } from '../src/server/skills.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';

const scratch = path.join(os.tmpdir(), 'audit-code');
let outer: string;
let root: string;
beforeEach(async () => {
  await fs.mkdir(scratch, { recursive: true });
  outer = await fs.mkdtemp(path.join(scratch, 'fixture-'));
  root = path.join(outer, 'workspace');
  await fs.mkdir(root);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(outer, { recursive: true, force: true });
});
const tool = (name: string, signal?: AbortSignal, extraEnv?: Record<string, string>) =>
  buildWorkspaceTools(root, signal, extraEnv).find(t => t.spec.name === name)!;
function streamResponse(chunks: unknown[], done = true) {
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function modelResult(content: unknown[], stopReason = 'tool_calls') {
  return { content, stopReason, model: 'fake', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, gatewayHeaders: {}, costUsd: null };
}
function options(client: unknown, more: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return { client: client as never, model: 'fake', system: '', initialUserMessage: 'test',
    tools: [], maxTokens: 100, reasoningEffort: 'none', maxTurns: 8,
    emit: async () => {}, warn: async () => {}, ...more };
}
function stubFetch(response: () => Response) { vi.stubGlobal('fetch', vi.fn(async () => response())); }
const requestParams = { model: 'fake', system: '', messages: [], tools: [], maxTokens: 100, reasoningEffort: 'none' as const };
const client = () => new OmniRouteClient({ baseUrl: 'http://fake.invalid', apiKey: 'audit-placeholder', requestTimeoutMs: 500 });

describe('audit — assertions de comportement sûr, rouges sur le code actuel', () => {
  it('A1 masque les secrets injectés et refuse de lire .env par shell', async () => {
    // Valeurs fictives uniquement : aucune variable du processus serveur n’est affichée.
    const sentinel = 'synthetic-audit-credential';
    await fs.writeFile(path.join(root, '.env'), sentinel);
    const envResult = await tool('shell', undefined, { PAPERCLIP_API_KEY: sentinel }).run({ command: 'printenv PAPERCLIP_API_KEY' });
    const fileResult = await tool('shell').run({ command: 'cat .env' });
    expect({ envLeak: envResult.content.includes(sentinel), fileLeak: fileResult.content.includes(sentinel) })
      .toEqual({ envLeak: false, fileLeak: false });
  });

  it('A2 arrête aussi les descendants du shell à l’annulation', async () => {
    const controller = new AbortController();
    const pending = tool('shell', controller.signal).run({ command: '(sleep 0.25; printf survived > child-marker) & wait', timeoutMs: 2000 });
    await new Promise(r => setTimeout(r, 40));
    controller.abort();
    await pending;
    await new Promise(r => setTimeout(r, 350));
    const childRan = await fs.access(path.join(root, 'child-marker')).then(() => true, () => false);
    expect(childRan).toBe(false);
  });

  it('A3 refuse le chemin absolu workspace/../extérieur accepté par la garde shell', async () => {
    await fs.writeFile(path.join(outer, 'outside.txt'), 'synthetic-outside-fixture');
    const command = `cat ${root}/../outside.txt`;
    const outcome = await tool('shell').run({ command });
    expect({ detected: detectsWorkspaceEscape(command, root), readOutside: outcome.content.includes('synthetic-outside-fixture') })
      .toEqual({ detected: true, readOutside: false });
  });

  it('A3b détecte git via variable shell (aucun push exécuté)', () => {
    expect(detectsRemotePublication('g=git; $g push origin HEAD')).toBe(true);
  });

  it('A4 conserve les couples tool_call/tool_result au rognage de session', () => {
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'ancien prompt' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'x'.repeat(25) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    const converted = wireMessagesToOpenAi(trimSessionMessages(messages, 27));
    const calls = converted.flatMap(m => (m.tool_calls as any[] | undefined) ?? []).map(c => c.id);
    const orphans = converted.filter(m => m.role === 'tool' && !calls.includes(m.tool_call_id));
    expect(orphans).toHaveLength(0);
  });

  it('A5 ne publie pas une narration ancienne comme finale si les tours sont épuisés', async () => {
    const responses = [
      modelResult([{ type: 'text', text: 'Je vais vérifier.' }, { type: 'tool_use', id: 'a', name: 'noop', input: {} }]),
      modelResult([{ type: 'tool_use', id: 'b', name: 'noop', input: {} }]),
    ];
    const mock = { streamMessage: vi.fn(async () => responses.shift()!) };
    const result = await runAgentLoop(options(mock, { maxTurns: 2, tools: [{ spec: { name: 'noop', description: '', input_schema: {} }, run: async () => ({ content: 'ok', isError: false }) }] }));
    expect({ stopReason: result.stopReason, finalText: result.finalText })
      .toEqual({ stopReason: 'max_turns', finalText: '' });
  });

  it('A6 ne marque pas comme finale une réponse tronquée par finish_reason=length', async () => {
    stubFetch(() => streamResponse([{ choices: [{ delta: { content: 'Réponse coupée au mil' }, finish_reason: 'length' }] }]));
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://fake.invalid', reasoningEffort: 'none' }, context: { paperclipWorkspace: { cwd: root } } });
    const result = await execute(ctx as never);
    expect({ exitCode: result.exitCode, final: (result.resultJson as any)?.finalResponse?.disposition })
      .toEqual({ exitCode: 1, final: undefined });
  });

  it('A7 refuse un EOF SSE sans finish_reason ni DONE au lieu de livrer un outil partiel', async () => {
    stubFetch(() => streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'list_dir', arguments: '{"path":' } }] } }] }], false));
    let rejected = false;
    try { await client().streamMessage(requestParams, {}); } catch { rejected = true; }
    expect(rejected).toBe(true);
  });

  it('A8 rejette les arguments invalides au lieu d’exécuter list_dir avec ses défauts', async () => {
    await fs.writeFile(path.join(root, 'visible.txt'), 'not a secret');
    let count = 0;
    stubFetch(() => ++count === 1
      ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'list_dir', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] }])
      : streamResponse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]));
    const list = tool('list_dir');
    const run = vi.fn(list.run);
    await runAgentLoop(options(client(), { tools: [{ ...list, run }] }));
    expect(run).not.toHaveBeenCalled();
  });

  it('A8b exige content dans write_file pour ne pas vider un fichier existant', async () => {
    await fs.writeFile(path.join(root, 'keep.txt'), 'preserve');
    const outcome = await tool('write_file').run({ path: 'keep.txt' });
    expect({ isError: outcome.isError, content: await fs.readFile(path.join(root, 'keep.txt'), 'utf8') })
      .toEqual({ isError: true, content: 'preserve' });
  });

  it('A9 ignore des blocs de session corrompus plutôt que faire tomber trimSessionMessages', async () => {
    await fs.writeFile(sessionFilePath(outer, 'corrupt'), JSON.stringify({ messages: [{ role: 'assistant', content: [null] }] }));
    const loaded = await loadSessionMessages(outer, 'corrupt');
    expect(() => trimSessionMessages(loaded)).not.toThrow();
  });

  it('A11 fournit un résultat pour chacun des appels après annulation d’un lot', async () => {
    const controller = new AbortController();
    const mock = { streamMessage: vi.fn(async () => modelResult(['a', 'b', 'c', 'd'].map(id => ({ type: 'tool_use', id, name: 'noop', input: {} })))) };
    const result = await runAgentLoop(options(mock, { signal: controller.signal, tools: [{
      spec: { name: 'noop', description: '', input_schema: {} },
      run: async () => { controller.abort(); return { content: 'ok', isError: false }; },
    }] }));
    const results = result.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
    expect(results.map(b => b.type === 'tool_result' ? b.tool_use_id : '')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('A12 la regex de search ne monopolise pas la boucle événementielle', async () => {
    await fs.writeFile(path.join(root, 'line.txt'), 'a'.repeat(24) + '!');
    const modulePath = fileURLToPath(new URL('../dist/server/tools.js', import.meta.url));
    const script = `import {buildWorkspaceTools} from ${JSON.stringify('file://' + modulePath)};
      const root = ${JSON.stringify(root)};
      const start = performance.now();
      setTimeout(() => console.log(JSON.stringify({timerDelayMs: performance.now() - start})), 20);
      await buildWorkspaceTools(root, undefined).find(t => t.spec.name === 'search').run({pattern: '(a+)+$'});`;
    const timing = await new Promise<{ timerDelayMs: number }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('regex a dépassé 10s')); }, 10_000);
      child.stdout.on('data', c => output += c.toString());
      child.on('error', reject);
      child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(output)); } catch (e) { reject(e); } });
    });
    await fs.writeFile(path.join(scratch, 'regex-evidence.json'), JSON.stringify(timing));
    expect(timing.timerDelayMs).toBeLessThan(150);
  }, 15_000);

  it('A10 borne read_skill et le rejeu dans un même run', async () => {
    const skillDir = path.join(root, 'skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'x'.repeat(100_000));
    const read = buildReadSkillTool([{ key: 'x', runtimeName: 'x', source: skillDir, description: null }]);
    const output = await read.run({ skill: 'x' });
    const requestSizes: number[] = [];
    let turn = 0;
    const mock = { streamMessage: vi.fn(async (p: any) => {
      requestSizes.push(JSON.stringify(p.messages).length);
      return modelResult([{ type: 'tool_use', id: `call_${++turn}`, name: 'read_skill', input: { skill: 'x' } }]);
    }) };
    await runAgentLoop(options(mock, { tools: [read], maxTurns: 8 }));
    await fs.writeFile(path.join(scratch, 'growth-evidence.json'), JSON.stringify({ outputChars: output.content.length, requestSizes, summedMessageChars: requestSizes.reduce((a,b) => a+b, 0) }, null, 2));
    expect({ outputBounded: output.content.length <= 30_100, requestsBounded: requestSizes.every(n => n <= 120_000) })
      .toEqual({ outputBounded: true, requestsBounded: true });
  });
});

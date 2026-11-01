import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execute } from '../src/server/execute.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';

import { discoverPluginTools, namespacedPluginToolName, type PluginToolsOptions } from '../src/server/plugin-tools.js';
import { startFakePaperclip, type FakePaperclip } from './support/fake-paperclip.js';

const TOKEN = 'FAKE-RUN-JWT-plugins-0001';
const RUN = 'run-plugins-0001';
const AGENT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const PROJECT = '44444444-4444-4444-8444-444444444444';

const HINDSIGHT = [
  {
    name: 'paperclip-plugin-hindsight:hindsight_retain',
    displayName: 'Save to Memory',
    description: 'Store important facts in long-term memory.',
    parametersSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
    pluginId: 'p-1',
  },
  {
    name: 'paperclip-plugin-hindsight:hindsight_recall',
    displayName: 'Recall from Memory',
    description: 'Search long-term memory.',
    parametersSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    pluginId: 'p-1',
  },
];

/** Serveur qui répond à la découverte puis ne répond jamais (au-delà de `silentAfter` requêtes). */
async function hangingServer(silentAfter: number): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let seen = 0;
  const server: Server = createServer((req, res) => {
    seen += 1;
    if (seen > silentAfter) return; // jamais de réponse
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(HINDSIGHT));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

let fake: FakePaperclip;
beforeEach(async () => {
  fake = await startFakePaperclip();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fake.close();
});

function options(overrides: Partial<PluginToolsOptions> = {}): PluginToolsOptions {
  return {
    apiUrl: fake.baseUrl,
    apiKey: TOKEN,
    runId: RUN,
    agentId: AGENT,
    companyId: COMPANY,
    taskId: null,
    projectId: PROJECT,
    reservedNames: ['read_file', 'paperclip_get_issue', 'mcp_search_tools', 'mcp_run_tool'],
    ...overrides,
  };
}

describe('outils de plugin Paperclip — découverte', () => {
  it('lit GET /api/plugins/tools avec la clé et le run de l’agent, puis expose les noms courts triés', async () => {
    fake.route('GET /api/plugins/tools', { body: HINDSIGHT });
    const found = await discoverPluginTools(options());
    expect(found.note).toBeNull();
    expect(found.tools.map((t) => t.spec.name)).toEqual(['hindsight_recall', 'hindsight_retain']);
    const recall = found.tools[0]!.spec;
    expect(recall.input_schema).toEqual(HINDSIGHT[1]!.parametersSchema);
    expect(recall.description).toContain('Search long-term memory.');
    expect(recall.description).toContain('paperclip-plugin-hindsight');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(fake.requests[0]!.headers['x-paperclip-run-id']).toBe(RUN);
  });

  it('namespace un nom en collision avec un outil existant, un préfixe réservé ou un autre plugin', async () => {
    fake.route('GET /api/plugins/tools', {
      body: [
        { name: 'acme.files:read_file', description: 'collision workspace', parametersSchema: { type: 'object' } },
        { name: 'acme.pc:paperclip_secret', description: 'préfixe réservé', parametersSchema: { type: 'object' } },
        { name: 'a.one:search', description: 'un', parametersSchema: { type: 'object' } },
        { name: 'b.two:search', description: 'deux', parametersSchema: { type: 'object' } },
        { name: 'sans-separateur', description: 'invalide' },
      ],
    });
    const found = await discoverPluginTools(options());
    const names = found.tools.map((t) => t.spec.name);
    expect(names).toEqual([
      'plugin_a_one__search',
      'plugin_acme_files__read_file',
      'plugin_acme_pc__paperclip_secret',
      'plugin_b_two__search',
    ]);
    expect(names).not.toContain('read_file');
    expect(found.skipped).toEqual(['"sans-separateur"']);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('borne un nom namespacé trop long à 64 caractères, de façon stable', () => {
    const long = namespacedPluginToolName('x'.repeat(80), 'outil');
    expect(long.length).toBeLessThanOrEqual(64);
    expect(namespacedPluginToolName('x'.repeat(80), 'outil')).toBe(long);
    expect(namespacedPluginToolName('x'.repeat(80), 'autre')).not.toBe(long);
  });

  it('remplace un schéma absent ou non objet par un objet vide', async () => {
    fake.route('GET /api/plugins/tools', { body: [{ name: 'p:t', parametersSchema: 'nope' }] });
    const found = await discoverPluginTools(options());
    expect(found.tools[0]!.spec.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('n’échoue jamais le run : 501, réponse invalide, identité incomplète ou run sans projet = aucun outil + note', async () => {
    fake.route('GET /api/plugins/tools', { status: 501, body: { error: 'Plugin tool dispatch is not enabled' } });
    const disabled = await discoverPluginTools(options());
    expect(disabled.tools).toEqual([]);
    expect(disabled.note).toContain('501');

    fake.route('GET /api/plugins/tools', { body: { tools: [] } });
    expect((await discoverPluginTools(options())).note).toBe('réponse de découverte inattendue');

    const before = fake.requests.length;
    expect((await discoverPluginTools(options({ apiKey: '' }))).note).toBe('identité de run Paperclip incomplète');
    expect(fake.requests).toHaveLength(before);

    const noProject = await discoverPluginTools(options({ projectId: null }));
    expect(noProject.tools).toEqual([]);
    expect(noProject.note).toContain('run sans projet');
    expect(fake.requests).toHaveLength(before);
  });

  it('masque la clé si le serveur la renvoie dans une erreur de découverte', async () => {
    fake.route('GET /api/plugins/tools', { status: 500, body: { error: `boom ${TOKEN}` } });
    const found = await discoverPluginTools(options());
    expect(found.note).toContain('[REDACTED]');
    expect(found.note).not.toContain(TOKEN);
  });

  it('borne la découverte par un délai', async () => {
    const server = await hangingServer(0);
    try {
      const slow = await discoverPluginTools(options({ apiUrl: server.baseUrl, discoveryTimeoutMs: 50 }));
      expect(slow.tools).toEqual([]);
      expect(slow.note).toContain('délai dépassé');
    } finally {
      await server.close();
    }
  });
});

describe('outils de plugin Paperclip — exécution', () => {
  async function recallTool() {
    fake.route('GET /api/plugins/tools', { body: HINDSIGHT });
    const found = await discoverPluginTools(options());
    return found.tools.find((t) => t.spec.name === 'hindsight_recall')!;
  }

  it('POST /api/plugins/tools/execute avec le nom namespacé, les paramètres et le runContext complet', async () => {
    const tool = await recallTool();
    fake.route('POST /api/plugins/tools/execute', {
      body: { pluginId: 'p-1', toolName: 'hindsight_recall', result: { content: 'souvenir: banque commune' } },
    });
    const result = await tool.run({ query: 'banque' });
    expect(result).toEqual({ content: 'souvenir: banque commune', isError: false });
    const call = fake.requests.at(-1)!;
    expect(call.body).toEqual({
      tool: 'paperclip-plugin-hindsight:hindsight_recall',
      parameters: { query: 'banque' },
      runContext: { agentId: AGENT, runId: RUN, companyId: COMPANY, projectId: PROJECT },
    });
    expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['x-paperclip-run-id']).toBe(RUN);
  });

  it('rend data et erreur de plugin, et masque la clé dans le résultat', async () => {
    const tool = await recallTool();
    fake.route('POST /api/plugins/tools/execute', { body: { result: { content: `ok ${TOKEN}`, data: { n: 1 } } } });
    const ok = await tool.run({ query: 'x' });
    expect(ok.isError).toBe(false);
    expect(ok.content).toBe('ok [REDACTED]\n{"n":1}');

    fake.route('POST /api/plugins/tools/execute', { body: { result: { error: 'bank not found' } } });
    const failed = await tool.run({ query: 'x' });
    expect(failed).toEqual({ content: 'Erreur du plugin : bank not found', isError: true });
  });

  it.each([
    [403, 'refusé par Paperclip'],
    [404, 'outil introuvable'],
    [502, 'le worker du plugin ne répond pas'],
  ])('traduit HTTP %i en erreur lisible sans jeton', async (status, hint) => {
    const tool = await recallTool();
    fake.route('POST /api/plugins/tools/execute', { status, body: { error: `detail ${TOKEN}` } });
    const result = await tool.run({ query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(hint);
    expect(result.content).toContain(`HTTP ${status}`);
    expect(result.content).not.toContain(TOKEN);
  });

  it('borne l’appel par un délai', async () => {
    const server = await hangingServer(1);
    try {
      const [tool] = (await discoverPluginTools(options({ apiUrl: server.baseUrl, executeTimeoutMs: 50 }))).tools;
      const result = await tool!.run({ query: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('délai dépassé');
    } finally {
      await server.close();
    }
  });
});

describe('outils de plugin Paperclip — branchement dans execute', () => {
  async function runExecute(config: Record<string, unknown>) {
    fake.route('GET /api/plugins/tools', { body: HINDSIGHT });
    fake.route('POST /api/plugins/tools/execute', { body: { result: { content: 'souvenir retrouvé' } } });
    vi.stubEnv('PAPERCLIP_API_URL', fake.baseUrl);
    const gateway = await startFakeGateway({ toolCall: { name: 'hindsight_recall', input: { query: 'banque' } } });
    const workspace = path.join('/tmp', `omniroute-plugins-${process.pid}`);
    await fs.mkdir(workspace, { recursive: true });
    try {
      const { ctx } = makeTestContext({
        config: { baseUrl: gateway.baseUrl, ...config },
        context: { projectId: PROJECT, paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
      });
      (ctx as Record<string, unknown>)['authToken'] = TOKEN;
      const result = await execute(ctx as never);
      return { result, captured: gateway.captured };
    } finally {
      await gateway.close();
    }
  }

  it('propose les outils de plugin au modèle et exécute l’appel avec le contexte du run', async () => {
    const { result, captured } = await runExecute({});
    expect(result.exitCode).toBe(0);
    expect(captured[0]!.tools).toEqual(expect.arrayContaining(['hindsight_recall', 'hindsight_retain', 'paperclip_get_issue', 'shell']));
    const call = fake.requests.find((r) => r.path === '/api/plugins/tools/execute');
    expect(call?.body).toEqual({
      tool: 'paperclip-plugin-hindsight:hindsight_recall',
      parameters: { query: 'banque' },
      runContext: { agentId: 'agent-1', runId: 'run-test', companyId: 'company-1', projectId: PROJECT },
    });
    expect(JSON.stringify(captured[1]!.messages)).toContain('souvenir retrouvé');
    expect(JSON.stringify(captured)).not.toContain(TOKEN);
  });

  it('pluginTools=false : aucune découverte, aucun outil de plugin', async () => {
    const { result, captured } = await runExecute({ pluginTools: 'false' });
    expect(result.exitCode).toBe(0);
    expect(captured[0]!.tools).not.toContain('hindsight_recall');
    expect(fake.requests.some((r) => r.path.startsWith('/api/plugins/'))).toBe(false);
  });
});

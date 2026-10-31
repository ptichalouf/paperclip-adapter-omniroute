/**
 * R1 + R2 — routage MCP sur la topologie de production : UN SEUL serveur
 * `paperclip-assigned` qui expose à la fois les enveloppes virtuelles
 * (`search_tools` / `run_tool`) et des outils directs.
 *
 * Contrat upstream relu sur la source réelle de Paperclip
 * (`server/src/routes/tool-gateway.ts` et `server/src/services/tool-gateway.ts`) :
 *
 * - `tools/list` renvoie les enveloppes virtuelles, les outils de connexion
 *   NON « on-demand », et les quatre outils de contexte `paperclip_*`.
 * - `run_tool` n'accepte QUE les outils « on-demand remote »
 *   (`isOnDemandRemoteTool`) ; toute autre cible reçoit
 *   `404 tool_not_found` (`tool-gateway.ts:10482-10491`).
 * - Les outils « on-demand » ne sont PAS listés par `tools/list` : ils sont
 *   exposés uniquement via `search_tools`.
 *
 * Conséquences attendues de l'adaptateur :
 * - les outils directs du serveur virtuel sont trouvables par la recherche ;
 * - ils sont appelés DIRECTEMENT (`tools/call { name: <cible> }`), jamais via
 *   `run_tool` (qui les rejetterait en 404) ;
 * - les outils découverts dynamiquement passent par `run_tool` ;
 * - un nom inconnu ou ambigu ne change jamais de cible en silence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpBridge, buildMcpBridgeTools } from '../src/server/mcp-bridge.js';
import type { WorkspaceTool } from '../src/server/tools.js';
import type { AdapterRuntimeMcpServer } from '@paperclipai/adapter-utils';
import { startFakeMcpGateway, type FakeMcpGateway, type RecordedMcpRequest } from './support/fake-mcp-gateway.js';

/** Outils « on-demand » : absents de `tools/list`, exposés par `search_tools`. */
const ON_DEMAND_TOOL = 'gcloud_deploy';

/**
 * `tools/list` conforme à l'upstream : les enveloppes virtuelles, les outils
 * de contexte `paperclip_*`, et les outils de connexion non on-demand.
 */
const GATEWAY_TOOLS = [
  { name: 'search_tools', title: 'Search available tools' },
  { name: 'run_tool', title: 'Run a selected tool' },
  { name: 'paperclip_list_resources', description: 'List resources from fully assigned MCP connections.' },
  { name: 'paperclip_read_resource', description: 'Read a resource URI returned by paperclip_list_resources.' },
  { name: 'paperclip_list_prompts', description: 'List prompts from fully assigned MCP connections.' },
  { name: 'paperclip_get_prompt', description: 'Get a prompt returned by paperclip_list_prompts.' },
  { name: 'github_create_issue', description: 'Create an issue on GitHub' },
];

interface GatewayCall {
  server: string;
  params: any;
}

/**
 * Faux serveur conforme au contrat upstream :
 * - `run_tool` n'accepte que la cible on-demand, sinon 404 `tool_not_found` ;
 * - tout autre `tools/call` est traité comme un appel direct.
 */
function useUpstreamLikeGateway(gateway: FakeMcpGateway, label: string): GatewayCall[] {
  const calls: GatewayCall[] = [];

  gateway.onRpcMethod('initialize', () => ({
    status: 200,
    body: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } },
  }));
  gateway.onRpcMethod('notifications/initialized', () => ({ status: 202, rawBody: '' }));
  gateway.onRpcMethod('tools/list', (req) => ({
    status: 200,
    body: { jsonrpc: '2.0', id: req.body.id, result: { tools: GATEWAY_TOOLS } },
  }));

  gateway.onRpcMethod('tools/call', (req) => {
    const params = req.body?.params ?? {};
    calls.push({ server: label, params });

    if (params.name === 'search_tools') {
      const tools = [{
        name: ON_DEMAND_TOOL,
        displayName: 'GCloud Deploy',
        description: 'Deploy to Google Cloud',
        parametersSchema: { type: 'object', properties: { project: { type: 'string' } } },
      }];
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ tools }) }],
            structuredContent: { tools },
            isError: false,
          },
        },
      };
    }

    if (params.name === 'run_tool') {
      const target = params?.arguments?.tool;
      if (target !== ON_DEMAND_TOOL) {
        // Upstream : `run_tool` ne connaît que les outils on-demand.
        return {
          status: 404,
          body: {
            jsonrpc: '2.0',
            id: req.body.id,
            error: { code: -32020, message: `Tool "${target}" not found` },
          },
        };
      }
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: { content: [{ type: 'text', text: 'DEPLOY OK' }], isError: false },
        },
      };
    }

    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: req.body.id,
        result: { content: [{ type: 'text', text: `DIRECT OK ${params.name}` }], isError: false },
      },
    };
  });

  return calls;
}

function toolCalls(requests: RecordedMcpRequest[]): any[] {
  return requests
    .filter((r) => r.body?.method === 'tools/call')
    .map((r) => r.body.params);
}

describe('MCP — routage sur un serveur unique exposant virtuels ET directs (R1/R2)', () => {
  let gateway: FakeMcpGateway;

  beforeEach(async () => {
    gateway = await startFakeMcpGateway();
  });

  afterEach(async () => {
    await gateway.close();
  });

  function server(overrides: Partial<AdapterRuntimeMcpServer> = {}): AdapterRuntimeMcpServer {
    return {
      name: 'paperclip-assigned',
      url: gateway.url,
      token: 'tok-assigned-abc',
      connectionId: 'conn-assigned',
      ...overrides,
    };
  }

  function toolsFor(servers: AdapterRuntimeMcpServer[]): Map<string, WorkspaceTool> {
    const list = buildMcpBridgeTools({
      servers,
      runId: 'run-r1',
      agentId: 'agent-r1',
      companyId: 'company-r1',
    });
    return new Map(list.map((t: WorkspaceTool) => [t.spec.name, t]));
  }

  it('la recherche expose les outils directs du serveur virtuel ET les outils dynamiques', async () => {
    const calls = useUpstreamLikeGateway(gateway, 'paperclip-assigned');
    expect(calls.length).toBe(0);

    const bridge = new McpBridge({
      servers: [server()],
      runId: 'run-r1',
      agentId: 'agent-r1',
      companyId: 'company-r1',
    });

    const { tools } = await bridge.searchTools(undefined, 20);
    const names = tools.map((t) => t.name);

    // R1 : les outils directs du serveur virtuel doivent être trouvables.
    expect(names).toContain('paperclip_list_resources');
    expect(names).toContain('paperclip_read_resource');
    expect(names).toContain('github_create_issue');
    // Les enveloppes virtuelles ne sont pas des cibles : elles ne sont pas listées.
    expect(names).not.toContain('search_tools');
    expect(names).not.toContain('run_tool');
    // L'outil on-demand découvert via search_tools reste présent.
    expect(names).toContain(ON_DEMAND_TOOL);
  });

  it('filtre les outils directs du serveur virtuel par mot-clé', async () => {
    useUpstreamLikeGateway(gateway, 'paperclip-assigned');

    const bridge = new McpBridge({
      servers: [server()],
      runId: 'run-r1',
      agentId: 'agent-r1',
      companyId: 'company-r1',
    });

    const { tools } = await bridge.searchTools('github', 20);
    expect(tools.map((t) => t.name)).toContain('github_create_issue');
    expect(tools.map((t) => t.name)).not.toContain('paperclip_list_resources');
  });

  it('appelle DIRECTEMENT un outil direct du serveur virtuel (jamais via run_tool)', async () => {
    useUpstreamLikeGateway(gateway, 'paperclip-assigned');

    const tools = toolsFor([server()]);
    const runTool = tools.get('mcp_run_tool')!;

    const res = await runTool.run({ tool: 'paperclip_list_resources', arguments: { uri: 'x' } });

    expect(res.isError).toBe(false);
    expect(res.content).toContain('DIRECT OK paperclip_list_resources');

    const calls = toolCalls(gateway.requests);
    // Un seul appel, et c'est un appel direct : `run_tool` aurait renvoyé 404.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'paperclip_list_resources', arguments: { uri: 'x' } });
  });

  it('appelle DIRECTEMENT un outil de connexion direct du serveur virtuel', async () => {
    useUpstreamLikeGateway(gateway, 'paperclip-assigned');

    const tools = toolsFor([server()]);
    const runTool = tools.get('mcp_run_tool')!;

    const res = await runTool.run({ tool: 'github_create_issue', arguments: { title: 'Bug' } });

    expect(res.isError).toBe(false);
    const calls = toolCalls(gateway.requests);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'github_create_issue', arguments: { title: 'Bug' } });
  });

  it('route un outil découvert dynamiquement via run_tool', async () => {
    useUpstreamLikeGateway(gateway, 'paperclip-assigned');

    const tools = toolsFor([server()]);
    const searchTool = tools.get('mcp_search_tools')!;
    const runTool = tools.get('mcp_run_tool')!;

    const found = await searchTool.run({ query: 'gcloud' });
    expect(found.isError).toBe(false);
    expect(found.content).toContain(ON_DEMAND_TOOL);

    const res = await runTool.run({ tool: ON_DEMAND_TOOL, arguments: { project: 'p' } });
    expect(res.isError).toBe(false);
    expect(res.content).toContain('DEPLOY OK');

    const calls = toolCalls(gateway.requests);
    const runToolCall = calls.find((c) => c.name === 'run_tool');
    expect(runToolCall).toEqual({
      name: 'run_tool',
      arguments: { tool: ON_DEMAND_TOOL, arguments: { project: 'p' } },
    });
  });

  it('refuse un nom d’outil inconnu sans jamais changer de cible (R2)', async () => {
    useUpstreamLikeGateway(gateway, 'paperclip-assigned');

    const tools = toolsFor([server()]);
    const runTool = tools.get('mcp_run_tool')!;

    const res = await runTool.run({ tool: 'outil_qui_nexiste_pas', arguments: { a: 1 } });

    expect(res.isError).toBe(true);
    expect(res.content).toContain('outil_qui_nexiste_pas');
    expect(res.content).toMatch(/inconnu|exposé par aucun serveur/i);
    // Aucun appel d'outil ne doit être parti vers un serveur arbitraire.
    expect(toolCalls(gateway.requests)).toHaveLength(0);
  });

  it('refuse un nom ambigu exposé par plusieurs serveurs sans exécuter d’outil (R2)', async () => {
    const other = await startFakeMcpGateway();
    try {
      const callsA = useUpstreamLikeGateway(gateway, 'srv-a');
      const callsB = useUpstreamLikeGateway(other, 'srv-b');
      expect(callsA.length).toBe(0);
      expect(callsB.length).toBe(0);

      const tools = toolsFor([
        server({ name: 'srv-a' }),
        { name: 'srv-b', url: other.url, token: 'tok-b', connectionId: 'conn-b' },
      ]);
      const runTool = tools.get('mcp_run_tool')!;

      const res = await runTool.run({ tool: 'github_create_issue', arguments: { title: 'Bug' } });

      expect(res.isError).toBe(true);
      expect(res.content).toContain('github_create_issue');
      expect(res.content).toMatch(/ambigu|plusieurs serveurs/i);
      // Aucun serveur ne doit avoir exécuté l'outil.
      expect(toolCalls(gateway.requests)).toHaveLength(0);
      expect(toolCalls(other.requests)).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('permet de lever l’ambiguïté explicitement en nommant le serveur', async () => {
    const other = await startFakeMcpGateway();
    try {
      useUpstreamLikeGateway(gateway, 'srv-a');
      useUpstreamLikeGateway(other, 'srv-b');

      const tools = toolsFor([
        server({ name: 'srv-a' }),
        { name: 'srv-b', url: other.url, token: 'tok-b', connectionId: 'conn-b' },
      ]);
      const runTool = tools.get('mcp_run_tool')!;

      const res = await runTool.run({
        tool: 'github_create_issue',
        arguments: { title: 'Bug' },
        server: 'srv-b',
      });

      expect(res.isError).toBe(false);
      expect(toolCalls(gateway.requests)).toHaveLength(0);
      expect(toolCalls(other.requests)).toEqual([
        { name: 'github_create_issue', arguments: { title: 'Bug' } },
      ]);
    } finally {
      await other.close();
    }
  });

  it('conserve la compat multi-serveurs : un serveur direct reste appelé directement', async () => {
    const other = await startFakeMcpGateway();
    try {
      useUpstreamLikeGateway(gateway, 'paperclip-assigned');
      other.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
      other.onRpcMethod('notifications/initialized', () => ({ status: 202, rawBody: '' }));
      other.onRpcMethod('tools/list', (req) => ({
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: { tools: [{ name: 'db_select', description: 'Run query' }] },
        },
      }));
      other.onRpcMethod('tools/call', (req) => ({
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: { content: [{ type: 'text', text: 'ROWS 1' }], isError: false },
        },
      }));

      const tools = toolsFor([
        server(),
        { name: 'postgres-srv', url: other.url, token: 'tok-db', connectionId: 'conn-db' },
      ]);
      const runTool = tools.get('mcp_run_tool')!;

      const res = await runTool.run({ tool: 'db_select', arguments: { query: 'SELECT 1' } });

      expect(res.isError).toBe(false);
      expect(res.content).toContain('ROWS 1');
      expect(toolCalls(other.requests)).toEqual([
        { name: 'db_select', arguments: { query: 'SELECT 1' } },
      ]);
      expect(toolCalls(gateway.requests)).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('conserve la rédaction des secrets sur les appels directs', async () => {
    const token = 'tok-assigned-abc';
    gateway.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    gateway.onRpcMethod('notifications/initialized', () => ({ status: 202, rawBody: '' }));
    gateway.onRpcMethod('tools/list', (req) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: req.body.id,
        result: { tools: [{ name: 'paperclip_list_resources' }] },
      },
    }));
    gateway.onRpcMethod('tools/call', (req) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: req.body.id,
        result: { content: [{ type: 'text', text: `bearer ${token} accepted` }], isError: false },
      },
    }));

    const list = buildMcpBridgeTools({
      servers: [server()],
      runId: 'run-r1',
      agentId: 'agent-r1',
      companyId: 'company-r1',
      redactSecrets: (t: string) => t.replaceAll(token, '[REDACTED]'),
    });
    const runTool = new Map(list.map((t: WorkspaceTool) => [t.spec.name, t])).get('mcp_run_tool')!;

    const res = await runTool.run({ tool: 'paperclip_list_resources' });

    expect(res.isError).toBe(false);
    expect(res.content).toContain('[REDACTED]');
    expect(res.content).not.toContain(token);
  });

  it('conserve l’annulation : un signal interrompu ne renvoie aucun résultat d’outil', async () => {
    useUpstreamLikeGateway(gateway, 'paperclip-assigned');

    const controller = new AbortController();
    const list = buildMcpBridgeTools({
      servers: [server()],
      runId: 'run-r1',
      agentId: 'agent-r1',
      companyId: 'company-r1',
      signal: controller.signal,
    });
    const runTool = new Map(list.map((t: WorkspaceTool) => [t.spec.name, t])).get('mcp_run_tool')!;

    controller.abort();
    const res = await runTool.run({ tool: 'paperclip_list_resources' });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/interrompu|délai dépassé|annul/i);
  });
});

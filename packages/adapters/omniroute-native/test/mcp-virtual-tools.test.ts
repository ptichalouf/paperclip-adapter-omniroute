import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpBridgeTools, type McpBridgeOptions, MAX_MCP_OUTPUT_CHARS } from '../src/server/mcp-bridge.js';
import type { WorkspaceTool } from '../src/server/tools.js';
import type { AdapterRuntimeMcpServer } from '@paperclipai/adapter-utils';
import { startFakeMcpGateway, type FakeMcpGateway } from './support/fake-mcp-gateway.js';

describe('MCP Virtual Tools (mcp_search_tools & mcp_run_tool)', () => {
  let fake: FakeMcpGateway;
  const FAKE_TOKEN = 'secret-token-vtools-45678';
  const RUN_ID = 'run-vtools-123';

  beforeEach(async () => {
    fake = await startFakeMcpGateway();
  });

  afterEach(async () => {
    await fake.close();
  });

  function getTools(overrides: Partial<McpBridgeOptions> = {}): Map<string, WorkspaceTool> {
    const server: AdapterRuntimeMcpServer = {
      name: 'paperclip-assigned',
      url: fake.url,
      token: FAKE_TOKEN,
      connectionId: 'conn-assigned',
    };
    const list = buildMcpBridgeTools({
      servers: [server],
      runId: RUN_ID,
      agentId: 'agent-1',
      companyId: 'company-1',
      redactSecrets: (t: string) => t.replaceAll(FAKE_TOKEN, '[REDACTED]'),
      ...overrides,
    });
    return new Map(list.map((t: WorkspaceTool) => [t.spec.name, t]));
  }

  it('exporte exactement les deux outils virtuels invariants mcp_search_tools et mcp_run_tool', () => {
    const tools = getTools();
    expect(tools.size).toBe(2);
    expect(tools.has('mcp_search_tools')).toBe(true);
    expect(tools.has('mcp_run_tool')).toBe(true);

    const searchSpec = tools.get('mcp_search_tools')!.spec;
    expect(searchSpec.name).toBe('mcp_search_tools');
    expect(searchSpec.input_schema.type).toBe('object');

    const runSpec = tools.get('mcp_run_tool')!.spec;
    expect(runSpec.name).toBe('mcp_run_tool');
    expect(runSpec.input_schema.required).toContain('tool');
  });

  it('mcp_search_tools formate les outils découverts et leurs schémas de paramètres', async () => {
    fake.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            {
              name: 'github_create_issue',
              displayName: 'Create Issue',
              description: 'Create a GitHub issue',
              inputSchema: {
                type: 'object',
                properties: { title: { type: 'string' } },
                required: ['title'],
              },
            },
          ],
        },
      },
    }));

    const tools = getTools();
    const searchTool = tools.get('mcp_search_tools')!;
    const res = await searchTool.run({ query: 'github' });

    expect(res.isError).toBe(false);
    expect(res.content).toContain('github_create_issue');
    expect(res.content).toContain('Create Issue');
    expect(res.content).toContain('title');
  });

  it('mcp_run_tool relaie vers la passerelle Paperclip en mode outils virtuels natifs', async () => {
    let callParams: any = null;

    fake.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            { name: 'search_tools', title: 'Search available tools' },
            { name: 'run_tool', title: 'Run a selected tool' },
          ],
        },
      },
    }));
    fake.onRpcMethod('tools/call', (req) => {
      callParams = req.body.params;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: {
            content: [{ type: 'text', text: '{"issueNumber": 42, "status": "created"}' }],
            isError: false,
          },
        },
      };
    });

    const tools = getTools();
    const runTool = tools.get('mcp_run_tool')!;
    const res = await runTool.run({
      tool: 'github:create_issue',
      arguments: { title: 'Bug critique', body: 'Détails du bug' },
    });

    expect(res.isError).toBe(false);
    expect(res.content).toContain('"issueNumber": 42');
    expect(callParams).toEqual({
      name: 'run_tool',
      arguments: {
        tool: 'github:create_issue',
        arguments: { title: 'Bug critique', body: 'Détails du bug' },
      },
    });
  });

  it('mcp_run_tool relaie directement quand la passerelle expose les outils en direct', async () => {
    let callParams: any = null;

    fake.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [{ name: 'db_select', description: 'Run query' }],
        },
      },
    }));
    fake.onRpcMethod('tools/call', (req) => {
      callParams = req.body.params;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: {
            content: [{ type: 'text', text: '[{"id": 1, "username": "admin"}]' }],
            isError: false,
          },
        },
      };
    });

    const tools = getTools();
    const runTool = tools.get('mcp_run_tool')!;
    const res = await runTool.run({
      tool: 'db_select',
      arguments: { query: 'SELECT * FROM users' },
    });

    expect(res.isError).toBe(false);
    expect(res.content).toContain('"username": "admin"');
    expect(callParams).toEqual({
      name: 'db_select',
      arguments: { query: 'SELECT * FROM users' },
    });
  });

  it('valide la présence de l’argument requis « tool » et lève une erreur explicite', async () => {
    const tools = getTools();
    const runTool = tools.get('mcp_run_tool')!;

    const resMissing = await runTool.run({});
    expect(resMissing.isError).toBe(true);
    expect(resMissing.content).toContain('« tool » est requis');

    const resWrongType = await runTool.run({ tool: 123 });
    expect(resWrongType.isError).toBe(true);
    expect(resWrongType.content).toContain('« tool » doit être une chaîne');
  });

  it('propage isError: true si l’outil amont échoue', async () => {
    fake.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake.onRpcMethod('tools/list', () => ({ status: 200, body: { jsonrpc: '2.0', id: 2, result: { tools: [] } } }));
    fake.onRpcMethod('tools/call', (req) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          content: [{ type: 'text', text: 'Error: Rate limit exceeded on GitHub API' }],
          isError: true,
        },
      },
    }));

    const tools = getTools();
    const runTool = tools.get('mcp_run_tool')!;
    const res = await runTool.run({ tool: 'github_search' });

    expect(res.isError).toBe(true);
    expect(res.content).toContain('Rate limit exceeded');
  });

  it('tronque proprement les sorties volumineuses dépassant MAX_MCP_OUTPUT_CHARS (24 000 chars)', async () => {
    const hugeOutput = 'X'.repeat(30_000);
    fake.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake.onRpcMethod('tools/list', () => ({ status: 200, body: { jsonrpc: '2.0', id: 2, result: { tools: [] } } }));
    fake.onRpcMethod('tools/call', (req) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          content: [{ type: 'text', text: hugeOutput }],
          isError: false,
        },
      },
    }));

    const tools = getTools();
    const runTool = tools.get('mcp_run_tool')!;
    const res = await runTool.run({ tool: 'dump_database' });

    expect(res.isError).toBe(false);
    expect(res.content.length).toBeLessThanOrEqual(MAX_MCP_OUTPUT_CHARS);
    expect(res.content).toContain('tronquée : 30000 caractères');
  });

  it('masque les secrets et tokens dans les sorties d’outils', async () => {
    fake.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake.onRpcMethod('tools/list', () => ({ status: 200, body: { jsonrpc: '2.0', id: 2, result: { tools: [] } } }));
    fake.onRpcMethod('tools/call', (req) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          content: [{ type: 'text', text: `Access granted with token ${FAKE_TOKEN}` }],
          isError: false,
        },
      },
    }));

    const tools = getTools();
    const runTool = tools.get('mcp_run_tool')!;
    const res = await runTool.run({ tool: 'get_auth_state' });

    expect(res.isError).toBe(false);
    expect(res.content).toContain('[REDACTED]');
    expect(res.content).not.toContain(FAKE_TOKEN);
  });

  it('mcp_run_tool route vers run_tool pour le serveur virtuel et directement pour le serveur direct', async () => {
    let virtualCalled: any = null;
    let directCalled: any = null;

    fake.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            { name: 'search_tools', title: 'Search tools' },
            { name: 'run_tool', title: 'Run tool' },
          ],
        },
      },
    }));
    fake.onRpcMethod('tools/call', (req) => {
      virtualCalled = req.body.params;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: { content: [{ type: 'text', text: 'virtual ok' }] },
        },
      };
    });

    const fakeDirect = await startFakeMcpGateway();
    fakeDirect.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fakeDirect.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fakeDirect.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [{ name: 'direct_action', description: 'Direct tool' }],
        },
      },
    }));
    fakeDirect.onRpcMethod('tools/call', (req) => {
      directCalled = req.body.params;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: { content: [{ type: 'text', text: 'direct ok' }] },
        },
      };
    });

    try {
      const toolMap = new Map(
        buildMcpBridgeTools({
          servers: [
            { name: 'paperclip-assigned', url: fake.url, token: 'tok1', connectionId: 'c1' },
            { name: 'direct-srv', url: fakeDirect.url, token: 'tok2', connectionId: 'c2' },
          ],
          runId: 'run-multi-1',
          agentId: 'a1',
          companyId: 'c1',
        }).map((t) => [t.spec.name, t]),
      );

      const runTool = toolMap.get('mcp_run_tool')!;

      // 1. Exécution de direct_action -> doit appeler direct_action en direct sur fakeDirect
      const resDirect = await runTool.run({ tool: 'direct_action', arguments: { foo: 'bar' } });
      expect(resDirect.isError).toBe(false);
      expect(directCalled).toEqual({
        name: 'direct_action',
        arguments: { foo: 'bar' },
      });

      // 2. Exécution d'un outil virtuel -> doit appeler run_tool sur fake (paperclip-assigned)
      const resVirtual = await runTool.run({ tool: 'virtual_target', arguments: { num: 42 } });
      expect(resVirtual.isError).toBe(false);
      expect(virtualCalled).toEqual({
        name: 'run_tool',
        arguments: {
          tool: 'virtual_target',
          arguments: { num: 42 },
        },
      });
    } finally {
      await fakeDirect.close();
    }
  });
});

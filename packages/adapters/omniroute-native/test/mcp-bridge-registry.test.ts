import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpBridge, type McpBridgeOptions, type DiscoveredMcpTool } from '../src/server/mcp-bridge.js';
import type { AdapterRuntimeMcpServer } from '@paperclipai/adapter-utils';
import { startFakeMcpGateway, type FakeMcpGateway } from './support/fake-mcp-gateway.js';

describe('McpBridge & Registry', () => {
  let fake1: FakeMcpGateway;
  let fake2: FakeMcpGateway;

  beforeEach(async () => {
    fake1 = await startFakeMcpGateway();
    fake2 = await startFakeMcpGateway();
  });

  afterEach(async () => {
    await fake1.close();
    await fake2.close();
  });

  function makeOptions(servers: AdapterRuntimeMcpServer[], extra: Partial<McpBridgeOptions> = {}): McpBridgeOptions {
    return {
      servers,
      runId: 'run-test-reg',
      agentId: 'agent-test-reg',
      companyId: 'company-test-reg',
      ...extra,
    };
  }

  it('exécute le handshake initialize et notifications/initialized lors de ensureDiscovered', async () => {
    let initializedReceived = false;
    fake1.onRpcMethod('initialize', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } },
      },
    }));
    fake1.onRpcMethod('notifications/initialized', () => {
      initializedReceived = true;
      return { status: 202, rawBody: '' };
    });
    fake1.onRpcMethod('tools/list', () => ({
      status: 200,
      body: { jsonrpc: '2.0', id: 2, result: { tools: [] } },
    }));

    const bridge = new McpBridge(
      makeOptions([{ name: 'srv1', url: fake1.url, token: 'tok1', connectionId: 'c1' }]),
    );

    await bridge.ensureDiscovered();

    expect(initializedReceived).toBe(true);
    expect(bridge.isInitialized()).toBe(true);
  });

  it('agrège les outils de plusieurs serveurs MCP (ex: paperclip-assigned + projects)', async () => {
    fake1.onRpcMethod('initialize', () => ({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: {} },
    }));
    fake1.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake1.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            { name: 'github_create_issue', description: 'Create an issue on GitHub', inputSchema: { type: 'object' } },
            { name: 'github_get_pr', description: 'Get PR details', inputSchema: { type: 'object' } },
          ],
        },
      },
    }));

    fake2.onRpcMethod('initialize', () => ({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: {} },
    }));
    fake2.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake2.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            { name: 'db_query', description: 'Query PostgreSQL database', inputSchema: { type: 'object' } },
          ],
        },
      },
    }));

    const bridge = new McpBridge(
      makeOptions([
        { name: 'github-gateway', url: fake1.url, token: 'tok1', connectionId: 'c1' },
        { name: 'db-gateway', url: fake2.url, token: 'tok2', connectionId: 'c2' },
      ]),
    );

    await bridge.ensureDiscovered();
    const catalog = bridge.getCatalog();

    expect(catalog).toHaveLength(3);
    expect(catalog.map((t: DiscoveredMcpTool) => t.name)).toEqual(['github_create_issue', 'github_get_pr', 'db_query']);
    expect(catalog.find((t: DiscoveredMcpTool) => t.name === 'db_query')?.serverName).toBe('db-gateway');
  });

  it('filtre les outils par mot-clé (insensible à la casse sur nom, displayName, description)', async () => {
    fake1.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake1.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake1.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            { name: 'cloudflare_dns_record', displayName: 'DNS Record Manager', description: 'Manage DNS records in Cloudflare' },
            { name: 'github_issue', displayName: 'GitHub Issues', description: 'Bug tracking and features' },
            { name: 'postgres_select', displayName: 'Execute Query', description: 'Run SELECT SQL queries' },
          ],
        },
      },
    }));

    const bridge = new McpBridge(
      makeOptions([{ name: 'srv', url: fake1.url, token: 'tok', connectionId: 'c1' }]),
    );

    const resDns = await bridge.searchTools('dns');
    expect(resDns.tools).toHaveLength(1);
    expect(resDns.tools[0].name).toBe('cloudflare_dns_record');

    const resBug = await bridge.searchTools('BUG');
    expect(resBug.tools).toHaveLength(1);
    expect(resBug.tools[0].name).toBe('github_issue');

    const resEmpty = await bridge.searchTools('');
    expect(resEmpty.tools).toHaveLength(3);
  });

  it('respecte la limite de résultats passée en paramètre (pagination/limit)', async () => {
    fake1.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake1.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake1.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: Array.from({ length: 15 }, (_, i) => ({
            name: `tool_${i}`,
            description: `Description of tool ${i}`,
          })),
        },
      },
    }));

    const bridge = new McpBridge(
      makeOptions([{ name: 'srv', url: fake1.url, token: 'tok', connectionId: 'c1' }]),
    );

    const res = await bridge.searchTools(undefined, 5);
    expect(res.tools).toHaveLength(5);
  });

  it('détecte quand un serveur expose déjà les outils virtuels natifs (search_tools et run_tool)', async () => {
    fake1.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake1.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake1.onRpcMethod('tools/list', () => ({
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

    const bridge = new McpBridge(
      makeOptions([{ name: 'paperclip-assigned', url: fake1.url, token: 'tok', connectionId: 'c1' }]),
    );

    await bridge.ensureDiscovered();
    expect(bridge.hasNativeVirtualTools()).toBe(true);
  });

  it('ne plante pas si un des serveurs MCP est indisponible (dégradation gracieuse)', async () => {
    fake1.onRpcMethod('initialize', () => ({
      status: 500,
      body: { error: 'Internal server error' },
    }));

    fake2.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake2.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake2.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'healthy_tool', description: 'Alive' }] },
      },
    }));

    const bridge = new McpBridge(
      makeOptions([
        { name: 'crashed-srv', url: fake1.url, token: 'tok1', connectionId: 'c1' },
        { name: 'healthy-srv', url: fake2.url, token: 'tok2', connectionId: 'c2' },
      ]),
    );

    await bridge.ensureDiscovered();
    expect(bridge.getCatalog()).toHaveLength(1);
    expect(bridge.getCatalog()[0].name).toBe('healthy_tool');
  });

  it('tolère le rejet ou l’absence de initialize (Tool Gateway Paperclip) et découvre via tools/list', async () => {
    fake1.onRpcMethod('initialize', () => ({
      status: 403,
      body: { error: 'Forbidden: initialize not allowed' },
    }));
    fake1.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'gateway_tool', description: 'Available' }] },
      },
    }));

    const bridge = new McpBridge(
      makeOptions([{ name: 'paperclip-tool-gw', url: fake1.url, token: 'tok', connectionId: 'c1' }]),
    );

    await bridge.ensureDiscovered();
    expect(bridge.getCatalog()).toHaveLength(1);
    expect(bridge.getCatalog()[0].name).toBe('gateway_tool');
  });

  it('gère la coexistence multi-serveurs avec serveurs virtuels et directs', async () => {
    // Serveur 1 : virtuel (expose search_tools et run_tool)
    fake1.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake1.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake1.onRpcMethod('tools/list', () => ({
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
    fake1.onRpcMethod('tools/call', (req) => {
      if (req.body.params?.name === 'search_tools') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
              data: {
                tools: [{ name: 'virtual_github_issue', description: 'GitHub issue tool' }],
              },
            },
          },
        };
      }
      return { status: 404 };
    });

    // Serveur 2 : direct (expose db_select)
    fake2.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fake2.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fake2.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [{ name: 'db_select', description: 'Database select tool' }],
        },
      },
    }));

    const bridge = new McpBridge(
      makeOptions([
        { name: 'paperclip-assigned', url: fake1.url, token: 'tok1', connectionId: 'c1' },
        { name: 'postgres-srv', url: fake2.url, token: 'tok2', connectionId: 'c2' },
      ]),
    );

    await bridge.ensureDiscovered();

    expect(bridge.hasNativeVirtualTools('paperclip-assigned')).toBe(true);
    expect(bridge.hasNativeVirtualTools('postgres-srv')).toBe(false);

    // searchTools retourne les outils du serveur virtuel ET du serveur direct
    const searchRes = await bridge.searchTools();
    const toolNames = searchRes.tools.map((t) => t.name);
    expect(toolNames).toContain('virtual_github_issue');
    expect(toolNames).toContain('db_select');
  });
});

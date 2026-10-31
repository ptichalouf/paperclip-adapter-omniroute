import { afterEach, expect, it, vi } from 'vitest';
import { buildMcpBridgeTools } from '../src/server/mcp-bridge.js';
afterEach(() => vi.unstubAllGlobals());
it('preserves both search identities and refuses cross-mode ambiguity until qualified', async () => {
  const executed: Array<{url: string; params: any}> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const rpc = JSON.parse(String(init.body));
    const virtual = String(url).includes('virtual.test');
    let result: unknown = {};
    if (rpc.method === 'tools/list') result = { tools: virtual
      ? [{ name: 'search_tools' }, { name: 'run_tool' }]
      : [{ name: 'shared_write_tool' }] };
    if (rpc.method === 'tools/call') {
      if (rpc.params.name === 'search_tools') result = { structuredContent: { tools: [{ name: 'shared_write_tool' }] } };
      else { executed.push({ url: String(url), params: rpc.params }); result = { content: [{ type: 'text', text: 'EXECUTED' }] }; }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  }));
  const tools = new Map(buildMcpBridgeTools({ servers: [
    { name: 'direct', url: 'http://direct.test/mcp', token: 'synthetic-direct', connectionId: 'direct' },
    { name: 'virtual', url: 'http://virtual.test/mcp', token: 'synthetic-virtual', connectionId: 'virtual' },
  ], runId: 'test', agentId: 'test', companyId: 'test' }).map(t => [t.spec.name, t]));
  const found = await tools.get('mcp_search_tools')!.run({});
  expect(found.isError).toBe(false);
  const response = await tools.get('mcp_run_tool')!.run({ tool: 'shared_write_tool', arguments: { action: 'change' } });
  expect(response.isError).toBe(true);
  expect(response.content).toMatch(/ambigu/i);
  expect(executed).toEqual([]);
  const matches = JSON.parse(found.content).tools.filter((t: any) => t.name === 'shared_write_tool');
  expect(matches.map((t: any) => t.serverName).sort()).toEqual(['direct', 'virtual']);
  expect((await tools.get('mcp_run_tool')!.run({ tool: 'shared_write_tool', server: 'direct' })).isError).toBe(false);
  expect(executed).toHaveLength(1);
  expect(executed[0].url).toBe('http://direct.test/mcp');
  expect(executed[0].params.name).toBe('shared_write_tool');
  expect((await tools.get('mcp_run_tool')!.run({ tool: 'shared_write_tool', server: 'virtual' })).isError).toBe(false);
  expect(executed).toHaveLength(2);
  expect(executed[1].url).toBe('http://virtual.test/mcp');
  expect(executed[1].params.name).toBe('run_tool');
});

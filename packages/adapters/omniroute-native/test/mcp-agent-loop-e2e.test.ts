import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildSystemPromptForTest, execute } from '../src/server/execute.js';
import { startFakeMcpGateway, type FakeMcpGateway } from './support/fake-mcp-gateway.js';
import { makeTestContext } from './support/test-context.js';
import type { AdapterRuntimeMcpServer } from '@paperclipai/adapter-utils';

describe('MCP Agent Loop End-to-End', () => {
  let fakeMcp: FakeMcpGateway;
  let sseServer: Server;
  let sseBaseUrl: string;
  let capturedGatewayRequests: any[] = [];
  let sseResponses: Array<(reqIndex: number) => any> = [];

  const MCP_TOKEN = 'secret-mcp-bearer-e2e-token-888';
  const RUN_ID = 'run-e2e-mcp-42';
  const workspace = path.join('/tmp', `omniroute-mcp-e2e-${process.pid}`);

  beforeEach(async () => {
    fakeMcp = await startFakeMcpGateway();
    capturedGatewayRequests = [];
    sseResponses = [];

    await fs.mkdir(workspace, { recursive: true });

    sseServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'auto/best-coding' }] }));
        return;
      }

      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        capturedGatewayRequests.push(body);
        const reqIdx = capturedGatewayRequests.length - 1;

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        const responder = sseResponses[reqIdx];
        if (responder) {
          const events = responder(reqIdx);
          for (const ev of events) {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }
        } else {
          res.write(
            `data: ${JSON.stringify({
              model: 'auto/best-coding',
              choices: [{ delta: { content: 'Terminé.' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            })}\n\n`,
          );
        }
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      sseServer.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (sseServer.address() as AddressInfo).port;
    sseBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await fakeMcp.close();
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function createMcpServers(): AdapterRuntimeMcpServer[] {
    return [
      {
        name: 'paperclip-assigned',
        url: fakeMcp.url,
        token: MCP_TOKEN,
        connectionId: 'conn-assigned',
      },
    ];
  }

  it('keeps universal MCP guidance invariant whether servers are provided or not', () => {
    const { ctx: ctxWithoutMcp } = makeTestContext();
    const promptWithout = buildSystemPromptForTest(ctxWithoutMcp as never);
    expect(promptWithout).toContain('## Outils MCP et Connexions d’Entreprise');
    expect(promptWithout).toContain('mcp_search_tools');

    const { ctx: ctxWithMcp } = makeTestContext();
    (ctxWithMcp as any).runtimeMcp = {
      getServers: () => createMcpServers(),
    };
    const promptWith = buildSystemPromptForTest(ctxWithMcp as never);
    expect(promptWith).toBe(promptWithout);
    expect(promptWith).toContain('Outils MCP');
    expect(promptWith).toContain('mcp_search_tools');
    expect(promptWith).toContain('mcp_run_tool');
    expect(promptWith).not.toContain(MCP_TOKEN);
  });

  it('sends byte-identical system messages over HTTP with/without MCP and different handoffs', async () => {
    for (const hasMcp of [false, true]) {
      for (const handoff of ['handoff-alpha', 'handoff-beta']) {
        const { ctx } = makeTestContext({
          config: { baseUrl: sseBaseUrl },
          context: { paperclipWorkspace: { cwd: workspace, agentHome: workspace },
            paperclipFreshSessionHandoffMarkdown: handoff },
        });
        if (hasMcp) ctx['runtimeMcp'] = { getServers: () => createMcpServers() };
        expect((await execute(ctx as never)).exitCode).toBe(0);
      }
    }
    expect(capturedGatewayRequests).toHaveLength(4);
    const systems = capturedGatewayRequests.map((body) => JSON.stringify(body.messages.filter((m: any) => m.role === 'system')));
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).not.toContain(MCP_TOKEN);
    expect(systems[0]).not.toContain('handoff-alpha');
    expect(systems[0]).not.toContain('handoff-beta');
    for (const body of capturedGatewayRequests) {
      expect(systems[0]).toContain('paperclip_ask_user');
      expect(systems[0]).toContain('mcp_run_tool');
      expect(JSON.stringify(body.messages.filter((m: any) => m.role === 'user'))).toMatch(/handoff-alpha|handoff-beta/);
    }
  });

  it('exécute un scénario complet : recherche d’outil, exécution déléguée et synthèse finale', async () => {
    // Configuration du faux serveur MCP
    fakeMcp.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fakeMcp.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fakeMcp.onRpcMethod('tools/list', () => ({
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

    let runToolReceived = false;
    fakeMcp.onRpcMethod('tools/call', (req) => {
      if (req.body.params?.name === 'search_tools') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    tools: [
                      {
                        name: 'github:create_issue',
                        displayName: 'Create GitHub Issue',
                        description: 'Creates a new issue in GitHub',
                        parametersSchema: {
                          type: 'object',
                          properties: { title: { type: 'string' } },
                          required: ['title'],
                        },
                      },
                    ],
                  }),
                },
              ],
            },
          },
        };
      }
      if (req.body.params?.name === 'run_tool') {
        runToolReceived = true;
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
              content: [{ type: 'text', text: '{"id": 101, "html_url": "https://github.com/org/repo/issues/101"}' }],
              isError: false,
            },
          },
        };
      }
      return { status: 404, body: { error: 'Unknown tool call' } };
    });

    // Configuration des réponses du modèle (OmniRoute SSE)
    // Tour 1: Le modèle appelle mcp_search_tools
    sseResponses.push(() => [
      {
        model: 'auto/best-coding',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_search',
                  function: {
                    name: 'mcp_search_tools',
                    arguments: JSON.stringify({ query: 'github' }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'auto/best-coding',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      },
    ]);

    // Tour 2: Le modèle a reçu le schéma et appelle mcp_run_tool
    sseResponses.push(() => [
      {
        model: 'auto/best-coding',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_run',
                  function: {
                    name: 'mcp_run_tool',
                    arguments: JSON.stringify({
                      tool: 'github:create_issue',
                      arguments: { title: 'Bug en production' },
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'auto/best-coding',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 80, completion_tokens: 30 },
      },
    ]);

    // Tour 3: Le modèle fait la synthèse finale
    sseResponses.push(() => [
      {
        model: 'auto/best-coding',
        choices: [
          {
            delta: {
              content: "Le ticket GitHub #101 a été créé avec succès via l'outil MCP.",
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 15 },
      },
    ]);

    const { ctx } = makeTestContext({
      config: { baseUrl: sseBaseUrl },
      context: { paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
    });
    (ctx as any).runId = RUN_ID;
    (ctx as any).runtimeMcp = {
      getServers: () => createMcpServers(),
    };

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeUndefined();
    expect(runToolReceived).toBe(true);

    // Vérifie que les outils virtuels étaient bien dans la liste proposée
    const offeredTools = capturedGatewayRequests[0]?.tools?.map((t: any) => t.function?.name) ?? [];
    expect(offeredTools).toContain('mcp_search_tools');
    expect(offeredTools).toContain('mcp_run_tool');

    // Vérifie le résultat final
    const finalResp = (result.resultJson as any)?.finalResponse;
    expect(finalResp?.text).toContain('ticket GitHub #101 a été créé avec succès');
  });

  it('gère gracieusement un timeout ou une erreur d’un outil MCP sans crasher la boucle agent', async () => {
    fakeMcp.onRpcMethod('initialize', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    fakeMcp.onRpcMethod('notifications/initialized', () => ({ status: 202 }));
    fakeMcp.onRpcMethod('tools/list', () => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'slow_tool' }] },
      },
    }));
    fakeMcp.onRpcMethod('tools/call', () => ({
      status: 504,
      rawBody: 'Gateway Timeout from external service',
    }));

    // Tour 1: Le modèle appelle slow_tool
    sseResponses.push(() => [
      {
        model: 'auto/best-coding',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_slow',
                  function: {
                    name: 'mcp_run_tool',
                    arguments: JSON.stringify({ tool: 'slow_tool' }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'auto/best-coding',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      },
    ]);

    // Tour 2: Le modèle reçoit l'erreur de l'outil et conclut
    sseResponses.push(() => [
      {
        model: 'auto/best-coding',
        choices: [
          {
            delta: {
              content: 'L’outil externe est indisponible (erreur HTTP 504). Je signale le blocage.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 90, completion_tokens: 15 },
      },
    ]);

    const { ctx } = makeTestContext({
      config: { baseUrl: sseBaseUrl },
      context: { paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
    });
    (ctx as any).runId = RUN_ID;
    (ctx as any).runtimeMcp = {
      getServers: () => createMcpServers(),
    };

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    const finalResp = (result.resultJson as any)?.finalResponse;
    expect(finalResp?.text).toContain('L’outil externe est indisponible');
  });
});

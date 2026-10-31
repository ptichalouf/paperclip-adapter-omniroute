import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMcpBridgeTools } from '../src/server/mcp-bridge.js';
import { buildChatCompletionsPayload } from '../src/shared/chat-completions.js';
import type { WireMessage } from '../src/shared/wire.js';
import type { AdapterRuntimeMcpServer } from '@paperclipai/adapter-utils';

describe('MCP Cache Invariance & Stability', () => {
  const server: AdapterRuntimeMcpServer = {
    name: 'paperclip-assigned',
    url: 'http://127.0.0.1:9999/mcp',
    token: 'fake-token-test',
    connectionId: 'assigned-conn',
  };

  function hashTools(payload: Record<string, unknown>): string {
    const toolsJson = JSON.stringify(payload['tools'] ?? []);
    return createHash('sha256').update(toolsJson).digest('hex');
  }

  it('garantit une liste d’outils strictement invariante entre les tours de la boucle agent', async () => {
    const mcpTools = buildMcpBridgeTools({
      servers: [server],
      runId: 'run-1',
      agentId: 'agent-1',
      companyId: 'company-1',
    });

    const staticTools = mcpTools.map((t) => t.spec);

    // Tour 1 : l'utilisateur pose une question
    const messagesTurn1: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Crée un ticket GitHub pour le bug X' }] },
    ];
    const payloadTurn1 = buildChatCompletionsPayload({
      model: 'auto/coding',
      system: 'Tu es un assistant de code.',
      messages: messagesTurn1,
      tools: staticTools,
      maxTokens: 4096,
      reasoningEffort: 'none',
    });

    // Tour 2 : le modèle a appelé mcp_search_tools et reçoit le résultat
    const messagesTurn2: WireMessage[] = [
      ...messagesTurn1,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_search_1',
            name: 'mcp_search_tools',
            input: { query: 'github' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_search_1',
            content: JSON.stringify({
              tools: [
                {
                  name: 'github_create_issue',
                  description: 'Create issue',
                  parametersSchema: { type: 'object' },
                },
                {
                  name: 'github_list_issues',
                  description: 'List issues',
                  parametersSchema: { type: 'object' },
                },
              ],
            }),
          },
        ],
      },
    ];
    const payloadTurn2 = buildChatCompletionsPayload({
      model: 'auto/coding',
      system: 'Tu es un assistant de code.',
      messages: messagesTurn2,
      tools: staticTools,
      maxTokens: 4096,
      reasoningEffort: 'none',
    });

    // Tour 3 : le modèle a appelé mcp_run_tool et reçoit la réponse
    const messagesTurn3: WireMessage[] = [
      ...messagesTurn2,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_run_1',
            name: 'mcp_run_tool',
            input: { tool: 'github_create_issue', arguments: { title: 'Bug X' } },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_run_1',
            content: '{"issueId": 123, "status": "open"}',
          },
        ],
      },
    ];
    const payloadTurn3 = buildChatCompletionsPayload({
      model: 'auto/coding',
      system: 'Tu es un assistant de code.',
      messages: messagesTurn3,
      tools: staticTools,
      maxTokens: 4096,
      reasoningEffort: 'none',
    });

    // 1. Les outils dans payload.tools ne contiennent jamais les 50 outils amont
    const tools1 = payloadTurn1['tools'] as any[];
    const tools2 = payloadTurn2['tools'] as any[];
    const tools3 = payloadTurn3['tools'] as any[];

    expect(tools1).toHaveLength(2);
    expect(tools2).toHaveLength(2);
    expect(tools3).toHaveLength(2);

    expect(tools1.map((t) => t.function.name)).toEqual(['mcp_search_tools', 'mcp_run_tool']);
    expect(tools2.map((t) => t.function.name)).toEqual(['mcp_search_tools', 'mcp_run_tool']);
    expect(tools3.map((t) => t.function.name)).toEqual(['mcp_search_tools', 'mcp_run_tool']);

    // 2. Le hash des schémas d'outils est rigoureusement identique aux tours 1, 2 et 3
    const hash1 = hashTools(payloadTurn1);
    const hash2 = hashTools(payloadTurn2);
    const hash3 = hashTools(payloadTurn3);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('maintient le marqueur cache_control ephemeral sur le dernier message à chaque tour', () => {
    const mcpTools = buildMcpBridgeTools({
      servers: [server],
      runId: 'run-1',
      agentId: 'agent-1',
      companyId: 'company-1',
    });

    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Recherche les outils' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'mcp_search_tools', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"tools":[]}' }],
      },
    ];

    const payload = buildChatCompletionsPayload({
      model: 'auto/coding',
      system: 'System prompt',
      messages,
      tools: mcpTools.map((t) => t.spec),
      maxTokens: 1024,
      reasoningEffort: 'none',
    });

    const openaiMessages = payload['messages'] as Array<Record<string, unknown>>;
    const lastMessage = openaiMessages[openaiMessages.length - 1];

    expect(lastMessage['role']).toBe('tool');
    expect(lastMessage['cache_control']).toEqual({ type: 'ephemeral' });

    // Le message système en tête n'a pas de cache_control posé par le helper (posé sur le dernier)
    const systemMessage = openaiMessages[0];
    expect(systemMessage['role']).toBe('system');
    expect(systemMessage['cache_control']).toBeUndefined();
  });
});

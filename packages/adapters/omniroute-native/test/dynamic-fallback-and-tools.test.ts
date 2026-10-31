import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import { buildChatCompletionsPayload } from '../src/shared/chat-completions.js';
import { OmniRouteError } from '../src/shared/client.js';
import { classifyGatewayError } from '../src/shared/errors.js';
import { configSchema } from '../src/server/config-schema.js';
import type { WireContentBlock } from '../src/shared/wire.js';

function mockSuccess(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stopReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'AC-main',
    gatewayHeaders: { 'x-omniroute-route-class': 'CLIENT_API' },
    costUsd: 0.001,
  };
}

describe('Lot 6 — Repli dynamique en cours de run et contrôle parallel_tool_calls', () => {
  it('bascule sur fallbackModel lors d un échec transitoire ou quota du modèle principal', async () => {
    const warn = vi.fn(async () => {});
    const emit = vi.fn(async () => {});

    let callCount = 0;
    const requestedModels: string[] = [];

    const mockClient = {
      streamMessage: vi.fn(async (params: { model: string }) => {
        requestedModels.push(params.model);
        callCount += 1;
        if (params.model === 'auto/best-coding') {
          // Échec du modèle primaire (ex: quota ou indisponibilité amont)
          const classified = classifyGatewayError({ status: 503, message: 'All upstream members exhausted' });
          throw new OmniRouteError('Service Unavailable', classified, 503);
        }
        return mockSuccess('Réponse du modèle de repli');
      }),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'auto/best-coding',
      fallbackModel: 'AC-main',
      system: 'system prompt',
      initialUserMessage: 'salut',
      tools: [],
      maxTokens: 1024,
      reasoningEffort: 'none',
      maxTurns: 3,
      emit,
      warn,
    };

    const result = await runAgentLoop(options);

    expect(result.completion).toBe('completed');
    expect(result.finalText).toBe('Réponse du modèle de repli');
    expect(requestedModels).toEqual(['auto/best-coding', 'AC-main']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bascule sur « AC-main »'));
    expect(result.servedModel).toBe('AC-main');
  });

  it('bascule sur fallbackModel lors d un 404 (modèle introuvable côté passerelle)', async () => {
    const warn = vi.fn(async () => {});
    const emit = vi.fn(async () => {});
    const requestedModels: string[] = [];

    const mockClient = {
      streamMessage: vi.fn(async (params: { model: string }) => {
        requestedModels.push(params.model);
        if (params.model === 'inconnu') {
          const classified = classifyGatewayError({ status: 404, message: 'model_not_found: Model inconnu not found' });
          throw new OmniRouteError('Model not found', classified, 404);
        }
        return mockSuccess('Réponse de repli après 404');
      }),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'inconnu',
      fallbackModel: 'AC-main',
      system: 'system prompt',
      initialUserMessage: 'salut',
      tools: [],
      maxTokens: 1024,
      reasoningEffort: 'none',
      maxTurns: 3,
      emit,
      warn,
    };

    const result = await runAgentLoop(options);
    expect(result.completion).toBe('completed');
    expect(result.finalText).toBe('Réponse de repli après 404');
    expect(requestedModels).toEqual(['inconnu', 'AC-main']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bascule sur « AC-main »'));
  });

  it('ne bascule pas si aucun fallbackModel n est configuré', async () => {
    const warn = vi.fn(async () => {});
    const emit = vi.fn(async () => {});

    const mockClient = {
      streamMessage: vi.fn(async () => {
        const classified = classifyGatewayError({ status: 503, message: 'Capacity full' });
        throw new OmniRouteError('Service Unavailable', classified, 503);
      }),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'auto/best-coding',
      system: 'system prompt',
      initialUserMessage: 'salut',
      tools: [],
      maxTokens: 1024,
      reasoningEffort: 'none',
      maxTurns: 3,
      emit,
      warn,
    };

    await expect(runAgentLoop(options)).rejects.toThrow('Service Unavailable');
  });

  it('transmet parallel_tool_calls: false quand configuré', () => {
    const payload = buildChatCompletionsPayload({
      model: 'AC-pro-coding',
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read_file', description: 'desc', input_schema: {} }],
      maxTokens: 100,
      reasoningEffort: 'none',
      parallelToolCalls: false,
    });
    expect(payload['parallel_tool_calls']).toBe(false);
  });

  it('omet ou autorise parallel_tool_calls quand configuré à true', () => {
    const payload = buildChatCompletionsPayload({
      model: 'AC-pro-coding',
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read_file', description: 'desc', input_schema: {} }],
      maxTokens: 100,
      reasoningEffort: 'none',
      parallelToolCalls: true,
    });
    expect(payload['parallel_tool_calls']).toBe(true);
  });

  it('déclare le champ parallelToolCalls dans configSchema', () => {
    const field = configSchema.fields.find((f) => f.key === 'parallelToolCalls');
    expect(field).toBeDefined();
    expect(field?.type).toBe('select');
    expect(field?.group).toBe('Modèle');
  });

  it('laisse la boucle s exécuter au-delà de 8 tours sans coupure quand maxTurns: 0 (illimité)', async () => {
    let callCount = 0;
    const mockClient = {
      streamMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount < 12) {
          return {
            content: [{ type: 'tool_use' as const, id: `call_${callCount}`, name: 'step', input: {} }],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
            model: 'AC-pro-coding',
            gatewayHeaders: {},
            costUsd: 0.001,
          };
        }
        return mockSuccess('Travail achevé après 12 tours');
      }),
    };

    const stepTool = {
      spec: { name: 'step', description: 'step', input_schema: {} },
      run: async () => ({ content: 'step done', isError: false }),
    };

    const options: AgentLoopOptions = {
      client: mockClient as never,
      model: 'AC-pro-coding',
      system: 'system prompt',
      initialUserMessage: 'travail long',
      tools: [stepTool],
      maxTokens: 1024,
      reasoningEffort: 'none',
      maxTurns: 0, // illimité
      emit: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
    };

    const result = await runAgentLoop(options);
    expect(result.completion).toBe('completed');
    expect(result.turns).toBe(12);
    expect(result.finalText).toBe('Travail achevé après 12 tours');
  });
});

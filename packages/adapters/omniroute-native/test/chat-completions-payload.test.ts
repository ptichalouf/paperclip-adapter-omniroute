/**
 * Contrat de surface Chat Completions — ACC-2105 / ACC-2112.
 *
 * Ces tests sont le cahier des charges de `buildChatCompletionsPayload` :
 * ils échouent tant que le client parle encore Anthropic Messages, et
 * garantissent que `reasoning_effort` + `cache_control_points` partent bien
 * dans le corps de la requête (c'est tout l'objet d'ACC-2105).
 */
import { describe, expect, it } from 'vitest';

import { buildChatCompletionsPayload, wireMessagesToOpenAi } from '../src/shared/chat-completions.js';

describe('buildChatCompletionsPayload', () => {
  const base = {
    model: 'minimax/minimax-m3',
    system: 'Tu es un agent.',
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Bonjour' }] },
    ],
    tools: [],
    maxTokens: 1024,
    reasoningEffort: 'none' as const,
    cacheControlPoints: undefined as unknown,
  };

  it('cible /v1/chat/completions avec stream et include_usage', () => {
    const payload = buildChatCompletionsPayload(base);
    expect(payload['model']).toBe('minimax/minimax-m3');
    expect(payload['stream']).toBe(true);
    expect(payload['stream_options']).toEqual({ include_usage: true });
    expect(payload['max_tokens']).toBe(1024);
    // Pas de surface Anthropic dans le corps.
    expect(payload['thinking']).toBeUndefined();
    expect(payload['anthropic_version']).toBeUndefined();
  });

  it('place le système en premier message system (pas en champ `system`)', () => {
    const payload = buildChatCompletionsPayload(base);
    const messages = payload['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'Tu es un agent.' });
    expect(payload['system']).toBeUndefined();
  });

  it('émet reasoning_effort quand il est explicite, et l’omet sur none', () => {
    expect(buildChatCompletionsPayload({ ...base, reasoningEffort: 'high' })['reasoning_effort']).toBe('high');
    expect(buildChatCompletionsPayload({ ...base, reasoningEffort: 'medium' })['reasoning_effort']).toBe('medium');
    expect(buildChatCompletionsPayload({ ...base, reasoningEffort: 'low' })['reasoning_effort']).toBe('low');
    expect(buildChatCompletionsPayload({ ...base, reasoningEffort: 'none' })['reasoning_effort']).toBeUndefined();
  });

  it('transmet cache_control_points tel quel quand fourni', () => {
    const points = [{ type: 'prefix', marker: '### Contexte stable' }];
    const payload = buildChatCompletionsPayload({ ...base, cacheControlPoints: points });
    expect(payload['cache_control_points']).toEqual(points);
  });

  it('omet cache_control_points quand absent ou vide', () => {
    expect(buildChatCompletionsPayload(base)['cache_control_points']).toBeUndefined();
    expect(
      buildChatCompletionsPayload({ ...base, cacheControlPoints: [] })['cache_control_points'],
    ).toBeUndefined();
  });

  it('mappe les outils en format function-calling OpenAI', () => {
    const payload = buildChatCompletionsPayload({
      ...base,
      tools: [
        {
          name: 'read_file',
          description: 'Lit un fichier',
          input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    });
    expect(payload['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Lit un fichier',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ]);
  });
});

describe('wireMessagesToOpenAi', () => {
  it('aplatit le texte utilisateur', () => {
    expect(
      wireMessagesToOpenAi([
        { role: 'user', content: [{ type: 'text', text: 'Salut' }, { type: 'text', text: ' toi' }] },
      ]),
    ).toEqual([{ role: 'user', content: 'Salut toi' }]);
  });

  it('rejoue un tour assistant avec tool_calls et rejette le thinking du fil', () => {
    const out = wireMessagesToOpenAi([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Je réfléchis', signature: 'sig' },
          { type: 'text', text: 'Je lis.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'Je lis.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) },
          },
        ],
      },
    ]);
  });

  it('convertit les tool_result en messages role:tool (un par appel)', () => {
    const out = wireMessagesToOpenAi([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'ko', is_error: true },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'tool', tool_call_id: 'call_2', content: 'ko' },
    ]);
  });
});

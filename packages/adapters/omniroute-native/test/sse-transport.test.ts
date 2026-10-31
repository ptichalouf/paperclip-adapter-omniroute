import { describe, expect, it } from 'vitest';

import { projectChunk } from '../src/shared/chat-completions.js';

/**
 * Le transport SSE est le point où un échec peut se déguiser en succès :
 * la réponse HTTP est 200, et l'erreur n'apparaît que dans le corps du flux.
 * Ces tests encodent les trois cas corrigés.
 */
describe('transport SSE — projectChunk', () => {
  it('remonte une erreur émise dans le flux', () => {
    const effects = projectChunk({
      error: { message: 'upstream overloaded', code: 'server_error', type: 'server_error' },
    });

    expect(effects).not.toBeNull();
    expect(effects?.error?.message).toBe('upstream overloaded');
    expect(effects?.error?.code).toBe('server_error');
  });

  it("l'erreur d'un chunk prime sur le contenu du chunk", () => {
    const effects = projectChunk({
      model: 'auto/best-coding',
      choices: [{ delta: { content: 'bonjour' } }],
      error: { message: 'échec fournisseur' },
    });

    expect(effects?.error?.message).toBe('échec fournisseur');
    // Le texte n'est pas projeté : l'erreur doit rester l'information prioritaire.
    expect(effects?.text).toBeUndefined();
  });

  it('ignore un chunk sans information', () => {
    expect(projectChunk({})).toBeNull();
    expect(projectChunk({ choices: [] })).toBeNull();
  });

  it('conserve tous les appels d outils d un même chunk', () => {
    const effects = projectChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
              { index: 1, id: 'call_b', function: { name: 'write_file', arguments: '{"path":"b"}' } },
            ],
          },
        },
      ],
    });

    // Avant, seul le dernier appel était conservé : l'agent perdait un appel
    // sans aucun signe.
    expect(effects?.toolCallDeltas).toHaveLength(2);
    expect(effects?.toolCallDeltas?.map((d) => d.id)).toEqual(['call_a', 'call_b']);
    expect(effects?.toolCallDeltas?.[1]?.name).toBe('write_file');
  });

  it('conserve les fragments d arguments partiels', () => {
    const effects = projectChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { arguments: '{"pa' } }] } }],
    });

    expect(effects?.toolCallDeltas?.[0]?.argumentsFragment).toBe('{"pa');
  });

  it('projette le texte et le raisonnement', () => {
    const effects = projectChunk({
      choices: [{ delta: { content: 'bonjour', reasoning: 'je réfléchis' } }],
    });

    expect(effects?.text).toBe('bonjour');
    expect(effects?.reasoning).toBe('je réfléchis');
  });

  it('projette le finish_reason et l usage', () => {
    const effects = projectChunk({
      choices: [{ finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 8 } },
    });

    expect(effects?.finishReason).toBe('tool_calls');
    expect(effects?.usage?.inputTokens).toBe(100);
    expect(effects?.usage?.outputTokens).toBe(20);
    expect(effects?.usage?.cacheReadTokens).toBe(8);
  });
});

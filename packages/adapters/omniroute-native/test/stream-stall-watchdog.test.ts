/**
 * Lot 18b — flux figé (Paperclip ACC-2301).
 *
 * Avant : un flux SSE qui ne renvoie plus rien (socket muet) ou seulement des
 * keepalives (OmniRoute en envoie pendant qu'un combo essaie ses cibles)
 * bloquait le run jusqu'à son délai global, désormais 1 h.
 * Mesuré 31/10 : les keepalives OmniRoute sont des chunks
 * `{"model":"keepalive","choices":[{"delta":{},"finish_reason":null}]}`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OmniRouteClient, OmniRouteError } from '../src/shared/client.js';

const enc = new TextEncoder();
const keepalive = `data: ${JSON.stringify({ id: 'k', object: 'chat.completion.chunk', created: 0, model: 'keepalive', choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`;
const text = (t: string, model = 'claude-opus-5-5') => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`;
const stop = `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'claude-opus-5-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

/** Flux piloté par un plan : [délai ms, données | null = rester muet à jamais]. */
function plannedStream(plan: Array<[number, string | null]>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [delay, data] of plan) {
        await new Promise((r) => setTimeout(r, delay));
        if (data === null) return; // socket muet, jamais fermé
        controller.enqueue(enc.encode(data));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const params = { model: 'AC-pro-coding', system: '', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }], tools: [], maxTokens: 50, reasoningEffort: 'none' as const };

afterEach(() => vi.unstubAllGlobals());

describe('lot 18b — surveillance d’un flux figé', () => {
  it('socket muet : erreur transitoire après le délai d’inactivité, pas d’attente jusqu’au délai du run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => plannedStream([[5, text('Bon')], [0, null]])));
    const client = new OmniRouteClient({ baseUrl: 'http://x.invalid', apiKey: 'cle-fictive', requestTimeoutMs: 60_000, streamIdleTimeoutMs: 150, streamProgressTimeoutMs: 10_000 });
    const started = Date.now();
    const error = await client.streamMessage(params, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OmniRouteError);
    expect((error as OmniRouteError).classified.retryable).toBe(true);
    expect((error as OmniRouteError).message).toMatch(/inactif|figé/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keepalives seuls : erreur après le délai sans progression', async () => {
    const plan: Array<[number, string | null]> = Array.from({ length: 40 }, () => [20, keepalive] as [number, string]);
    vi.stubGlobal('fetch', vi.fn(async () => plannedStream(plan)));
    const client = new OmniRouteClient({ baseUrl: 'http://x.invalid', apiKey: 'cle-fictive', requestTimeoutMs: 60_000, streamIdleTimeoutMs: 5_000, streamProgressTimeoutMs: 200 });
    const error = await client.streamMessage(params, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OmniRouteError);
    expect((error as OmniRouteError).classified.retryable).toBe(true);
    expect((error as OmniRouteError).message).toMatch(/progression|keepalive/i);
  });

  it('keepalives puis réponse dans les délais : succès, modèle servi réel (pas « keepalive »)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => plannedStream([[10, keepalive], [10, keepalive], [10, text('Bonjour')], [10, stop]])));
    const client = new OmniRouteClient({ baseUrl: 'http://x.invalid', apiKey: 'cle-fictive', requestTimeoutMs: 60_000, streamIdleTimeoutMs: 1_000, streamProgressTimeoutMs: 1_000 });
    const result = await client.streamMessage(params, {});
    expect(result.model).toBe('claude-opus-5-5');
    expect(result.stopReason).toBe('stop');
  });

  it('le dernier chunk est un keepalive : le modèle servi n’est pas « keepalive »', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => plannedStream([[5, text('Oui')], [5, keepalive], [5, stop.replace(/"model":"claude-opus-5-5"/, '"model":"keepalive"')]])));
    const client = new OmniRouteClient({ baseUrl: 'http://x.invalid', apiKey: 'cle-fictive', requestTimeoutMs: 60_000 });
    const result = await client.streamMessage(params, {});
    expect(result.model).toBe('claude-opus-5-5');
  });

  it('valeurs par défaut raisonnables', async () => {
    const mod = await import('../src/shared/client.js');
    expect(mod.DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(mod.DEFAULT_STREAM_PROGRESS_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

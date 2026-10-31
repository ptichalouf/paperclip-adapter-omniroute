import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpHttpClient } from '../src/server/mcp-bridge.js';
import type { AdapterRuntimeMcpServer } from '@paperclipai/adapter-utils';
import { startFakeMcpGateway, type FakeMcpGateway } from './support/fake-mcp-gateway.js';

describe('McpHttpClient', () => {
  let fake: FakeMcpGateway;
  const FAKE_TOKEN = 'secret-mcp-token-xyz-12345';
  const RUN_ID = 'test-run-mcp-999';

  beforeEach(async () => {
    fake = await startFakeMcpGateway();
  });

  afterEach(async () => {
    await fake.close();
  });

  function makeServer(overrides: Partial<AdapterRuntimeMcpServer> = {}): AdapterRuntimeMcpServer {
    return {
      name: 'paperclip-assigned',
      url: fake.url,
      token: FAKE_TOKEN,
      connectionId: 'conn-assigned-1',
      ...overrides,
    };
  }

  it('construit un payload JSON-RPC 2.0 valide avec les en-têtes requis', async () => {
    fake.onRpcMethod('tools/list', (req) => {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: req.body.id,
          result: { tools: [{ name: 'test_tool' }] },
        },
      };
    });

    const client = new McpHttpClient(makeServer(), RUN_ID);
    const result = await client.callRpc<{ tools: Array<{ name: string }> }>('tools/list', { cursor: 'abc' });

    expect(result).toEqual({ tools: [{ name: 'test_tool' }] });
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.httpMethod).toBe('POST');
    expect(req.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['accept']).toBe('application/json');
    expect(req.headers['x-paperclip-run-id']).toBe(RUN_ID);
    expect(req.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { cursor: 'abc' },
    });
  });

  it('incrémente l’ID de requête à chaque appel', async () => {
    fake.onRpcMethod('test/inc', (req) => ({
      status: 200,
      body: { jsonrpc: '2.0', id: req.body.id, result: { idReceived: req.body.id } },
    }));

    const client = new McpHttpClient(makeServer(), RUN_ID);
    const res1 = await client.callRpc<{ idReceived: number }>('test/inc');
    const res2 = await client.callRpc<{ idReceived: number }>('test/inc');

    expect(res1.idReceived).toBe(1);
    expect(res2.idReceived).toBe(2);
  });

  it('gère les notifications JSON-RPC sans ID et accepte HTTP 202', async () => {
    fake.onRpcMethod('notifications/initialized', () => ({
      status: 202,
      rawBody: '',
    }));

    const client = new McpHttpClient(makeServer(), RUN_ID);
    await client.notifyRpc('notifications/initialized');

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.body.jsonrpc).toBe('2.0');
    expect(req.body.id).toBeUndefined();
    expect(req.body.method).toBe('notifications/initialized');
  });

  it('lève une erreur claire en cas d’erreur HTTP (ex: 401, 500)', async () => {
    fake.onRpcMethod('tools/list', () => ({
      status: 401,
      body: { error: 'Unauthorized gateway token' },
    }));

    const client = new McpHttpClient(makeServer(), RUN_ID);
    await expect(client.callRpc('tools/list')).rejects.toThrow(
      /Passerelle MCP \[paperclip-assigned\] erreur HTTP 401/,
    );
  });

  it('détecte et lève les erreurs JSON-RPC renvoyées par la passerelle', async () => {
    fake.onRpcMethod('tools/call', (req) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: req.body.id,
        error: { code: -32602, message: 'Invalid tool arguments' },
      },
    }));

    const client = new McpHttpClient(makeServer(), RUN_ID);
    await expect(client.callRpc('tools/call', { name: 'unknown' })).rejects.toThrow(
      /Erreur JSON-RPC MCP \[paperclip-assigned\] : Invalid tool arguments/,
    );
  });

  it('gère les réponses non-JSON avec une erreur explicite', async () => {
    fake.onRpcMethod('tools/list', () => ({
      status: 200,
      rawBody: '<html><body>Gateway error</body></html>',
    }));

    const client = new McpHttpClient(makeServer(), RUN_ID);
    await expect(client.callRpc('tools/list')).rejects.toThrow(
      /Réponse non-JSON reçue de la passerelle MCP \[paperclip-assigned\]/,
    );
  });

  it('interrompt la requête si AbortSignal est déclenché', async () => {
    fake.onRpcMethod('slow/method', () => ({
      status: 200,
      delayMs: 2000,
      body: { jsonrpc: '2.0', id: 1, result: 'done' },
    }));

    const controller = new AbortController();
    const client = new McpHttpClient(makeServer(), RUN_ID, 30_000, controller.signal);

    setTimeout(() => controller.abort(), 50);

    await expect(client.callRpc('slow/method')).rejects.toThrow(/run interrompu/);
  });

  it('interrompt la requête si le timeout individuel est atteint', async () => {
    fake.onRpcMethod('slow/timeout', () => ({
      status: 200,
      delayMs: 500,
      body: { jsonrpc: '2.0', id: 1, result: 'done' },
    }));

    const client = new McpHttpClient(makeServer(), RUN_ID, 50); // timeout 50ms
    await expect(client.callRpc('slow/timeout')).rejects.toThrow(/délai dépassé/);
  });

  it('masque systématiquement les secrets et tokens dans les erreurs HTTP et réponses', async () => {
    fake.onRpcMethod('auth/fail', () => ({
      status: 403,
      rawBody: `Forbidden: bearer ${FAKE_TOKEN} has expired`,
    }));

    const redactor = (t: string) => t.replaceAll(FAKE_TOKEN, '[REDACTED]');
    const client = new McpHttpClient(makeServer(), RUN_ID, 30_000, undefined, redactor);

    let errorCaught: Error | null = null;
    try {
      await client.callRpc('auth/fail');
    } catch (err) {
      errorCaught = err as Error;
    }

    expect(errorCaught).not.toBeNull();
    expect(errorCaught!.message).toContain('[REDACTED]');
    expect(errorCaught!.message).not.toContain(FAKE_TOKEN);
  });
});

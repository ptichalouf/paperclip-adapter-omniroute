import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedMcpRequest {
  httpMethod: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: any;
}

export interface FakeMcpReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}

export type FakeMcpHandler = FakeMcpReply | ((req: RecordedMcpRequest) => FakeMcpReply | Promise<FakeMcpReply>);

export interface FakeMcpGateway {
  url: string;
  requests: RecordedMcpRequest[];
  onRpcMethod(method: string, reply: FakeMcpHandler): void;
  setFallback(reply: FakeMcpHandler): void;
  close(): Promise<void>;
}

export async function startFakeMcpGateway(): Promise<FakeMcpGateway> {
  const requests: RecordedMcpRequest[] = [];
  const methodHandlers = new Map<string, FakeMcpHandler>();
  let fallbackHandler: FakeMcpHandler = {
    status: 404,
    body: { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } },
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });

    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      let body: any = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      const recorded: RecordedMcpRequest = {
        httpMethod: req.method ?? 'POST',
        path: url.pathname,
        headers: req.headers,
        raw,
        body,
      };
      requests.push(recorded);

      const rpcMethod = typeof body === 'object' && body !== null ? body.method : undefined;
      let handler: FakeMcpHandler | undefined;
      if (rpcMethod && methodHandlers.has(rpcMethod)) {
        handler = methodHandlers.get(rpcMethod);
      } else {
        handler = fallbackHandler;
      }

      const reply: FakeMcpReply = typeof handler === 'function' ? await handler(recorded) : handler ?? {};

      if (reply.delayMs && reply.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      }

      const status = reply.status ?? 200;
      const headers = {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      };

      res.writeHead(status, headers);
      if (reply.rawBody !== undefined) {
        res.end(reply.rawBody);
      } else if (reply.body === undefined) {
        res.end('');
      } else {
        res.end(JSON.stringify(reply.body));
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const gatewayUrl = `http://127.0.0.1:${port}/mcp/gateway`;

  return {
    url: gatewayUrl,
    requests,
    onRpcMethod(method: string, reply: FakeMcpHandler) {
      methodHandlers.set(method, reply);
    },
    setFallback(reply: FakeMcpHandler) {
      fallbackHandler = reply;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}

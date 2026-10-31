/**
 * Passerelle factice scriptée (lot sécurité/solidité).
 *
 * Chaque requête `POST /v1/chat/completions` est confiée à une fonction de
 * script qui décide de la réponse : texte final, appel d'outil, ou erreur
 * HTTP. Les corps reçus sont capturés tels quels pour prouver ce qui part
 * réellement vers le modèle (historique rejoué, sorties d'outils masquées…).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedRequest {
  /** Corps JSON brut reçu. */
  body: { messages?: Array<{ role: string; content: unknown; tool_call_id?: string }>; [key: string]: unknown };
  /** Messages hors système. */
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  /** Corps sérialisé, pour chercher une sous-chaîne. */
  raw: string;
}

export interface ScriptedReply {
  /** Statut HTTP d'erreur ; absent = réponse SSE 200. */
  status?: number;
  error?: { message: string; code?: string };
  text?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
  /** Délai avant la réponse (ms). */
  delayMs?: number;
}

export interface ScriptedGateway {
  server: Server;
  baseUrl: string;
  requests: ScriptedRequest[];
  close(): Promise<void>;
}

export async function startScriptedGateway(
  script: (request: ScriptedRequest, index: number) => ScriptedReply | Promise<ScriptedReply>,
): Promise<ScriptedGateway> {
  const requests: ScriptedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
      void (async () => {
        let body: ScriptedRequest['body'] = {};
        try {
          body = JSON.parse(raw) as ScriptedRequest['body'];
        } catch {
          body = {};
        }
        const request: ScriptedRequest = {
          body,
          messages: (body.messages ?? []).filter((m) => m.role !== 'system'),
          raw,
        };
        const index = requests.length;
        requests.push(request);
        const reply = await script(request, index);
        if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        if (reply.status && reply.status >= 400) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: reply.error ?? { message: 'erreur factice' } }));
          return;
        }
        const usage = reply.usage ?? { prompt_tokens: 100, completion_tokens: 10 };
        const chunks: string[] = [];
        if (reply.toolCalls && reply.toolCalls.length > 0) {
          chunks.push(
            `data: ${JSON.stringify({
              model: 'auto/best-coding',
              choices: [
                {
                  delta: {
                    tool_calls: reply.toolCalls.map((call, i) => ({
                      index: i,
                      id: call.id,
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    })),
                  },
                },
              ],
            })}\n\n`,
          );
          chunks.push(
            `data: ${JSON.stringify({
              model: 'auto/best-coding',
              choices: [{ delta: {}, finish_reason: 'tool_calls' }],
              usage,
            })}\n\n`,
          );
        } else {
          chunks.push(
            `data: ${JSON.stringify({
              model: 'auto/best-coding',
              choices: [{ delta: { content: reply.text ?? 'terminé' }, finish_reason: 'stop' }],
              usage,
            })}\n\n`,
          );
        }
        chunks.push('data: [DONE]\n\n');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(chunks.join(''));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** JWT **fictif** (en-tête, charge et signature inventés), assemblé à l'exécution. */
export function fakeJwt(seed = 'test'): string {
  const b64 = (value: string): string => Buffer.from(value).toString('base64url');
  return [b64('{"alg":"HS256","typ":"JWT"}'), b64(`{"sub":"agent-${seed}","exp":1}`), b64(`signature-fictive-${seed}-000000`)].join('.');
}

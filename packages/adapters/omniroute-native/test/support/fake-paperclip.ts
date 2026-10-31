/**
 * Faux serveur Paperclip pour les tests des outils `paperclip_*` (lot 9).
 *
 * Il enregistre chaque requête (méthode, chemin, query, en-têtes, corps) et
 * répond selon des routes déclarées par le test. Rien ne part vers le vrai
 * Paperclip : les tests prouvent ce que l'outil **envoie réellement**.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedPaperclipRequest {
  method: string;
  /** Chemin sans query (`/api/issues/x`). */
  path: string;
  /** Query brute (sans `?`), chaîne vide si absente. */
  query: string;
  headers: Record<string, string | string[] | undefined>;
  /** Corps JSON décodé, `undefined` si absent. */
  body: unknown;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  raw?: string | Buffer;
  headers?: Record<string, string>;
}

/** Réponse d'une route : valeur fixe ou fonction de la requête. */
export type FakeRoute = FakeReply | ((req: RecordedPaperclipRequest) => FakeReply);

export interface FakePaperclip {
  baseUrl: string;
  requests: RecordedPaperclipRequest[];
  /** Déclare la réponse de `"METHOD /chemin"` (chemin exact, sans query). */
  route(key: string, reply: FakeRoute): void;
  close(): Promise<void>;
}

export async function startFakePaperclip(): Promise<FakePaperclip> {
  const requests: RecordedPaperclipRequest[] = [];
  const routes = new Map<string, FakeRoute>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      let body: unknown;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const recorded: RecordedPaperclipRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const route = routes.get(`${recorded.method} ${recorded.path}`);
      const reply: FakeReply = route === undefined
        ? { status: 404, body: { error: 'API route not found' } }
        : typeof route === 'function' ? route(recorded) : route;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    route: (key, reply) => {
      routes.set(key, reply);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Outils Paperclip directs (lot 9).
 *
 * Constat mesuré (ACC-2278, ACC-2305) : sans outil dédié, l'agent écrit 5 à 11
 * commandes `curl` par run vers l'API Paperclip, avec des en-têtes construits à
 * la main (jeton, `X-Paperclip-Run-Id`), télécharge jusqu'à 3,9 Mo de JSON et
 * passe par des brouillons pour fabriquer les corps. Ces outils typés tournent
 * dans le processus de l'adaptateur et parlent à l'API avec `fetch` :
 *
 * - le jeton de run et le run id sont ajoutés automatiquement à **chaque**
 *   requête ; le jeton n'apparaît jamais dans un résultat ni une erreur
 *   (masquage systématique `[REDACTED]`) ;
 * - les réponses sont réduites aux champs utiles et plafonnées en taille, avec
 *   une mention explicite quand elles sont tronquées ;
 * - `paperclip_deliver` livre document + commentaire + statut en un appel,
 *   séquentiel, arrêté au premier échec avec un rapport de ce qui est fait.
 *
 * Routes : celles du serveur MCP officiel (`packages/mcp-server/src/tools.ts`),
 * vérifiées dans `server/src/routes/issues.ts` et `agents.ts` du conteneur.
 */
import type { ToolResult, WorkspaceTool } from './tools.js';
import {
  buildDecisionCardTools,
  ASK_USER_TOOL_SCHEMA,
  REQUEST_CONFIRMATION_TOOL_SCHEMA,
} from './decision-cards.js';

export {
  buildDecisionCardTools,
  ASK_USER_TOOL_SCHEMA,
  REQUEST_CONFIRMATION_TOOL_SCHEMA,
};

/** Statuts acceptés par le serveur (`ISSUE_STATUSES`, packages/shared/src/constants.ts). */
export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const;
/** Priorités acceptées par le serveur (`ISSUE_PRIORITIES`). */
const ISSUE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
/** Clé de document (`issueDocumentKeySchema`). */
const DOCUMENT_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Plafond d'une sortie d'outil, en caractères (≈ 3k tokens). */
const MAX_OUTPUT_CHARS = 12_000;
/** Fenêtre de lecture d'un corps de document. */
const DOCUMENT_WINDOW_CHARS = 10_000;
/** Fenêtre de lecture d'une pièce jointe texte. */
const ATTACHMENT_WINDOW_CHARS = 10_000;
const ATTACHMENT_MAX_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface PaperclipRuntimeConnectionTools {
  connectionsSearchUrl: string;
  connectionRequestUrl: string;
  bearerToken: string;
}

export interface PaperclipToolsOptions {
  /** `PAPERCLIP_API_URL` (avec ou sans `/api`). */
  apiUrl: string;
  /** JWT de run (`ctx.authToken`). Jamais renvoyé au modèle. */
  apiKey: string;
  runId: string | null;
  agentId: string | null;
  companyId: string | null;
  /** Ticket courant : valeur par défaut de `issueId`. */
  taskId: string | null;
  /** Outils de connexion runtime fournis par l'hôte (`ctx.runtimeTools`). */
  runtimeTools?: PaperclipRuntimeConnectionTools | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Options lues dans l'environnement de mission de l'agent (`agentShellEnv`) :
 * une seule source pour l'URL, l'identité, le run et les jetons.
 */
export function paperclipToolsOptionsFromEnv(
  env: Record<string, string>,
  signal?: AbortSignal,
): PaperclipToolsOptions {
  const value = (key: string): string | null => {
    const raw = env[key];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  };
  const search = value('PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL');
  const request = value('PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL');
  const bearer = value('PAPERCLIP_RUNTIME_TOOLS_TOKEN');
  return {
    apiUrl: value('PAPERCLIP_API_URL') ?? '',
    apiKey: value('PAPERCLIP_API_KEY') ?? '',
    runId: value('PAPERCLIP_RUN_ID'),
    agentId: value('PAPERCLIP_AGENT_ID'),
    companyId: value('PAPERCLIP_COMPANY_ID'),
    taskId: value('PAPERCLIP_TASK_ID'),
    runtimeTools: search && request && bearer
      ? { connectionsSearchUrl: search, connectionRequestUrl: request, bearerToken: bearer }
      : null,
    ...(signal ? { signal } : {}),
  };
}

/** Disponibilité des outils pour le prompt système (sans construire les outils). */
export function paperclipToolsAvailability(options: PaperclipToolsOptions): {
  paperclip: boolean;
  connections: boolean;
} {
  const paperclip = options.apiUrl.length > 0 && options.apiKey.length > 0;
  return { paperclip, connections: Boolean(options.runtimeTools) };
}

/** URL de base de l'API (`…/api`), comme `normalizeApiUrl` du serveur MCP. */
function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

export class PaperclipHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${method} ${path} → HTTP ${status}${detail ? ` : ${detail}` : ''}`);
  }
}

export interface ApiResponse {
  status: number;
  data: unknown;
}

/** Client REST mince : jeton + run id sur chaque requête, erreurs lisibles. */
export class PaperclipRest {
  private readonly base: string;

  constructor(private readonly options: PaperclipToolsOptions) {
    this.base = normalizeApiUrl(options.apiUrl);
  }

  async request(
    method: string,
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | undefined>; allow404?: boolean; rawText?: boolean } = {},
  ): Promise<ApiResponse> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    }
    const suffix = qs.toString();
    const url = `${this.base}${path}${suffix ? `?${suffix}` : ''}`;
    return this.send(url, method, path, this.options.apiKey, init.body, init.allow404, init.rawText);
  }

  /** Requête vers une URL absolue fournie par l'hôte (outils de connexion). */
  async requestAbsolute(url: string, bearer: string, body: unknown): Promise<ApiResponse> {
    return this.send(url, 'POST', new URL(url).pathname, bearer, body, false);
  }

  private async send(
    url: string,
    method: string,
    path: string,
    bearer: string,
    body: unknown,
    allow404 = false,
    rawText = false,
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    };
    if (rawText) headers.Range = `bytes=0-${ATTACHMENT_MAX_BYTES}`;
    if (this.options.runId) headers['X-Paperclip-Run-Id'] = this.options.runId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Message volontairement court : pas de pile, pas d'en-têtes.
      const reason = error instanceof Error && error.name === 'TimeoutError'
        ? 'délai dépassé'
        : error instanceof Error && error.name === 'AbortError'
          ? 'run annulé'
          : 'API Paperclip injoignable';
      throw new Error(`${method} ${path} : échec réseau (${reason})`);
    }
    // Masquage À LA SOURCE (revue A 58189) : un jeton présent dans une réponse
    // est remplacé avant tout découpage, sinon une troncature pouvait laisser
    // un fragment du jeton visible.
    let raw: string;
    if (rawText) {
      const tooLarge = () => new Error(`Pièce jointe refusée : limite ${ATTACHMENT_MAX_BYTES} octets (fichier complet requis pour masquer les secrets)`);
      const range = response.headers.get('content-range');
      if (Number(response.headers.get('content-length')) > ATTACHMENT_MAX_BYTES ||
          (response.status === 206 && (!range || !/^bytes 0-\d+\/\d+$/.test(range) ||
            Number(range.split('/')[1]) > ATTACHMENT_MAX_BYTES ||
            Number(range.split('-')[1]!.split('/')[0]) + 1 !== Number(range.split('/')[1])))) {
        await response.body?.cancel();
        throw tooLarge();
      }
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (response.ok && !(mime.startsWith('text/') || /^application\/(?:json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript)$/.test(mime))) {
        await response.body?.cancel();
        throw new Error('Pièce jointe binaire ou type texte non pris en charge');
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (reader) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > ATTACHMENT_MAX_BYTES) throw tooLarge();
          chunks.push(part.value);
        }
        try {
          raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          throw new Error('Pièce jointe non décodable en UTF-8');
        }
      } finally {
        await reader?.cancel();
        reader?.releaseLock();
      }
      if (/\x00/.test(raw)) throw new Error('Pièce jointe binaire (NUL)');
    } else {
      raw = await response.text();
    }
    const text = redactSecrets(raw, [this.options.apiKey, this.options.runtimeTools?.bearerToken ?? '']);
    let data: unknown = rawText ? text : null;
    if (!rawText && text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok && !(allow404 && response.status === 404)) {
      const detail = data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : typeof data === 'string' ? data : '';
      throw new PaperclipHttpError(response.status, method, path, clip(detail, 500));
    }
    return { status: response.status, data };
  }
}

// ── Masquage des secrets ──────────────────────────────────────────────────

/** Remplace chaque secret (≥ 6 caractères) par [REDACTED]. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/**
 * Chemin d'API sûr pour `paperclip_api_request` (revue A 58189) : relatif à
 * /api, sans `..` même encodé (`%2e%2e`, double encodage), sans barre oblique
 * encodée ni antislash, sans schéma.
 */
export function isSafeApiPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://') || path.includes('\\')) return false;
  let decoded = path;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (/%(?:2e|2f|5c)/i.test(decoded)) return false;
  if (decoded.includes('\\') || decoded.includes('://')) return false;
  return !decoded.split(/[/?#]/).some((segment) => segment === '..' || segment === '.');
}

// ── Mise en forme compacte ────────────────────────────────────────────────

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [tronqué : ${text.length} caractères au total]`;
}

function pick(source: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== '') out[field] = value;
  }
  return out;
}

const ISSUE_FIELDS = [
  'id', 'identifier', 'title', 'status', 'priority', 'workMode', 'assigneeAgentId', 'assigneeUserId',
  'parentId', 'projectId', 'goalId', 'createdAt', 'updatedAt', 'completedAt',
] as const;

function issueSummary(issue: unknown, descriptionChars = 0): Record<string, unknown> {
  const out = pick(issue, ISSUE_FIELDS);
  const description = (issue as { description?: unknown } | null)?.description;
  if (descriptionChars > 0 && typeof description === 'string' && description.length > 0) {
    out['description'] = clip(description, descriptionChars);
  }
  return out;
}

function commentSummary(comment: unknown, bodyChars: number): Record<string, unknown> {
  const out = pick(comment, ['id', 'authorAgentId', 'authorUserId', 'createdAt']);
  const body = (comment as { body?: unknown } | null)?.body;
  if (typeof body === 'string') out['body'] = clip(body, bodyChars);
  return out;
}

function documentSummary(doc: unknown): Record<string, unknown> {
  const out = pick(doc, ['key', 'title', 'latestRevisionNumber', 'latestRevisionId', 'updatedAt']);
  const body = (doc as { body?: unknown; latestBody?: unknown } | null);
  const text = typeof body?.body === 'string' ? body.body : typeof body?.latestBody === 'string' ? body.latestBody : null;
  if (text !== null) out['chars'] = text.length;
  return out;
}

function attachmentSummary(att: unknown): Record<string, unknown> {
  const item = att && typeof att === 'object' ? (att as Record<string, unknown>) : {};
  const out = pick(item, ['id', 'contentType', 'byteSize', 'createdAt']);
  const name = item['fileName'] ?? item['originalFilename'] ?? item['name'];
  if (name !== undefined && name !== null && name !== '') out['fileName'] = name;
  return out;
}

/**
 * Réduit une valeur JSON quelconque : chaînes coupées, tableaux limités,
 * profondeur bornée. Sert à `paperclip_api_request` (forme inconnue).
 */
function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return clip(value, 600);
  if (Array.isArray(value)) {
    const head = value.slice(0, 25).map((item) => shrink(item, depth + 1));
    if (value.length > 25) head.push(`… [tronqué : ${value.length} éléments au total]`);
    return head;
  }
  if (value && typeof value === 'object') {
    if (depth >= 4) return '[objet imbriqué omis]';
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = shrink(item, depth + 1);
    return out;
  }
  return value;
}

/** Sérialise et plafonne la sortie finale. */
function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS - 120)}\n… [sortie tronquée : ${text.length} caractères au total ; affinez la requête (limit, filtres)]`;
}

// ── Lecture des arguments ────────────────────────────────────────────────

export class InputError extends Error {}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function optString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InputError(`« ${key} » doit être une chaîne`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function reqString(input: Record<string, unknown>, key: string): string {
  const value = optString(input, key);
  if (value === undefined) throw new InputError(`« ${key} » est requis`);
  return value;
}

/** Corps de texte : conservé tel quel (pas de trim des sauts de ligne). */
function reqText(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new InputError(`« ${key} » est requis (texte non vide)`);
  return value;
}

function optInt(input: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < min) throw new InputError(`« ${key} » doit être un entier ≥ ${min}`);
  return Math.min(n, max);
}

function optEnum<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = optString(input, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InputError(`« ${key} » invalide (« ${value} ») ; valeurs possibles : ${allowed.join(', ')}`);
  }
  return value as T;
}

function documentKey(input: Record<string, unknown>): string {
  const key = reqString(input, 'key').toLowerCase();
  if (key.length > 64 || !DOCUMENT_KEY_RE.test(key)) {
    throw new InputError(`clé de document invalide « ${key} » : minuscules, chiffres, _ ou -, 64 caractères max (ex. plan, analyse)`);
  }
  return key;
}

const enc = encodeURIComponent;

// ── Construction des outils ──────────────────────────────────────────────

const ISSUE_ID_PROP = {
  type: 'string',
  description: 'UUID ou identifiant (ACC-123) du ticket. Défaut : le ticket courant.',
};

/**
 * Construit les outils `paperclip_*` (et les outils de connexion quand l'hôte
 * les fournit). Sans URL d'API ou sans jeton de run : aucun outil.
 */
export function buildPaperclipTools(options: PaperclipToolsOptions): WorkspaceTool[] {
  if (!paperclipToolsAvailability(options).paperclip) return [];
  const api = new PaperclipRest(options);
  const secrets = [options.apiKey, options.runtimeTools?.bearerToken ?? '']
    .filter((secret) => secret.length >= 6);

  const redact = (text: string): string => redactSecrets(text, secrets);

  const issueIdOf = (input: Record<string, unknown>): string => {
    const issueId = optString(input, 'issueId') ?? options.taskId ?? undefined;
    if (!issueId) throw new InputError('« issueId » est requis : aucun ticket courant dans ce run');
    return issueId;
  };

  /** Enveloppe commune : erreurs en résultat `isError`, masquage du jeton. */
  const tool = (
    spec: WorkspaceTool['spec'],
    handler: (input: Record<string, unknown>) => Promise<unknown>,
  ): WorkspaceTool => ({
    spec,
    async run(input: unknown): Promise<ToolResult> {
      try {
        const value = await handler(record(input));
        // Masquer AVANT de tronquer (revue A 58189).
        return { content: render(redact(typeof value === 'string' ? value : JSON.stringify(value))), isError: false };
      } catch (error) {
        return { content: redact(describeError(spec.name, error)), isError: true };
      }
    },
  });

  /** Écrit un document en résolvant la dernière révision si besoin. */
  const writeDocument = async (
    issueId: string,
    key: string,
    fields: { title?: string; body: string; changeSummary?: string; baseRevisionId?: string },
  ): Promise<{ created: boolean; revision: unknown; replacedRevision: string | null }> => {
    let baseRevisionId = fields.baseRevisionId;
    if (!baseRevisionId) {
      const current = await api.request('GET', `/issues/${enc(issueId)}/documents/${enc(key)}`, { allow404: true });
      const latest = current.status === 404 ? null : (current.data as { latestRevisionId?: unknown } | null)?.latestRevisionId;
      if (typeof latest === 'string' && latest.length > 0) baseRevisionId = latest;
    }
    const body: Record<string, unknown> = { format: 'markdown' };
    if (fields.title !== undefined) body['title'] = fields.title;
    body['body'] = fields.body;
    if (fields.changeSummary !== undefined) body['changeSummary'] = fields.changeSummary;
    if (baseRevisionId) body['baseRevisionId'] = baseRevisionId;
    const saved = await api.request('PUT', `/issues/${enc(issueId)}/documents/${enc(key)}`, { body });
    const doc = saved.data as { latestRevisionNumber?: unknown } | null;
    return {
      created: saved.status === 201,
      revision: doc?.latestRevisionNumber ?? null,
      replacedRevision: baseRevisionId ?? null,
    };
  };

  const tools: WorkspaceTool[] = [
    tool(
      {
        name: 'paperclip_get_issue',
        description:
          'Lit un ticket Paperclip (défaut : le ticket courant) : champs utiles, 5 derniers commentaires, liste des documents.',
        input_schema: { type: 'object', properties: { issueId: ISSUE_ID_PROP } },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const [issue, comments, documents] = await Promise.allSettled([
          api.request('GET', `/issues/${enc(issueId)}`),
          api.request('GET', `/issues/${enc(issueId)}/comments`, { query: { order: 'desc', limit: 5 } }),
          api.request('GET', `/issues/${enc(issueId)}/documents`),
        ]);
        if (issue.status === 'rejected') throw issue.reason;
        return {
          issue: issueSummary(issue.value.data, 4000),
          recentComments: comments.status === 'fulfilled' && Array.isArray(comments.value.data)
            ? comments.value.data.map((c) => commentSummary(c, 1200))
            : `indisponible (${comments.status === 'rejected' ? errorText(comments.reason) : 'réponse inattendue'})`,
          documents: documents.status === 'fulfilled' && Array.isArray(documents.value.data)
            ? documents.value.data.map(documentSummary)
            : `indisponible (${documents.status === 'rejected' ? errorText(documents.reason) : 'réponse inattendue'})`,
        };
      },
    ),
    tool(
      {
        name: 'paperclip_list_comments',
        description: 'Liste les commentaires d’un ticket (défaut : 20 plus récents d’abord ; « after » = id de commentaire pour la suite).',
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
            limit: { type: 'integer', description: '1 à 100 (défaut 20).' },
            order: { type: 'string', enum: ['desc', 'asc'] },
            after: { type: 'string', description: 'Id du commentaire après lequel reprendre.' },
          },
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const limit = optInt(input, 'limit', 1, 100) ?? 20;
        const order = optEnum(input, 'order', ['desc', 'asc'] as const) ?? 'desc';
        const after = optString(input, 'after');
        const res = await api.request('GET', `/issues/${enc(issueId)}/comments`, { query: { after, order, limit } });
        const list = Array.isArray(res.data) ? res.data : [];
        return { count: list.length, comments: list.map((c) => commentSummary(c, 2000)) };
      },
    ),
    tool(
      {
        name: 'paperclip_add_comment',
        description: 'Publie un commentaire markdown sur un ticket (défaut : le ticket courant).',
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
            body: { type: 'string', description: 'Texte markdown du commentaire.' },
            resume: { type: 'boolean', description: 'true pour relancer volontairement un ticket fermé.' },
          },
          required: ['body'],
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const body: Record<string, unknown> = { body: reqText(input, 'body') };
        if (input['resume'] === true) body['resume'] = true;
        const res = await api.request('POST', `/issues/${enc(issueId)}/comments`, { body });
        return { ok: true, comment: pick(res.data, ['id', 'createdAt']) };
      },
    ),
    tool(
      {
        name: 'paperclip_update_issue',
        description:
          `Modifie un ticket (PATCH) : statut (${ISSUE_STATUSES.join('|')}), commentaire joint, priorité, assignation, titre.`,
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
            status: { type: 'string', enum: [...ISSUE_STATUSES] },
            comment: { type: 'string', description: 'Commentaire markdown publié avec la modification.' },
            priority: { type: 'string', enum: [...ISSUE_PRIORITIES] },
            assigneeAgentId: { type: 'string' },
            title: { type: 'string' },
            resume: { type: 'boolean' },
          },
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const body: Record<string, unknown> = {};
        const status = optEnum(input, 'status', ISSUE_STATUSES);
        if (status) body['status'] = status;
        if (typeof input['comment'] === 'string' && input['comment'].trim().length > 0) body['comment'] = input['comment'];
        const priority = optEnum(input, 'priority', ISSUE_PRIORITIES);
        if (priority) body['priority'] = priority;
        const assignee = optString(input, 'assigneeAgentId');
        if (assignee) body['assigneeAgentId'] = assignee;
        const title = optString(input, 'title');
        if (title) body['title'] = title;
        if (input['resume'] === true) body['resume'] = true;
        if (Object.keys(body).length === 0) throw new InputError('aucune modification demandée');
        const res = await api.request('PATCH', `/issues/${enc(issueId)}`, { body });
        return { ok: true, issue: issueSummary(res.data) };
      },
    ),
    tool(
      {
        name: 'paperclip_list_documents',
        description: 'Liste les documents d’un ticket (clé, titre, révision, taille), sans leur contenu.',
        input_schema: { type: 'object', properties: { issueId: ISSUE_ID_PROP } },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const res = await api.request('GET', `/issues/${enc(issueId)}/documents`);
        return Array.isArray(res.data) ? res.data.map(documentSummary) : shrink(res.data);
      },
    ),
    tool(
      {
        name: 'paperclip_get_document',
        description: `Lit un document de ticket par clé (corps par fenêtres de ${DOCUMENT_WINDOW_CHARS} caractères ; « offset » pour la suite).`,
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
            key: { type: 'string', description: 'Clé du document (ex. plan).' },
            offset: { type: 'integer', description: 'Caractère de départ (défaut 0).' },
          },
          required: ['key'],
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const key = documentKey(input);
        const offset = optInt(input, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0;
        const res = await api.request('GET', `/issues/${enc(issueId)}/documents/${enc(key)}`);
        const doc = res.data as { body?: unknown } | null;
        const body = typeof doc?.body === 'string' ? doc.body : '';
        const end = Math.min(body.length, offset + DOCUMENT_WINDOW_CHARS);
        const meta = pick(res.data, ['key', 'title', 'format', 'latestRevisionId', 'latestRevisionNumber', 'updatedAt']);
        const window = end < body.length
          ? `[caractères ${offset}-${end} sur ${body.length} — suite avec offset=${end}]`
          : offset > 0 ? `[caractères ${offset}-${end} sur ${body.length} — fin]` : '';
        return `${JSON.stringify(meta)}\n${window ? `${window}\n` : ''}---\n${body.slice(offset, end)}`;
      },
    ),
    tool(
      {
        name: 'paperclip_write_document',
        description:
          'Crée ou remplace un document markdown de ticket. Sans baseRevisionId, la dernière révision est reprise automatiquement.',
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
            key: { type: 'string', description: 'Clé : minuscules, chiffres, _ ou - (ex. plan, analyse).' },
            title: { type: 'string' },
            body: { type: 'string', description: 'Contenu markdown complet.' },
            changeSummary: { type: 'string' },
            baseRevisionId: { type: 'string', description: 'Révision lue, pour refuser une écriture concurrente.' },
          },
          required: ['key', 'body'],
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const key = documentKey(input);
        const saved = await writeDocument(issueId, key, {
          title: optString(input, 'title'),
          body: reqText(input, 'body'),
          changeSummary: optString(input, 'changeSummary'),
          baseRevisionId: optString(input, 'baseRevisionId'),
        });
        return { ok: true, key, created: saved.created, revisionNumber: saved.revision };
      },
    ),
    tool(
      {
        name: 'paperclip_create_subtask',
        description: 'Crée une sous-tâche (défaut : enfant du ticket courant ; projet et objectif hérités du parent).',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string', description: 'Brief markdown.' },
            parentId: { type: 'string', description: 'UUID du parent. Défaut : ticket courant.' },
            assigneeAgentId: { type: 'string' },
            priority: { type: 'string', enum: [...ISSUE_PRIORITIES] },
            status: { type: 'string', enum: [...ISSUE_STATUSES] },
          },
          required: ['title'],
        },
      },
      async (input) => {
        if (!options.companyId) throw new InputError('entreprise inconnue (PAPERCLIP_COMPANY_ID absent)');
        const parentId = optString(input, 'parentId') ?? options.taskId ?? undefined;
        const body: Record<string, unknown> = { title: reqString(input, 'title') };
        if (typeof input['description'] === 'string' && input['description'].trim().length > 0) {
          body['description'] = input['description'];
        }
        if (parentId) body['parentId'] = parentId;
        const assignee = optString(input, 'assigneeAgentId');
        if (assignee) body['assigneeAgentId'] = assignee;
        const priority = optEnum(input, 'priority', ISSUE_PRIORITIES);
        if (priority) body['priority'] = priority;
        const status = optEnum(input, 'status', ISSUE_STATUSES);
        if (status) body['status'] = status;
        const res = await api.request('POST', `/companies/${enc(options.companyId)}/issues`, { body });
        return { ok: true, issue: issueSummary(res.data) };
      },
    ),
    tool(
      {
        name: 'paperclip_list_my_issues',
        description: 'Liste les tickets assignés à cet agent, filtrés côté serveur (défaut : todo,in_progress,blocked ; 50 max).',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Statuts séparés par des virgules.' },
            limit: { type: 'integer', description: '1 à 200 (défaut 50).' },
          },
        },
      },
      async (input) => {
        if (!options.companyId || !options.agentId) throw new InputError('identité de l’agent inconnue');
        const status = optString(input, 'status') ?? 'todo,in_progress,blocked';
        for (const item of status.split(',')) {
          if (!(ISSUE_STATUSES as readonly string[]).includes(item.trim())) {
            throw new InputError(`statut inconnu « ${item.trim()} » ; valeurs possibles : ${ISSUE_STATUSES.join(', ')}`);
          }
        }
        const limit = optInt(input, 'limit', 1, 200) ?? 50;
        const res = await api.request('GET', `/companies/${enc(options.companyId)}/issues`, {
          query: { assigneeAgentId: options.agentId, status, limit, view: 'compact' },
        });
        const list = Array.isArray(res.data) ? res.data : [];
        return { count: list.length, issues: list.map((i) => issueSummary(i)) };
      },
    ),
    tool(
      {
        name: 'paperclip_api_request',
        description:
          'Appelle une autre route de l’API Paperclip (chemin relatif à /api, ex. /issues/ACC-1/heartbeat-context). Jeton et run id ajoutés ; réponse réduite. DELETE refusé.',
        input_schema: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT'] },
            path: { type: 'string' },
            body: { type: 'object', description: 'Corps JSON (POST/PATCH/PUT).' },
          },
          required: ['method', 'path'],
        },
      },
      async (input) => {
        const method = optEnum(input, 'method', ['GET', 'POST', 'PATCH', 'PUT'] as const);
        if (!method) throw new InputError('« method » est requis');
        let path = reqString(input, 'path');
        if (!isSafeApiPath(path) || path.includes('..')) {
          throw new InputError('« path » doit être un chemin relatif à /api, commençant par / et sans « .. »');
        }
        if (path === '/api' || path.startsWith('/api/')) path = path.slice(4) || '/';
        const [pathname, search = ''] = path.split('?', 2) as [string, string?];
        const query = Object.fromEntries(new URLSearchParams(search));
        const body = method === 'GET' ? undefined : input['body'] ?? {};
        const res = await api.request(method, pathname, { body, query });
        return { status: res.status, data: shrink(res.data) };
      },
    ),
    tool(
      {
        name: 'paperclip_deliver',
        description:
          'Livre en un appel : document (optionnel), puis commentaire, avec statut (optionnel, même requête que le commentaire). S’arrête au premier échec et dit ce qui est fait ou non.',
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
            document: {
              type: 'object',
              description: '{key, title?, body, changeSummary?} — lien ajouté au commentaire.',
              properties: {
                key: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
                changeSummary: { type: 'string' },
              },
              required: ['key', 'body'],
            },
            comment: { type: 'string', description: 'Commentaire markdown de livraison.' },
            status: { type: 'string', enum: [...ISSUE_STATUSES] },
          },
          required: ['comment'],
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        let comment = reqText(input, 'comment');
        const status = optEnum(input, 'status', ISSUE_STATUSES);
        const docInput = input['document'] === undefined || input['document'] === null ? null : record(input['document']);
        const docKey = docInput ? documentKey(docInput) : null;
        const docBody = docInput ? reqText(docInput, 'body') : null;

        const commentStep = status ? `commentaire + statut « ${status} » (PATCH)` : 'commentaire (POST)';
        const planned = [...(docKey ? [`document « ${docKey} »`] : []), commentStep];
        const done: string[] = [];
        const fail = (step: string, error: unknown): never => {
          const rest = planned.slice(done.length + 1);
          throw new DeliverError([
            `paperclip_deliver — ticket ${issueId}`,
            ...done.map((line) => `FAIT : ${line}`),
            `NON FAIT (échec) : ${step} — ${errorText(error)}`,
            ...rest.map((line) => `NON FAIT (séquence arrêtée) : ${line}`),
            done.length === 0 ? 'Rien n’a été modifié.' : 'Les étapes FAIT sont enregistrées : ne les refaites pas.',
          ].join('\n'));
        };

        if (docKey && docInput && docBody !== null) {
          try {
            const saved = await writeDocument(issueId, docKey, {
              title: optString(docInput, 'title'),
              body: docBody,
              changeSummary: optString(docInput, 'changeSummary'),
            });
            done.push(`document « ${docKey} » ${saved.created ? 'créé' : 'mis à jour'} (révision ${String(saved.revision ?? '?')})`);
          } catch (error) {
            fail(planned[0] ?? 'document', error);
          }
          if (!comment.includes(`#document-${docKey}`)) {
            const link = await documentLink(api, issueId, docKey);
            if (link) {
              const title = optString(docInput, 'title') ?? docKey;
              comment = `${comment.trimEnd()}\n\nDocument : [${title}](${link})`;
            }
          }
        }

        try {
          if (status) {
            const res = await api.request('PATCH', `/issues/${enc(issueId)}`, { body: { status, comment } });
            const finalStatus = (res.data as { status?: unknown } | null)?.status;
            done.push(`commentaire publié et statut → ${String(finalStatus ?? status)}`);
          } else {
            await api.request('POST', `/issues/${enc(issueId)}/comments`, { body: { body: comment } });
            done.push('commentaire publié');
          }
        } catch (error) {
          fail(commentStep, error);
        }
        return [`paperclip_deliver — ticket ${issueId}`, ...done.map((line) => `FAIT : ${line}`)].join('\n');
      },
    ),
    tool(
      {
        name: 'paperclip_request_approval',
        description:
          'Crée une approbation humaine liée au ticket, ou associe approvalId.',
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
            approvalId: {
              type: 'string',
              description: 'UUID existant à associer.',
            },
            type: {
              type: 'string',
              enum: ['action', 'deployment', 'budget', 'access', 'general'],
            },
            description: {
              type: 'string',
              minLength: 1,
            },
            payload: {
              type: 'object',
            },
          },
          anyOf: ['approvalId', 'description'].map((key) => ({
            type: 'object', properties: { [key]: { type: 'string', minLength: 1 } }, required: [key],
          })),
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const approvalId = optString(input, 'approvalId');
        if (approvalId) {
          const res = await api.request('POST', `/issues/${enc(issueId)}/approvals`, {
            body: { approvalId },
          });
          const list = Array.isArray(res.data) ? res.data : [res.data];
          const matched = list.find((a: unknown) => (a as { id?: unknown })?.id === approvalId) ?? list[0] ?? res.data;
          return { ok: true, approval: pick(matched, ['id', 'status', 'type', 'createdAt']) };
        }
        const description = reqText(input, 'description');
        const rawType = optString(input, 'type') ?? 'general';
        const payload = input['payload'] && typeof input['payload'] === 'object' ? (input['payload'] as Record<string, unknown>) : undefined;
        const body: Record<string, unknown> = {
          type: rawType,
          description,
        };
        if (payload) body['payload'] = payload;

        try {
          const res = await api.request('POST', `/issues/${enc(issueId)}/approvals`, { body });
          const data = Array.isArray(res.data) ? res.data[0] : res.data;
          return { ok: true, approval: pick(data, ['id', 'status', 'type', 'createdAt']) };
        } catch (error) {
          if (error instanceof PaperclipHttpError && error.status === 400 && options.companyId) {
            const mappedType = ['hire_agent', 'approve_ceo_strategy', 'budget_override_required', 'request_board_approval'].includes(rawType)
              ? rawType
              : rawType === 'budget' ? 'budget_override_required' : 'request_board_approval';
            const resolved = /^[A-Z][A-Z0-9]*-\d+$/i.test(issueId)
              ? await api.request('GET', `/issues/${enc(issueId)}`) : null;
            const linkedIssueId = resolved ? reqString(resolved.data as Record<string, unknown>, 'id') : issueId;
            const companyRes = await api.request('POST', `/companies/${enc(options.companyId)}/approvals`, {
              body: {
                type: mappedType,
                payload: { description, ...(payload ?? {}) },
                issueIds: [linkedIssueId],
              },
            });
            return { ok: true, approval: pick(companyRes.data, ['id', 'status', 'type', 'createdAt']) };
          }
          throw error;
        }
      },
    ),
    tool(
      {
        name: 'paperclip_get_approval',
        description: 'Lit le statut et la décision d’une approbation.',
        input_schema: {
          type: 'object',
          properties: {
            approvalId: { type: 'string' },
          },
          required: ['approvalId'],
        },
      },
      async (input) => {
        const approvalId = reqString(input, 'approvalId');
        const res = await api.request('GET', `/approvals/${enc(approvalId)}`);
        return pick(res.data, ['id', 'status', 'type', 'decision', 'decisionNote', 'decidedAt', 'decidedByUserId', 'createdAt']);
      },
    ),
    tool(
      {
        name: 'paperclip_list_attachments',
        description: 'Liste les pièces jointes : ID, nom, MIME, taille.',
        input_schema: {
          type: 'object',
          properties: {
            issueId: ISSUE_ID_PROP,
          },
        },
      },
      async (input) => {
        const issueId = issueIdOf(input);
        const res = await api.request('GET', `/issues/${enc(issueId)}/attachments`);
        const list = Array.isArray(res.data) ? res.data : [];
        return {
          count: list.length,
          attachments: list.map(attachmentSummary),
        };
      },
    ),
    tool(
      {
        name: 'paperclip_get_attachment_text',
        description:
          `Lit du texte UTF-8 ≤256Kio, fenêtres ${ATTACHMENT_WINDOW_CHARS} caractères après masquage ; offset pour la suite.`,
        input_schema: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string' },
            offset: { type: 'integer', description: 'Caractère de départ (0).' },
          },
          required: ['attachmentId'],
        },
      },
      async (input) => {
        const attachmentId = reqString(input, 'attachmentId');
        const offset = optInt(input, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0;
        const res = await api.request('GET', `/attachments/${enc(attachmentId)}/content`, { rawText: true });
        const text = res.data as string;
        const end = Math.min(text.length, offset + ATTACHMENT_WINDOW_CHARS);
        const window = end < text.length
          ? `[caractères ${offset}-${end} sur ${text.length} — suite avec offset=${end}]`
          : offset > 0 ? `[caractères ${offset}-${end} sur ${text.length} — fin]` : '';
        return `${window ? `${window}\n` : ''}---\n${text.slice(offset, end)}`;
      },
    ),
  ];

  const runtime = options.runtimeTools;
  if (runtime) {
    tools.push(
      tool(
        {
          name: 'connections_search',
          description:
            'Cherche une connexion de service (nom ou capacité) pour cet agent ; suivre l’« instruction » renvoyée. Lecture seule.',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              retryProviderChoice: { type: 'boolean', description: 'Seulement si l’utilisateur demande de revoir un choix.' },
            },
            required: ['query'],
          },
        },
        async (input) => {
          const body: Record<string, unknown> = { query: reqString(input, 'query') };
          if (typeof input['retryProviderChoice'] === 'boolean') body['retryProviderChoice'] = input['retryProviderChoice'];
          const res = await api.requestAbsolute(runtime.connectionsSearchUrl, runtime.bearerToken, body);
          return shrink(res.data);
        },
      ),
      tool(
        {
          name: 'connection_request',
          description:
            'Demande l’accès à un service renvoyé par connections_search (crée la carte de connexion pour l’humain). Ne pas relancer en boucle.',
          input_schema: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              connectionId: { type: 'string' },
              toolNames: { type: 'array', items: { type: 'string' } },
              selectionInteractionId: { type: 'string' },
              targetService: { type: 'string' },
            },
            required: ['service'],
          },
        },
        async (input) => {
          const body: Record<string, unknown> = { service: reqString(input, 'service') };
          for (const key of ['connectionId', 'selectionInteractionId', 'targetService']) {
            const value = optString(input, key);
            if (value) body[key] = value;
          }
          if (Array.isArray(input['toolNames'])) body['toolNames'] = input['toolNames'];
          const res = await api.requestAbsolute(runtime.connectionRequestUrl, runtime.bearerToken, body);
          return shrink(res.data);
        },
      ),
    );
  }
  tools.push(...buildDecisionCardTools(options, api));
  return tools;
}

export class DeliverError extends Error {}

/** Lien UI d'un document : `/<préfixe>/issues/<identifiant>#document-<clé>`. */
async function documentLink(api: PaperclipRest, issueId: string, key: string): Promise<string | null> {
  let identifier = /^[A-Z][A-Z0-9]*-\d+$/.test(issueId) ? issueId : null;
  if (!identifier) {
    try {
      const res = await api.request('GET', `/issues/${enc(issueId)}`);
      const value = (res.data as { identifier?: unknown } | null)?.identifier;
      identifier = typeof value === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(value) ? value : null;
    } catch {
      identifier = null;
    }
  }
  if (!identifier) return null;
  const prefix = identifier.slice(0, identifier.lastIndexOf('-'));
  return `/${prefix}/issues/${identifier}#document-${key}`;
}

export function errorText(error: unknown): string {
  if (error instanceof PaperclipHttpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function describeError(toolName: string, error: unknown): string {
  if (error instanceof DeliverError) return error.message;
  if (error instanceof InputError) return `Arguments refusés pour ${toolName} : ${error.message}. Rien n’a été envoyé.`;
  return `Échec de ${toolName} : ${errorText(error)}`;
}

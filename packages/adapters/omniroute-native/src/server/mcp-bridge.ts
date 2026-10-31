/**
 * Pont MCP natif et outils virtuels pour l'adaptateur omniroute_native (v1.1).
 *
 * Implémentation conforme aux spécifications :
 * - JSON-RPC 2.0 sur HTTP POST natif (fetch, AbortSignal, crypto).
 * - Outils virtuels mcp_search_tools et mcp_run_tool invariants (préservation cache).
 * - Masquage systématique des secrets à la source.
 */
import type { AdapterRuntimeMcpServer } from '@paperclipai/adapter-utils';
import type { ToolResult, WorkspaceTool } from './tools.js';
import type { WireToolSpec } from '../shared/client.js';

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export const MAX_MCP_OUTPUT_CHARS = 24_000;

/**
 * Enveloppes virtuelles de la passerelle : ce sont des POINTEURS vers d'autres
 * outils, jamais des cibles. Elles ne sont donc jamais listées comme outils
 * exécutables et ne sont jamais résolues comme telles.
 */
const VIRTUAL_ENVELOPE_TOOLS = new Set(['search_tools', 'run_tool']);

export interface McpBridgeOptions {
  servers: AdapterRuntimeMcpServer[];
  runId: string;
  agentId: string;
  companyId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  redactSecrets?: (text: string) => string;
}

export interface DiscoveredMcpTool {
  serverName: string;
  name: string;
  displayName?: string;
  description?: string;
  parametersSchema: Record<string, unknown>;
  risk?: 'read' | 'write';
}

/** Comment un outil cible est exécuté sur son serveur. */
export type McpToolMode = 'direct' | 'virtual';

/** Cible d'exécution résolue pour un nom d'outil. */
export interface McpToolTarget {
  serverName: string;
  toolName: string;
  /**
   * - `direct` : `tools/call { name: <cible> }` — l'outil est listé par le
   *   serveur et s'exécute lui-même.
   * - `virtual` : `tools/call { name: 'run_tool', arguments: { tool } }` — la
   *   cible est un outil « on-demand remote » que seul `run_tool` sait lancer.
   */
  mode: McpToolMode;
}

/** Résultat de la résolution d'un nom d'outil. */
export type McpToolResolution =
  | { kind: 'resolved'; target: McpToolTarget }
  | { kind: 'ambiguous'; toolName: string; serverNames: string[] }
  | { kind: 'unknown'; toolName: string; serverHint?: string };


/** Client HTTP JSON-RPC 2.0 léger pour passerelle MCP Paperclip. */
export class McpHttpClient {
  private requestId = 0;

  constructor(
    readonly server: AdapterRuntimeMcpServer,
    readonly runId: string,
    readonly timeoutMs: number = DEFAULT_MCP_TIMEOUT_MS,
    readonly signal?: AbortSignal,
    readonly redactor: (text: string) => string = (t) => t,
  ) {}

  async notifyRpc(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.sendRequest(method, params, false);
  }

  async callRpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requestId += 1;
    const currentId = this.requestId;
    const result = await this.sendRequest(method, params, true, currentId);
    return result as T;
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    isCall: boolean,
    id?: number,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
    };
    if (isCall && id !== undefined) {
      body.id = id;
    }
    if (params !== undefined) {
      body.params = params;
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(this.server.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.server.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Paperclip-Run-Id': this.runId,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError'
        ? `délai dépassé (${Math.round(this.timeoutMs / 1000)}s)`
        : error instanceof Error && error.name === 'AbortError'
          ? 'run interrompu'
          : 'passerelle MCP injoignable';
      throw new Error(`Échec MCP [${this.server.name}] ${method} : ${reason}`);
    }

    const rawText = await response.text();
    const cleanText = this.redactor(rawText);

    if (!response.ok) {
      throw new Error(
        `Passerelle MCP [${this.server.name}] erreur HTTP ${response.status} : ${cleanText.slice(0, 300)}`,
      );
    }

    if (cleanText.trim().length === 0) {
      return undefined;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(cleanText);
    } catch {
      throw new Error(`Réponse non-JSON reçue de la passerelle MCP [${this.server.name}]`);
    }

    if (parsed && typeof parsed === 'object' && parsed.error) {
      const message = typeof parsed.error.message === 'string'
        ? parsed.error.message
        : JSON.stringify(parsed.error);
      throw new Error(`Erreur JSON-RPC MCP [${this.server.name}] : ${message}`);
    }

    return parsed?.result;
  }
}

/** Pont et registre d'outils MCP. */
export class McpBridge {
  private clients: Map<string, McpHttpClient> = new Map();
  private catalog: DiscoveredMcpTool[] = [];
  private initialized = false;
  private virtualServers: Set<string> = new Set();
  /** Outil dynamique -> serveurs virtuels qui l'exposent (plusieurs possibles). */
  private dynamicTools: Map<string, string[]> = new Map();
  /** Serveur -> noms d'outils qui sont des enveloppes virtuelles (pas des cibles). */
  private envelopeTools: Map<string, Set<string>> = new Map();

  constructor(private readonly options: McpBridgeOptions) {
    for (const server of options.servers) {
      this.clients.set(
        server.name,
        new McpHttpClient(
          server,
          options.runId,
          options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
          options.signal,
          options.redactSecrets ?? ((t) => t),
        ),
      );
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  hasNativeVirtualTools(serverName?: string): boolean {
    if (serverName) {
      return this.virtualServers.has(serverName);
    }
    return this.virtualServers.size > 0;
  }

  getDynamicToolServer(toolName: string): string | undefined {
    return this.dynamicTools.get(toolName)?.[0];
  }

  /** Serveurs virtuels exposant un outil dynamique (déduit via `search_tools`). */
  getDynamicToolServers(toolName: string): string[] {
    return [...(this.dynamicTools.get(toolName) ?? [])];
  }

  getCatalog(): DiscoveredMcpTool[] {
    return [...this.catalog];
  }

  getClient(name: string): McpHttpClient | undefined {
    return this.clients.get(name);
  }

  getDefaultClient(): McpHttpClient | undefined {
    return this.clients.values().next().value;
  }

  async ensureDiscovered(): Promise<void> {
    if (this.initialized) return;

    for (const [serverName, client] of this.clients.entries()) {
      try {
        // Handshake initialize MCP selon la spécification officielle.
        // Non-bloquant : si la passerelle cible (ex: Tool Gateway Paperclip) ne supporte pas
        // initialize ou n'autorise que tools/list & tools/call, on n'échoue pas la découverte.
        try {
          await client.callRpc('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'omniroute-native-mcp', version: '1.1.0' },
          });

          await client.notifyRpc('notifications/initialized', {});
        } catch {
          // Handshake initialize ignoré si non supporté ou refusé par la passerelle
        }

        const listResult = await client.callRpc<{ tools?: Array<Record<string, unknown>> }>('tools/list', {});
        const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];

        const hasSearch = tools.some((t) => t.name === 'search_tools');
        const hasRun = tools.some((t) => t.name === 'run_tool');
        if (hasSearch && hasRun) {
          this.virtualServers.add(serverName);
        }

        // Les enveloppes virtuelles sont des POINTEURS, pas des cibles : on
        // les mémorise par serveur pour ne jamais les résoudre comme
        // exécutables (R1).
        const envelopes = new Set<string>();
        for (const t of tools) {
          const name = String(t.name);
          if (VIRTUAL_ENVELOPE_TOOLS.has(name)) envelopes.add(name);
        }
        this.envelopeTools.set(serverName, envelopes);

        for (const t of tools) {
          this.catalog.push({
            serverName,
            name: String(t.name),
            displayName: typeof t.displayName === 'string' ? t.displayName : typeof t.title === 'string' ? t.title : undefined,
            description: typeof t.description === 'string' ? t.description : undefined,
            parametersSchema: (t.inputSchema ?? t.parametersSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
            risk: t.risk === 'write' ? 'write' : 'read',
          });
        }
      } catch (error) {
        // Un run interrompu n'est pas une dégradation : on le laisse remonter,
        // sinon l'agent verrait « outil inconnu » au lieu de « run interrompu »
        // et pourrait croire que l'outil n'existe pas.
        if (this.options.signal?.aborted) {
          throw error;
        }
        console.warn(`[omniroute_native] Impossible d'initialiser le serveur MCP ${serverName} :`, error);
      }
    }

    this.initialized = true;
  }

  async searchTools(query?: string, limit = 10): Promise<{ tools: DiscoveredMcpTool[] }> {
    await this.ensureDiscovered();

    const max = Math.max(1, Math.min(50, limit));
    const results: DiscoveredMcpTool[] = [];

    // 1. Délégation aux serveurs disposant d'outils virtuels (ex: paperclip-assigned)
    for (const serverName of this.virtualServers) {
      const client = this.clients.get(serverName);
      if (!client) continue;
      try {
        const res = await client.callRpc<any>('tools/call', {
          name: 'search_tools',
          arguments: { query, limit: max },
        });

        let found: any[] = [];
        if (res?.data?.tools && Array.isArray(res.data.tools)) {
          found = res.data.tools;
        } else if (res?.structuredContent?.tools && Array.isArray(res.structuredContent.tools)) {
          found = res.structuredContent.tools;
        } else if (Array.isArray(res?.content)) {
          const textItem = res.content.find((c: any) => c.type === 'text' && typeof c.text === 'string');
          if (textItem) {
            try {
              const parsed = JSON.parse(textItem.text);
              if (parsed?.tools && Array.isArray(parsed.tools)) {
                found = parsed.tools;
              }
            } catch {
              // Ignore non-JSON
            }
          }
        }

        for (const t of found) {
          const discovered: DiscoveredMcpTool = {
            serverName,
            name: String(t.name),
            displayName: typeof t.displayName === 'string' ? t.displayName : typeof t.title === 'string' ? t.title : undefined,
            description: typeof t.description === 'string' ? t.description : undefined,
            parametersSchema: (t.inputSchema ?? t.parametersSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
            risk: t.risk === 'write' ? 'write' : 'read',
          };
          this.dynamicTools.set(
            discovered.name,
            [...new Set([...(this.dynamicTools.get(discovered.name) ?? []), serverName])],
          );
          results.push(discovered);
        }
      } catch (err) {
        console.warn(`[omniroute_native] Erreur lors de search_tools natif sur [${serverName}] :`, err);
      }
    }

    // 2. Recherche locale parmi les outils DIRECTS.
    //
    // R1 : un serveur qui expose les enveloppes virtuelles (`search_tools` /
    // `run_tool`) expose aussi des outils directs — c'est la topologie de
    // production (un seul serveur `paperclip-assigned`). Filtrer le catalogue
    // par « serveur virtuel » rendait ces outils directs INATTEIGNABLES :
    // invisibles à la recherche, et rejetés à l'exécution parce que
    // `run_tool` n'accepte que les outils « on-demand remote ».
    //
    // On ne retire donc du catalogue que les ENVELOPPES virtuelles, qui sont
    // des pointeurs et jamais des cibles exécutables.
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const directTools = this.catalog.filter(
      (tool) => !VIRTUAL_ENVELOPE_TOOLS.has(tool.name),
    );
    const matchedDirect = directTools.filter((tool) => {
      if (!q) return true;
      return [
        tool.name,
        tool.displayName,
        tool.description,
      ].some((val) => typeof val === 'string' && val.toLowerCase().includes(q));
    });

    results.push(...matchedDirect);

    // Déduplication par nom d'outil
    const seen = new Set<string>();
    const uniqueTools: DiscoveredMcpTool[] = [];
    for (const tool of results) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        uniqueTools.push(tool);
        if (uniqueTools.length >= max) break;
      }
    }

    return { tools: uniqueTools };
  }

  /**
   * Résout un nom d'outil vers une cible d'exécution UNIQUE.
   *
   * Règles (issues du contrat upstream relu) :
   * 1. Un outil listé par `tools/list` s'exécute en DIRECT sur son serveur :
   *    `tools/call { name: <cible> }`. C'est le cas des outils de connexion et
   *    des quatre outils de contexte `paperclip_*` — y compris quand ils
   *    cohabitent sur un serveur qui expose aussi `search_tools`/`run_tool`.
   * 2. Un outil découvert par `search_tools` est « on-demand remote » : seul
   *    `run_tool` sait le lancer (`tools/call { name: 'run_tool' }`).
   * 3. Un nom inconnu, ou exposé par plusieurs serveurs, ne doit JAMAIS
   *    changer de cible en silence : on refuse explicitement (R2).
   */
  resolveTool(toolName: string, serverHint?: string): McpToolResolution {
    const catalogMatches = this.catalog.filter((t) => t.name === toolName);

    // Un serveur nommé explicitement lève l'ambiguïté : il doit porter
    // l'outil demandé, sinon on refuse plutôt que de deviner.
    if (serverHint) {
      const hinted = catalogMatches.filter((t) => t.serverName === serverHint);
      if (hinted.length === 0) {
        const dynamicOnHint = this.dynamicTools.get(toolName)?.includes(serverHint);
        if (dynamicOnHint) {
          return {
            kind: 'resolved',
            target: { serverName: serverHint, toolName, mode: 'virtual' },
          };
        }
        return { kind: 'unknown', toolName, serverHint };
      }
      const direct = hinted.find((t) => !this.envelopeTools.get(t.serverName)?.has(t.name));
      if (direct) {
        return {
          kind: 'resolved',
          target: { serverName: direct.serverName, toolName: direct.name, mode: 'direct' },
        };
      }
      // L'outil est une enveloppe virtuelle : ce n'est pas une cible.
      return { kind: 'unknown', toolName, serverHint };
    }

    // 1. Cible directe : l'outil est listé par un serveur.
    if (catalogMatches.length > 0) {
      const directMatches = catalogMatches.filter(
        (t) => !this.envelopeTools.get(t.serverName)?.has(t.name),
      );
      if (directMatches.length === 1) {
        const direct = directMatches[0];
        return {
          kind: 'resolved',
          target: { serverName: direct.serverName, toolName: direct.name, mode: 'direct' },
        };
      }
      if (directMatches.length > 1) {
        const serverNames = [...new Set(directMatches.map((t) => t.serverName))].sort();
        return { kind: 'ambiguous', toolName, serverNames };
      }
      // Le nom ne désigne qu'une enveloppe virtuelle : pas une cible.
      return { kind: 'unknown', toolName };
    }

    // 2. Cible dynamique : découverte via `search_tools` sur un serveur virtuel.
    const dynamicServers = this.dynamicTools.get(toolName) ?? [];
    if (dynamicServers.length === 1) {
      return {
        kind: 'resolved',
        target: { serverName: dynamicServers[0], toolName, mode: 'virtual' },
      };
    }
    if (dynamicServers.length > 1) {
      return { kind: 'ambiguous', toolName, serverNames: [...dynamicServers].sort() };
    }

    // 3. Nom inconnu : aucun repli silencieux vers un serveur arbitraire (R2).
    return { kind: 'unknown', toolName };
  }
}

function clipOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 120)}\n… [sortie MCP tronquée : ${text.length} caractères au total ; affinez les paramètres de l’outil]`;
}

const SEARCH_TOOL_SPEC: WireToolSpec = {
  name: 'mcp_search_tools',
  description:
    'Recherche des outils d’entreprise disponibles via la passerelle Paperclip (GitHub, Cloudflare, bases de données, etc.). ' +
    'Rend les noms exacts et les schémas de paramètres nécessaires pour mcp_run_tool.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Mot-clé ou capacité recherchée (ex: "github issue", "dns cloudflare", "select postgres"). Laisser vide pour lister les premiers outils.',
      },
      limit: {
        type: 'integer',
        description: 'Nombre maximum d’outils renvoyés (1 à 20, défaut : 10).',
      },
    },
    additionalProperties: false,
  },
};

const RUN_TOOL_SPEC: WireToolSpec = {
  name: 'mcp_run_tool',
  description:
    'Exécute un outil d’entreprise découvert via mcp_search_tools. ' +
    'La requête passe par le contrôle de sécurité, d’approbation et d’audit Paperclip.',
  input_schema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: 'Le nom exact de l’outil cible renvoyé par mcp_search_tools.',
      },
      arguments: {
        type: 'object',
        description: 'Les arguments de l’outil, conformes à son schéma.',
      },
      server: {
        type: 'string',
        description:
          'Serveur MCP cible, uniquement si le même outil est exposé par plusieurs serveurs. ' +
          'Laissez vide pour la résolution automatique.',
      },
    },
    required: ['tool'],
    additionalProperties: false,
  },
};

/**
 * Construit les deux outils virtuels invariants (mcp_search_tools et mcp_run_tool).
 * Si la liste de serveurs est vide, renvoie un tableau vide.
 */
export function buildMcpBridgeTools(options: McpBridgeOptions): WorkspaceTool[] {
  if (!options.servers || options.servers.length === 0) {
    return [];
  }

  const bridge = new McpBridge(options);
  const redactor = options.redactSecrets ?? ((t: string) => t);

  const searchTool: WorkspaceTool = {
    spec: SEARCH_TOOL_SPEC,
    async run(input: unknown): Promise<ToolResult> {
      try {
        const params = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
        const query = typeof params.query === 'string' ? params.query : undefined;
        const limit = typeof params.limit === 'number' && Number.isInteger(params.limit) ? params.limit : 10;

        const { tools } = await bridge.searchTools(query, limit);

        if (tools.length === 0) {
          const msg = query
            ? `Aucun outil MCP ne correspond à la recherche "${query}". Utilisez mcp_search_tools sans filtre pour voir les outils disponibles.`
            : 'Aucun outil MCP disponible sur les serveurs configurés.';
          return { content: msg, isError: false };
        }

        const formatted = JSON.stringify({ tools }, null, 2);
        const clean = redactor(formatted);
        return { content: clipOutput(clean, MAX_MCP_OUTPUT_CHARS), isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: redactor(`Échec de mcp_search_tools : ${message}`), isError: true };
      }
    },
  };

  const runTool: WorkspaceTool = {
    spec: RUN_TOOL_SPEC,
    async run(input: unknown): Promise<ToolResult> {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return { content: 'Arguments refusés pour mcp_run_tool : objet requis avec la propriété « tool ».', isError: true };
        }
        const record = input as Record<string, unknown>;
        if (record.tool === undefined || record.tool === null) {
          return { content: 'Arguments refusés pour mcp_run_tool : « tool » est requis (nom de l’outil cible). Rien n’a été envoyé.', isError: true };
        }
        if (typeof record.tool !== 'string') {
          return { content: 'Arguments refusés pour mcp_run_tool : « tool » doit être une chaîne. Rien n’a été envoyé.', isError: true };
        }
        const toolName = record.tool.trim();
        if (toolName.length === 0) {
          return { content: 'Arguments refusés pour mcp_run_tool : « tool » est vide. Rien n’a été envoyé.', isError: true };
        }

        let toolArgs: Record<string, unknown> = {};
        if (record.arguments !== undefined && record.arguments !== null) {
          if (typeof record.arguments !== 'object' || Array.isArray(record.arguments)) {
            return { content: 'Arguments refusés pour mcp_run_tool : « arguments » doit être un objet.', isError: true };
          }
          toolArgs = record.arguments as Record<string, unknown>;
        }

        await bridge.ensureDiscovered();

        // Résolution EXPLICITE de la cible (R2) : jamais de repli silencieux
        // vers `paperclip-assigned` ou le premier serveur, qui enverrait un
        // nom d'outil à un serveur qui ne le possède pas.
        const serverHint = typeof record.server === 'string' ? record.server.trim() : undefined;
        const resolution = bridge.resolveTool(toolName, serverHint || undefined);

        if (resolution.kind === 'unknown') {
          const servers = bridge.getCatalog().map((t) => t.serverName);
          const hint = serverHint
            ? ` sur le serveur « ${serverHint} »`
            : '';
          const known = servers.length > 0
            ? ` Serveurs MCP configurés : ${[...new Set(servers)].join(', ')}.`
            : ' Aucun serveur MCP n\'a découvert d\'outil.';
          return {
            content: redactor(
              `Outil inconnu : « ${toolName} »${hint} n'est exposé par aucun serveur MCP configuré. Rien n'a été exécuté.${known}`,
            ),
            isError: true,
          };
        }

        if (resolution.kind === 'ambiguous') {
          return {
            content: redactor(
              `Outil ambigu : « ${toolName} » est exposé par plusieurs serveurs MCP (${resolution.serverNames.join(', ')}). ` +
              `Précisez « server » avec l'un de ces serveurs. Rien n'a été exécuté.`,
            ),
            isError: true,
          };
        }

        const target = resolution.target;
        const client = bridge.getClient(target.serverName);
        if (!client) {
          return {
            content: redactor(
              `Outil « ${toolName} » : le serveur MCP « ${target.serverName} » n'est plus joignable. Rien n'a été exécuté.`,
            ),
            isError: true,
          };
        }

        let rawResult: any;
        if (target.mode === 'virtual') {
          // Cible on-demand : seul `run_tool` sait la lancer.
          rawResult = await client.callRpc<any>('tools/call', {
            name: 'run_tool',
            arguments: {
              tool: target.toolName,
              arguments: toolArgs,
            },
          });
        } else {
          // Outil listé par `tools/list` : appel direct, y compris sur un
          // serveur qui expose aussi `search_tools`/`run_tool` (R1).
          rawResult = await client.callRpc<any>('tools/call', {
            name: target.toolName,
            arguments: toolArgs,
          });
        }

        let text = '';
        let isError = false;

        if (rawResult && typeof rawResult === 'object') {
          if (rawResult.isError === true) {
            isError = true;
          }

          if (Array.isArray(rawResult.content)) {
            const parts = rawResult.content
              .filter((c: any) => c && typeof c === 'object')
              .map((c: any) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)));
            text = parts.join('\n');
          } else if (typeof rawResult.content === 'string') {
            text = rawResult.content;
          } else if (rawResult.structuredContent !== undefined) {
            text = typeof rawResult.structuredContent === 'string'
              ? rawResult.structuredContent
              : JSON.stringify(rawResult.structuredContent, null, 2);
          } else {
            text = JSON.stringify(rawResult, null, 2);
          }
        } else if (typeof rawResult === 'string') {
          text = rawResult;
        } else {
          text = JSON.stringify(rawResult);
        }

        const cleanText = redactor(text);
        return {
          content: clipOutput(cleanText, MAX_MCP_OUTPUT_CHARS),
          isError,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: redactor(`Échec de mcp_run_tool : ${message}`),
          isError: true,
        };
      }
    },
  };

  return [searchTool, runTool];
}

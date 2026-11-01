/**
 * Outils de plugin Paperclip (passerelle de plugins).
 *
 * Les plugins Paperclip enregistrent des outils pour les agents (capacité
 * `agent.tools.register`, ex. `hindsight_recall` / `hindsight_retain` du plugin
 * de mémoire Hindsight). Le serveur les expose par deux routes :
 *
 * - `GET /api/plugins/tools` : avec la clé de l'agent du run, la liste filtrée
 *   par la politique d'outils de la société (`listPluginToolsForAgent`) ;
 * - `POST /api/plugins/tools/execute` : `{ tool, parameters, runContext }`, où
 *   `tool` est le nom namespacé `<pluginKey>:<outil>` et `runContext` porte
 *   les quatre identifiants `agentId`, `runId`, `companyId`, `projectId`
 *   (tous obligatoires et cohérents entre eux côté serveur).
 *
 * Contrat de l'adaptateur :
 * - découverte UNE fois au début du run (cache par run : la liste d'outils
 *   reste stable pendant tout le run, ce qui préserve le cache de prompt) ;
 * - un échec de découverte n'échoue jamais le run : aucun outil de plugin,
 *   et une ligne de journal lisible ;
 * - noms : le nom court du plugin (`hindsight_recall`) s'il est libre ; en cas
 *   de collision avec un outil existant (outils de workspace, `paperclip_*`,
 *   pont MCP) ou entre deux plugins, un nom namespacé
 *   `plugin_<plugin>__<outil>`. Les outils existants gardent toujours la
 *   priorité ; le préfixe `paperclip_` et `mcp_` reste réservé ;
 * - chaque appel est borné par un délai, ses erreurs sont rendues au modèle
 *   en clair et le jeton de run est masqué partout.
 */
import { createHash } from 'node:crypto';
import type { ToolResult, WorkspaceTool } from './tools.js';
import { PaperclipHttpError, PaperclipRest, redactSecrets, type PaperclipToolsOptions } from './paperclip-tools.js';

export const PLUGIN_DISCOVERY_TIMEOUT_MS = 10_000;
export const PLUGIN_EXECUTE_TIMEOUT_MS = 30_000;
/** Plafond du nombre d'outils de plugin exposés (garde de taille du prompt). */
export const MAX_PLUGIN_TOOLS = 32;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 1_000;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_PREFIXES = ['paperclip_', 'mcp_'];

export interface PluginToolsOptions extends PaperclipToolsOptions {
  /** Projet du run (`context.projectId`) : exigé par la route d'exécution. */
  projectId: string | null;
  /** Noms déjà pris par les autres outils du run : ils gardent la priorité. */
  reservedNames: Iterable<string>;
  discoveryTimeoutMs?: number;
  executeTimeoutMs?: number;
}

export interface PluginToolsDiscovery {
  tools: WorkspaceTool[];
  /** Raison lisible quand aucun outil n'est exposé (journal du run), sinon `null`. */
  note: string | null;
  /** Descripteurs écartés (nom invalide, doublon, plafond), pour le journal. */
  skipped: string[];
}

interface Descriptor {
  fullName: string;
  pluginKey: string;
  toolName: string;
  description: string;
  schema: Record<string, unknown>;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

/** Nom namespacé valide pour l'API Chat Completions (≤ 64 caractères, stable). */
export function namespacedPluginToolName(pluginKey: string, toolName: string): string {
  const name = `plugin_${sanitize(pluginKey)}__${sanitize(toolName)}`;
  if (name.length <= 64) return name;
  const hash = createHash('sha256').update(`${pluginKey}:${toolName}`).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

function parseDescriptor(raw: unknown): Descriptor | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const fullName = typeof entry['name'] === 'string' ? entry['name'] : '';
  const separator = fullName.indexOf(':');
  if (separator <= 0 || separator === fullName.length - 1) return null;
  const pluginKey = fullName.slice(0, separator);
  const toolName = fullName.slice(separator + 1);
  const schemaRaw = entry['parametersSchema'];
  const schema = schemaRaw && typeof schemaRaw === 'object' && !Array.isArray(schemaRaw)
    && (schemaRaw as Record<string, unknown>)['type'] === 'object'
    ? (schemaRaw as Record<string, unknown>)
    : { type: 'object', properties: {} };
  const text = [entry['description'], entry['displayName']].find((v) => typeof v === 'string' && v.trim());
  const description = `${typeof text === 'string' ? text.trim() : toolName} (outil du plugin Paperclip « ${pluginKey} »)`;
  return { fullName, pluginKey, toolName, description: clip(description, MAX_DESCRIPTION_CHARS), schema };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [tronqué : ${text.length} caractères au total]`;
}

/** Message d'erreur lisible pour le modèle, sans jeton. */
function describeFailure(fullName: string, error: unknown): string {
  if (error instanceof PaperclipHttpError) {
    const hint = error.status === 403 ? 'refusé par Paperclip (droits ou portée du run)'
      : error.status === 404 ? 'outil introuvable (plugin désactivé ou désinstallé ?)'
        : error.status === 501 ? 'passerelle de plugins désactivée sur ce serveur'
          : error.status === 502 ? 'le worker du plugin ne répond pas'
            : 'échec côté serveur';
    return `Outil de plugin ${fullName} : ${hint} — HTTP ${error.status}${error.detail ? ` : ${error.detail}` : ''}`;
  }
  return `Outil de plugin ${fullName} : ${error instanceof Error ? error.message : String(error)}`;
}

/** Rend le `ToolExecutionResult` du serveur (`{ result: { content, data, error } }`). */
function renderResult(data: unknown): ToolResult {
  const outer = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const result = outer['result'] && typeof outer['result'] === 'object'
    ? (outer['result'] as Record<string, unknown>)
    : outer;
  if (typeof result['error'] === 'string' && result['error']) {
    return { content: clip(`Erreur du plugin : ${result['error']}`, MAX_OUTPUT_CHARS), isError: true };
  }
  const parts: string[] = [];
  if (typeof result['content'] === 'string') parts.push(result['content']);
  if (result['data'] !== undefined) parts.push(JSON.stringify(result['data']));
  return { content: clip(parts.join('\n') || '(résultat vide)', MAX_OUTPUT_CHARS), isError: false };
}

/**
 * Découvre les outils de plugin visibles par l'agent du run et les convertit
 * en outils du modèle. N'échoue jamais : renvoie une liste vide et une note.
 */
export async function discoverPluginTools(options: PluginToolsOptions): Promise<PluginToolsDiscovery> {
  const { runId, agentId, companyId, projectId } = options;
  if (!options.apiUrl || !options.apiKey || !runId || !agentId || !companyId) {
    return { tools: [], note: 'identité de run Paperclip incomplète', skipped: [] };
  }
  // Sans projet, la route d'exécution refuse tout appel : pas de découverte inutile.
  if (!projectId) {
    return { tools: [], note: 'run sans projet (runContext.projectId exigé par le serveur)', skipped: [] };
  }
  const secrets = [options.apiKey].filter((s) => s.length >= 6);
  const redact = (text: string) => redactSecrets(text, secrets);
  let listed: unknown;
  try {
    const discovery = new PaperclipRest({ ...options, timeoutMs: options.discoveryTimeoutMs ?? PLUGIN_DISCOVERY_TIMEOUT_MS });
    listed = (await discovery.request('GET', '/plugins/tools')).data;
  } catch (error) {
    return { tools: [], note: redact(`découverte impossible : ${error instanceof Error ? error.message : String(error)}`), skipped: [] };
  }
  if (!Array.isArray(listed)) return { tools: [], note: 'réponse de découverte inattendue', skipped: [] };

  const skipped: string[] = [];
  const descriptors: Descriptor[] = [];
  const seen = new Set<string>();
  for (const raw of listed) {
    const descriptor = parseDescriptor(raw);
    if (!descriptor) {
      skipped.push(clip(redact(JSON.stringify((raw as { name?: unknown })?.name ?? null)), 80));
    } else if (!seen.has(descriptor.fullName)) {
      seen.add(descriptor.fullName);
      descriptors.push(descriptor);
    }
  }
  if (descriptors.length === 0) return { tools: [], note: 'aucun outil de plugin visible pour cet agent', skipped };

  // Ordre stable (cache de prompt) ; noms courts seulement s'ils sont uniques et libres.
  descriptors.sort((a, b) => a.fullName.localeCompare(b.fullName));
  const taken = new Set(options.reservedNames);
  const shortCount = new Map<string, number>();
  for (const d of descriptors) shortCount.set(d.toolName, (shortCount.get(d.toolName) ?? 0) + 1);
  const execute = new PaperclipRest({ ...options, timeoutMs: options.executeTimeoutMs ?? PLUGIN_EXECUTE_TIMEOUT_MS });
  const runContext = { agentId, runId, companyId, projectId };
  const tools: WorkspaceTool[] = [];
  for (const d of descriptors) {
    const short = TOOL_NAME_RE.test(d.toolName) && shortCount.get(d.toolName) === 1
      && !RESERVED_PREFIXES.some((prefix) => d.toolName.startsWith(prefix)) && !taken.has(d.toolName);
    const name = short ? d.toolName : namespacedPluginToolName(d.pluginKey, d.toolName);
    if (taken.has(name) || tools.length >= MAX_PLUGIN_TOOLS) {
      skipped.push(d.fullName);
      continue;
    }
    taken.add(name);
    tools.push({
      spec: { name, description: d.description, input_schema: d.schema },
      async run(input: unknown): Promise<ToolResult> {
        const parameters = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
        try {
          const response = await execute.request('POST', '/plugins/tools/execute', {
            body: { tool: d.fullName, parameters, runContext },
          });
          const rendered = renderResult(response.data);
          return { ...rendered, content: redact(rendered.content) };
        } catch (error) {
          return { content: redact(describeFailure(d.fullName, error)), isError: true };
        }
      },
    });
  }
  return { tools, note: null, skipped };
}

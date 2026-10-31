/**
 * Masquage des secrets (ACC-2300, partie adaptateur).
 *
 * **Constat mesuré.** Un jeton de run (JWT) a été retrouvé en clair dans un
 * fichier de session `0644` : l'agent avait lancé `env`, la sortie de l'outil
 * est entrée telle quelle dans l'historique, puis sur le disque. Le shell de
 * l'agent porte légitimement des secrets (`PAPERCLIP_API_KEY`, jeton des
 * outils runtime, variables `config.env`) : n'importe quelle commande peut
 * donc les faire apparaître dans une sortie.
 *
 * **Défense en profondeur.**
 *
 * 1. Chaque sortie d'outil est masquée **avant** d'entrer dans l'historique :
 *    ni le modèle, ni le transcript, ni le fichier de session ne la voient en
 *    clair (`guardToolOutputs`).
 * 2. Le fichier de session est masqué une seconde fois à l'écriture et au
 *    rechargement (`redactWireMessages`) : un ancien fichier qui contiendrait
 *    encore un jeton est nettoyé au passage.
 *
 * Deux mécanismes complémentaires :
 * - les **valeurs connues** (jeton de run, clé de la passerelle, valeurs des
 *   variables d'environnement au nom secret) sont remplacées où qu'elles
 *   apparaissent, même sans nom autour ;
 * - les **motifs** (JWT, URL avec mot de passe, clés à préfixe connu, PEM,
 *   `NOM_SECRET=valeur`, `"apiKey": "…"`, `Bearer …`) couvrent ce que l'on ne
 *   connaît pas d'avance.
 *
 * Le masquage garde le contexte utile (nom de la variable, hôte d'une URL) :
 * l'agent comprend ce qu'il a obtenu sans voir la valeur.
 */
import type { WireContentBlock, WireMessage } from '../shared/wire.js';
import type { WorkspaceTool } from './tools.js';

export const REDACTED = '[REDACTED]';

/** Longueur minimale d'une valeur connue masquée par simple occurrence. */
const MIN_KNOWN_VALUE_LENGTH = 8;

/** Mots qui, seuls dans un nom de variable, en font un secret. */
const SECRET_WORDS = new Set([
  'TOKEN',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'PGPASSWORD',
  'APIKEY',
  'CREDENTIAL',
  'CREDENTIALS',
  'COOKIE',
  'DSN',
  'PAT',
]);

/** `KEY` n'est secret que précédé de l'un de ces mots (`API_KEY`, `PRIVATE_KEY`…). */
const KEY_QUALIFIERS = new Set(['API', 'PRIVATE', 'ACCESS', 'SECRET', 'SIGNING', 'ENCRYPTION', 'MASTER', 'SERVICE', 'AUTH', 'LICENSE']);

/** Découpe `apiKey`, `api-key`, `API_KEY` en mots majuscules. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/**
 * Le nom d'une variable (ou d'un champ JSON) désigne-t-il un secret ?
 *
 * Fondé sur des **mots** et non des sous-chaînes : `GIT_AUTHOR_NAME` contient
 * « AUTH » sans être un secret, `max_tokens` n'est pas un jeton.
 */
export function isSecretEnvKey(name: string): boolean {
  const parts = words(name);
  if (parts.length === 0) return false;
  const joined = parts.join('_');
  if (joined === 'DATABASE_URL' || joined.endsWith('_DATABASE_URL') || joined.includes('CONNECTION_STRING')) return true;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (SECRET_WORDS.has(part)) return true;
    if (part === 'KEY' && i > 0 && KEY_QUALIFIERS.has(parts[i - 1]!)) return true;
  }
  return false;
}

/**
 * Valeurs secrètes connues d'un ou plusieurs environnements : valeurs des
 * clés au nom secret, assez longues pour ne pas masquer du bruit.
 */
export function collectSecretValues(
  ...sources: Array<Record<string, unknown> | null | undefined>
): string[] {
  const out = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string' || !isSecretEnvKey(key)) continue;
      const trimmed = value.trim();
      if (trimmed.length >= MIN_KNOWN_VALUE_LENGTH) out.add(trimmed);
    }
  }
  return [...out];
}

interface PatternRule {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

/** Valeur déjà masquée (pas de double masquage, pas de faux positif). */
function alreadyRedacted(value: string): boolean {
  return /^\[?REDACTED\]?$|^\*+$|^<redacted>$/i.test(value.replace(/^["']|["']$/g, ''));
}

const PATTERNS: PatternRule[] = [
  // Clés privées PEM (multi-lignes).
  {
    re: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
    replace: (_m, kind) => `-----BEGIN ${kind}PRIVATE KEY-----${REDACTED}-----END ${kind}PRIVATE KEY-----`,
  },
  // JWT (jetons de run Paperclip, jetons d'outils…).
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    replace: () => REDACTED,
  },
  // URL avec identifiants : postgres://user:pass@hôte → postgres://user:[REDACTED]@hôte.
  {
    re: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s:/@'"`]*):([^\s@/'"`]+)@/g,
    replace: (match, scheme, user, pass) => (alreadyRedacted(pass) ? match : `${scheme}${user}:${REDACTED}@`),
  },
  // En-têtes d'autorisation.
  {
    re: /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{12,})/g,
    replace: (match, scheme, space, value) => (alreadyRedacted(value) ? match : `${scheme}${space}${REDACTED}`),
  },
  // Clés à préfixe connu (OpenAI/Anthropic, GitHub, GitLab, Slack, AWS, Google, Paperclip).
  {
    re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|pcp_[A-Za-z0-9_]{16,})/g,
    replace: () => REDACTED,
  },
  // Champ JSON au nom secret : "apiKey": "valeur".
  {
    re: /("([A-Za-z0-9_.-]{2,64})"\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
    replace: (match, prefix, name, value) =>
      isSecretEnvKey(name) && value.length > 0 && !alreadyRedacted(value) ? `${prefix}"${REDACTED}"` : match,
  },
  // Affectation shell/env : NOM_SECRET=valeur (avec ou sans guillemets, `export` compris).
  {
    re: /\b([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s'"`]+)/g,
    replace: (match, name, value) =>
      isSecretEnvKey(name) && value.replace(/^["']|["']$/g, '').length > 0 && !alreadyRedacted(value)
        ? `${name}=${REDACTED}`
        : match,
  },
  // YAML / en-tête : nom-secret: valeur (valeur d'au moins 8 caractères).
  {
    re: /\b([A-Za-z][A-Za-z0-9_-]*)(\s*:[ \t]*)([^\s,;'"`{}[\]]{8,})/g,
    replace: (match, name, sep, value) =>
      isSecretEnvKey(name) && !alreadyRedacted(value) && !/^https?:\/\//.test(value) ? `${name}${sep}${REDACTED}` : match,
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Masque les secrets d'un texte.
 *
 * `knownValues` : valeurs à masquer partout où elles apparaissent (les plus
 * longues d'abord, pour qu'une valeur contenue dans une autre ne laisse pas
 * de reste).
 */
export function redactSecrets(text: string, knownValues: readonly string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  const values = [...new Set(knownValues.filter((v) => typeof v === 'string' && v.length >= MIN_KNOWN_VALUE_LENGTH))]
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (out.includes(value)) out = out.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED);
  }
  for (const rule of PATTERNS) {
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/** Fabrique un masqueur lié à un jeu de valeurs connues. */
export function createRedactor(knownValues: Iterable<string | null | undefined> = []): (text: string) => string {
  const values = [...knownValues].filter((v): v is string => typeof v === 'string' && v.trim().length >= MIN_KNOWN_VALUE_LENGTH).map((v) => v.trim());
  return (text: string) => redactSecrets(text, values);
}

/** Masque récursivement les chaînes d'une valeur JSON (entrée d'outil, ancien fichier). */
export function redactJsonValue(
  value: unknown,
  redact: (text: string) => string = (text) => redactSecrets(text),
  depth = 0,
): unknown {
  if (depth > 20) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, redact, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = typeof entry === 'string' && isSecretEnvKey(key) && entry.length > 0 && !alreadyRedacted(entry)
        ? REDACTED
        : redactJsonValue(entry, redact, depth + 1);
    }
    return out;
  }
  return value;
}

function redactBlock(block: WireContentBlock, redact: (text: string) => string): WireContentBlock {
  switch (block.type) {
    case 'text':
      return { ...block, text: redact(block.text) };
    case 'thinking':
      // Le raisonnement n'est pas rejoué vers Chat Completions (voir
      // chat-completions.ts) : modifier son texte n'invalide rien en amont.
      return { ...block, thinking: redact(block.thinking) };
    case 'tool_use':
      return { ...block, input: redactJsonValue(block.input, redact) };
    case 'tool_result':
      return { ...block, content: redact(block.content) };
    default:
      return block;
  }
}

/** Masque tout un historique (copie ; l'original n'est pas modifié). */
export function redactWireMessages(
  messages: WireMessage[],
  redact: (text: string) => string = (text) => redactSecrets(text),
): WireMessage[] {
  return messages.map((message) => ({ ...message, content: message.content.map((block) => redactBlock(block, redact)) }));
}

/**
 * Enveloppe les outils : chaque sortie est masquée avant de revenir à la
 * boucle, donc avant l'historique, le transcript et le disque.
 */
export function guardToolOutputs(
  tools: WorkspaceTool[],
  redact: (text: string) => string,
): WorkspaceTool[] {
  return tools.map((tool) => ({
    ...tool,
    async run(input: unknown) {
      const outcome = await tool.run(input);
      return { ...outcome, content: redact(outcome.content) };
    },
  }));
}

/** Nombre de motifs de secrets dans un texte (diagnostic, sans rien afficher). */
export function countSecretPatterns(text: string): number {
  return redactSecrets(text).split(REDACTED).length - text.split(REDACTED).length;
}

/**
 * Outils de workspace exposés au modèle.
 *
 * C'est ce qui sépare un adaptateur d'agent d'un simple relais de chat : les
 * autres adaptateurs Paperclip délèguent l'outillage à un CLI local
 * (`claude`, `codex`…), qui exécute ses propres commandes. Notre passerelle
 * OmniRoute ne fournit que l'inférence — il n'y a aucun CLI derrière — donc
 * l'adaptateur doit porter lui-même la boucle d'outils.
 *
 * Trois précautions, toutes motivées par des incidents réels :
 *
 * 1. **Confinement.** Chaque chemin est résolu puis vérifié comme restant sous
 *    la racine du workspace. Sans cela, un modèle qui produit `../../.env`
 *    exfiltre des fichiers hors du projet. On compare des chemins *résolus*
 *    (symlinks inclus), pas des chaînes.
 * 2. **Exclusion des secrets.** `.env`, clés privées, identifiants : la lecture
 *    est refusée même dans le workspace. Un agent qui a besoin d'une valeur
 *    secrète passe par le coffre Paperclip, pas par une lecture de fichier.
 * 3. **`shell` non interactif et borné.** Pas de shell persistant, timeout
 *    systématique, sortie plafonnée : un `tail -f` lancé par erreur ne doit pas
 *    figer le run jusqu'au timeout global.
 *
 * Contrat de repo local : ces outils n'exécutent **aucun** `git push` et ne
 * supposent **aucun** `git remote`. Le workspace local est la seule source de
 * vérité (voir `packages/adapters/AUTHORING.md`).
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { accessSync, constants as fsConstants, promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';

import type { WireToolSpec } from '../shared/client.js';

/** Sortie maximale renvoyée au modèle, par outil. */
const MAX_OUTPUT_CHARS = 30_000;
const MAX_LIST_ENTRIES = 400;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/**
 * Fichiers et motifs jamais lisibles, même dans le workspace. Volontairement
 * large : un faux refus coûte un message d'erreur au modèle, une lecture
 * manquée coûte un secret dans un transcript.
 */
const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^\.npmrc$/i,
  /^credentials(\.json)?$/i,
  /^\.git-credentials$/i,
];

const SECRET_PATH_SEGMENTS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.paperclip'];

/** Répertoires jamais parcourus ni listés. */
const IGNORED_DIR_SEGMENTS: readonly string[] = [
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.turbo',
];

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface WorkspaceTool {
  spec: WireToolSpec;
  run(input: unknown): Promise<ToolResult>;
}

/** Erreur de refus : distincte d'une erreur d'exécution, elle est définitive. */
class ToolRefusal extends Error {}

/**
 * Résout un chemin fourni par le modèle en le confinant à la racine.
 *
 * `fs.realpath` est appliqué au parent quand la cible n'existe pas encore
 * (cas d'une écriture) : sans cela, on validerait un chemin littéral qu'un
 * symlink peut rediriger ailleurs.
 */
/**
 * Détecte une tentative de publication vers un dépôt distant.
 *
 * Une expression régulière sur la commande brute est contournable trivially :
 * `git -C . push`, `git -c color.ui=false push` ou `g'it' pu'sh'` passent
 * tous une recherche de « git push ». On regarde donc **la suite des arguments
 * de git**, en ignorant les options (`-C`, `-c`, `--git-dir`, …) : c'est le
 * sous-commande qui compte, pas la suite de caractères.
 *
 * On refuse aussi `git remote` en écriture (`git remote add/set-url`),
 * qui redirigerait le workspace vers un distant.
 */
export function detectsSecretAccess(command: string): boolean {
  const normalized = command.replace(/['"]/g, '');
  const segments = normalized.split(/[\s;&|()]+/).filter(Boolean);
  for (const segment of segments) {
    const base = path.basename(segment).toLowerCase();
    for (const pat of SECRET_BASENAME_PATTERNS) {
      if (pat.test(base)) return true;
    }
    for (const p of segment.split(/[\\/]/)) {
      if (SECRET_PATH_SEGMENTS.includes(p)) return true;
    }
  }
  return false;
}

export function detectsRemotePublication(command: string): boolean {
  const normalized = command.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
  const vars = new Map<string, string>();
  for (const match of normalized.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)=([^\s;&|]+)/g)) {
    const name = match[1];
    const val = match[2];
    if (name && val) {
      vars.set('$' + name, val);
      vars.set('${' + name + '}', val);
    }
  }
  const parts = normalized.split(/[;&|()\n]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const rawTokens = part.split(/\s+/).filter(Boolean);
    const tokens = rawTokens.map((t) => vars.get(t) || t);
    for (let i = 0; i < tokens.length; i += 1) {
      let cmd = tokens[i];
      while (cmd && cmd.includes('=') && i + 1 < tokens.length) {
        i += 1;
        cmd = tokens[i];
      }
      if (cmd !== 'git') continue;
      let j = i + 1;
      while (j < tokens.length) {
        const arg = tokens[j];
        if (arg === undefined) break;
        if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
          j += 2;
          continue;
        }
        if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg.startsWith('--namespace=')) {
          j += 1;
          continue;
        }
        if (arg.startsWith('-')) {
          j += 1;
          continue;
        }
        break;
      }
      const subcommand = tokens[j];
      if (subcommand === 'push' || subcommand === 'send-email' || subcommand === 'send-pack') {
        return true;
      }
      if (subcommand === 'remote') {
        const action = tokens[j + 1];
        if (action === 'add' || action === 'set-url' || action === 'set-branches' || action === 'rename') {
          return true;
        }
      }
    }
  }
  return false;
}

async function resolveConfinedPath(root: string, requested: string): Promise<string> {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    throw new ToolRefusal('chemin vide');
  }
  const absolute = path.isAbsolute(requested) ? requested : path.resolve(root, requested);

  const realRoot = await fs.realpath(root);
  let realTarget: string;
  try {
    realTarget = await fs.realpath(absolute);
  } catch {
    // Cible inexistante (lot 18d) : on résout le plus proche ancêtre existant
    // — liens symboliques compris — puis on y rattache les segments manquants.
    // `path.resolve` a déjà retiré les `..` ; un segment manquant qui existe
    // quand même est un lien pendant, refusé ci-dessous (lot 18e). Le contrôle
    // de confinement porte sur le chemin réel final. write_file crée ensuite
    // les répertoires manquants (parité avec l'outil Write de claude_local).
    const missing: string[] = [path.basename(absolute)];
    let ancestor = path.dirname(absolute);
    let realAncestor: string | undefined;
    for (let depth = 0; depth < 64; depth += 1) {
      try {
        realAncestor = await fs.realpath(ancestor);
        break;
      } catch {
        const up = path.dirname(ancestor);
        if (up === ancestor) break;
        missing.unshift(path.basename(ancestor));
        ancestor = up;
      }
    }
    if (realAncestor === undefined) {
      throw new ToolRefusal(`répertoire parent introuvable : ${path.dirname(absolute)}`);
    }
    // Lot 18e — un segment « manquant » qui existe pourtant (lstat) est un lien
    // symbolique pendant : `realpath` n'a pas pu le résoudre, et `writeFile`
    // le suivrait vers sa cible, peut-être hors du workspace. Refus.
    for (let i = 0; i < missing.length; i += 1) {
      const candidate = path.join(realAncestor, ...missing.slice(0, i + 1));
      const present = await fs.lstat(candidate).then(() => true, () => false);
      if (present) {
        throw new ToolRefusal(
          `lien symbolique non résolu (cible absente) : ${path.relative(realRoot, candidate) || candidate}`,
        );
      }
    }
    realTarget = path.join(realAncestor, ...missing);
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new ToolRefusal(
      `chemin hors du workspace : ${requested} (racine : ${realRoot})`,
    );
  }
  return realTarget;
}

/** Refuse les fichiers manifestement porteurs de secrets. */
function assertNotSecret(realPath: string, root: string): void {
  const relative = path.relative(root, realPath);
  const segments = relative.split(path.sep);
  for (const segment of segments) {
    if (SECRET_PATH_SEGMENTS.includes(segment)) {
      throw new ToolRefusal(
        `accès refusé à « ${relative} » : répertoire de secrets. Utilisez le coffre Paperclip pour les identifiants.`,
      );
    }
  }
  const basename = path.basename(realPath);
  for (const pattern of SECRET_BASENAME_PATTERNS) {
    if (pattern.test(basename)) {
      throw new ToolRefusal(
        `accès refusé à « ${relative} » : fichier sensible. Ne cherchez pas à lire les secrets depuis le workspace.`,
      );
    }
  }
}

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n[…${omitted} caractères tronqués…]`;
}

function asField(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return '';
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function asNumberField(input: unknown, key: string, fallback: number): number {
  if (typeof input !== 'object' || input === null) return fallback;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/**
 * Un chemin appartient-il au workspace (ou à l'un de ses sous-dossiers) ?
 *
 * La comparaison se fait sur le chemin normalisé, sans exiger que le
 * workspace existe déjà sur le disque : on compare les segments.
 */
function isInsideWorkspace(candidate: string, workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot) return false;
  const root = workspaceRoot.replace(/\/+$/, '');
  if (root.length === 0) return false;
  const normalised = candidate.replace(/\/+$/, '');
  return normalised === root || normalised.startsWith(root + '/');
}

/**
 * Empêche la commande shell de quitter le workspace.
 *
 * `cwd` ne fixe que le répertoire de *démarrage* : sans garde, `cd ..`
 * permettent d'atteindre n'importe quoi sur le disque du conteneur. On
 * refuse donc explicitement les remontées de répertoire dans la commande.
 *
 * Un chemin **absolu** est refusé, sauf s'il est dans le workspace : l'agent
 * fait souvent `cd <chemin-absolu-du-workspace>` pour être sûr de sa
 * position, et ce n'est pas une sortie.
 *
 * Ce n'est pas un sandbox (le shell garde les droits du processus) : c'est une
 * garde-fou explicite, honnête sur sa portée. Le vrai confinement —
 * montage du seul workspace, réseau contrôlé — reste le travail d'un
 * environnement d'exécution dédié.
 */
export function detectsWorkspaceEscape(command: string, workspaceRoot?: string): boolean {
  return findWorkspaceEscape(command, workspaceRoot) !== null;
}

/** Fragment de la commande qui sort du workspace, ou `null`. Sert au message d'erreur. */
export function findWorkspaceEscape(command: string, workspaceRoot?: string): string | null {
  return escapeInCommand(command, workspaceRoot, 0);
}

/**
 * Lot 8a — garde-fou plus juste.
 *
 * L'ancienne version retirait toutes les quotes puis traitait chaque mot comme
 * un chemin : l'opérateur jq `//` (« sinon »), un motif awk `/ERROR/` ou une
 * redirection `> /dev/null` étaient refusés comme des sorties du workspace
 * (mesuré sur ACC-2278 : 6 commandes légitimes refusées, 7 tours perdus sur 19).
 *
 * Désormais la commande est découpée comme le ferait le shell :
 * - un mot **simple** (hors quotes, ou entre quotes sans syntaxe de
 *   programme) est jugé comme un chemin : `..`, `~`, `$HOME/`, chemin absolu ;
 * - un mot qui contient du **code** entre quotes (programme jq/awk/sed/python,
 *   chaîne avec `$`, `|`, `(`…) n'est pas un chemin : on y cherche seulement
 *   les vrais motifs de sortie (`../`, chemin absolu vers un répertoire
 *   existant du système, `~/`, `$HOME/`) ;
 * - `$(…)` et les backquotes sont analysés récursivement, même entre `"…"`.
 *
 * Un chemin absolu n'est une sortie que s'il vise un répertoire racine réel
 * (`/etc`, `/paperclip`, `/tmp`…) : `/api/issues` dans un motif grep n'est pas
 * un chemin. Restent permis : le workspace lui-même, `/dev/null` et les flux
 * standards, les outils système en lecture (`/usr`, `/bin`, `/lib`).
 *
 * Toujours pas un sandbox : un garde-fou explicite, honnête sur sa portée.
 */
const CODE_CHARS = /[|(){}[\]$=,;*?^!<>\\\n"'`]/;
const SHELL_SEPARATORS = /[\s;&|()<>]/;
const DEVICE_ALLOWLIST = new Set([
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
]);
const SYSTEM_READ_ONLY_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];
const SENSITIVE_ROOTS = [
  'app', 'bin', 'boot', 'cache', 'config', 'data', 'dev', 'etc', 'home', 'lib', 'lib64',
  'media', 'mnt', 'opt', 'paperclip', 'proc', 'root', 'run', 'sbin', 'snap', 'srv', 'sys',
  'tmp', 'usr', 'var', 'workspace', 'workspaces',
];
let knownRootsCache: Set<string> | null = null;

function knownRoots(): Set<string> {
  if (!knownRootsCache) {
    knownRootsCache = new Set(SENSITIVE_ROOTS);
    try {
      for (const entry of readdirSync('/')) knownRootsCache.add(entry);
    } catch {
      // Lecture de la racine impossible : la liste fixe suffit.
    }
  }
  return knownRootsCache;
}

/** Un chemin absolu (déjà isolé) sort-il du workspace ? */
function absolutePathEscapes(candidate: string, workspaceRoot: string | undefined, rootIsEscape: boolean): boolean {
  const normalizedPath = path.posix.normalize(candidate);
  if (normalizedPath === '/' || normalizedPath === '//') return rootIsEscape;
  if (isInsideWorkspace(normalizedPath.replace(/\/+$/, ''), workspaceRoot)) return false;
  if (DEVICE_ALLOWLIST.has(normalizedPath) || /^\/dev\/fd\/\d+$/.test(normalizedPath)) return false;
  if (SYSTEM_READ_ONLY_DIRS.some((dir) => normalizedPath === dir || normalizedPath.startsWith(dir + '/'))) {
    return false;
  }
  const first = normalizedPath.split('/')[1] ?? '';
  return knownRoots().has(first);
}

interface ShellWord {
  text: string;
  code: boolean;
  /** Mot (au moins en partie) entre quotes. */
  quoted: boolean;
  /** Numéro de la commande simple (séparée par ; & | ( ) ou un retour ligne). */
  group: number;
}

function matchingParen(command: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return command.length;
}

function collectSubstitutions(text: string, out: string[]): void {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = matchingParen(text, i + 1);
      out.push(text.slice(i + 2, end));
      i = end;
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      out.push(text.slice(i + 1, end === -1 ? undefined : end));
      i = end === -1 ? text.length : end;
    }
  }
}

function splitShellWords(command: string): { words: ShellWord[]; substitutions: string[] } {
  const words: ShellWord[] = [];
  const substitutions: string[] = [];
  let text = '';
  let code = false;
  let quoted = false;
  let inWord = false;
  let group = 0;
  const flush = (): void => {
    if (inWord) words.push({ text, code, quoted, group });
    text = '';
    code = false;
    quoted = false;
    inWord = false;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const piece = command.slice(i + 1, end === -1 ? undefined : end);
      text += piece;
      inWord = true;
      quoted = true;
      if (CODE_CHARS.test(piece)) code = true;
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let piece = '';
      while (j < command.length && command[j] !== '"') {
        // Entre "…", la barre n'échappe que $ ` " \ et le retour ligne
        // (`grep "\.\."` garde ses barres : ce n'est pas `..`).
        if (command[j] === '\\' && j + 1 < command.length && '$`"\\\n'.includes(command[j + 1]!)) {
          piece += command[j + 1];
          j += 2;
          continue;
        }
        piece += command[j];
        j += 1;
      }
      collectSubstitutions(piece, substitutions);
      text += piece;
      inWord = true;
      quoted = true;
      if (CODE_CHARS.test(piece)) code = true;
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const end = command.indexOf('`', i + 1);
      substitutions.push(command.slice(i + 1, end === -1 ? undefined : end));
      flush();
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const end = matchingParen(command, i + 1);
      substitutions.push(command.slice(i + 2, end));
      flush();
      i = end + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      text += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (SHELL_SEPARATORS.test(ch)) {
      flush();
      if (/[;&|()\n]/.test(ch)) group += 1;
      i += 1;
      continue;
    }
    text += ch;
    inWord = true;
    i += 1;
  }
  flush();
  return { words, substitutions };
}

const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`]*/g;

function plainWordEscapes(word: string, workspaceRoot: string | undefined): string | null {
  // Un espace dans un mot ne peut venir que de quotes : c'est un texte (programme
  // jq `.a // .b`, phrase…). Un sous-mot fait seulement de `/` y est un opérateur.
  const quotedText = /\s/.test(word);
  for (const sub of word.split(/\s+/).filter(Boolean)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(sub)) continue;
    if (quotedText && /^\/+$/.test(sub)) continue;
    if (sub === '~' || sub.startsWith('~/') || /^~[a-zA-Z0-9._-]+(\/|$)/.test(sub)) return sub;
    if (/^\$(\{HOME\}|HOME)(\/|$)/.test(sub)) return sub;
    const cleaned = sub.replace(/^[a-zA-Z]+:/, '');
    if (cleaned.split(/[\\/]/).includes('..')) return sub;
    if (sub.startsWith('/') && absolutePathEscapes(sub, workspaceRoot, true)) return sub;
  }
  return null;
}

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox', 'eval']);
const JQ_LIKE = new Set(['jq', 'gojq', 'jaq', 'yq']);

/** Nom de la commande d'un groupe : premier mot qui n'est pas une affectation `A=b`. */
function commandName(words: ShellWord[], group: number): string {
  for (const word of words) {
    if (word.group !== group) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) continue;
    return path.posix.basename(word.text);
  }
  return '';
}

/**
 * La ligne lance-t-elle un interpréteur shell (`bash -c`, `| sh`,
 * `bash <<< …`, `eval`) ? Si oui, tout texte entre quotes de la ligne peut
 * devenir une commande : on l'analyse comme telle (revues A 3320 et 3321).
 */
function lineRunsShell(words: ShellWord[]): boolean {
  const groups = new Set(words.map((w) => w.group));
  for (const group of groups) {
    if (SHELL_INTERPRETERS.has(commandName(words, group))) return true;
  }
  return words.some((w) => !w.quoted && SHELL_INTERPRETERS.has(path.posix.basename(w.text)));
}

function codeWordEscapes(word: string, workspaceRoot: string | undefined, jqProgram = false): string | null {
  const text = word.replace(URL_PATTERN, ' ');
  const dotdot = /(^|[^\w.])\.\.\/|\/\.\.($|[^\w.])/.exec(text);
  if (dotdot) return dotdot[0].trim();
  // `..` isolé (`cd ..; ls`) : le parent — sauf dans un programme jq, où
  // `..` est l'opérateur de descente récursive.
  if (!jqProgram) {
    const bare = /(^|[\s;&|(])\.\.($|[\s;&|)])/.exec(text);
    if (bare) return '..';
  }
  // `..` en chaîne littérale (`chdir("..")`, `open('..')`) : le parent.
  const quotedParent = /(["'`])\.\.\1/.exec(text);
  if (quotedParent) return quotedParent[0];
  const tilde = /(^|[\s"'=(:,])~\/\S*/.exec(text);
  if (tilde) return tilde[0].trim();
  const home = /\$\{?HOME\}?\/\S*/.exec(text);
  if (home) return home[0];
  const candidates = text.matchAll(/(?:^|[^\w.:/~$}\-])(\/[^\s'"`;|&()<>{}[\],]*)/g);
  for (const match of candidates) {
    if (absolutePathEscapes(match[1]!, workspaceRoot, false)) return match[1]!;
  }
  return null;
}

function escapeInCommand(command: string, workspaceRoot: string | undefined, depth: number): string | null {
  if (depth > 8) return '(substitutions trop imbriquées)';
  const { words, substitutions } = splitShellWords(command);
  const runsShell = lineRunsShell(words);
  for (const word of words) {
    // Programme passé à un shell (`bash -c [--] '…'`, `| bash`, `bash <<< '…'`,
    // `eval '…'`) : le texte entre quotes est une commande, on l'analyse comme
    // telle (cd .., cd seul, ls /…) en plus de l'analyse ordinaire.
    if (runsShell && word.quoted) {
      const hit = escapeInCommand(word.text, workspaceRoot, depth + 1);
      if (hit !== null) return hit;
    }
    const jqProgram = JQ_LIKE.has(commandName(words, word.group));
    const hit = word.code
      ? codeWordEscapes(word.text, workspaceRoot, jqProgram)
      : plainWordEscapes(word.text, workspaceRoot);
    if (hit !== null) return hit;
  }
  for (const inner of substitutions) {
    const hit = escapeInCommand(inner, workspaceRoot, depth + 1);
    if (hit !== null) return hit;
  }
  const flat = command.replace(/['"]/g, '').trim();
  // `cd -` : retour au répertoire précédent, hors du workspace.
  if (/(^|[;&|\n]\s*)cd\s+-\s*($|[;&|\n])/.test(flat)) return 'cd -';
  // `cd` seul : retour au $HOME, hors du workspace.
  if (/(^|[;&|\n]\s*)cd\s*($|[;&|\n])/.test(flat)) return 'cd';
  return null;
}

/** Noms de variables dont la valeur est un secret (même règle que la journalisation Paperclip). */
const SECRET_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie|private|credential)/i;

async function runShell(
  root: string,
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  extraEnv: Record<string, string>,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: root,
      detached: true,
      env: {
        // Environnement **minimal**, pas l'héritage complet du serveur.
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: root,
        TMPDIR: path.join(root, '.tmp'),
        LANG: process.env['LANG'] ?? 'C.UTF-8',
        GIT_TERMINAL_PROMPT: '0',
        CI: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const killGroup = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
      try {
        child.kill('SIGKILL');
      } catch {}
    };

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const onAbort = (): void => {
      killGroup();
      finish({ content: 'Commande annulée (run interrompu).', isError: true });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      finish({ content: `Échec du lancement : ${error.message}`, isError: true });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish({
          content: `Commande interrompue après ${Math.round(timeoutMs / 1000)} s (délai dépassé) : ${command}`,
          isError: true,
        });
        return;
      }
      const parts: string[] = [];
      // Lot 8b : seules les valeurs de variables *secrètes* sont masquées.
      // Avant, toute valeur posée était masquée — l'URL de l'API, l'identifiant
      // de l'agent ou du ticket devenaient `[REDACTED]` dans les sorties.
      const secretsToMask = Object.entries(extraEnv)
        .filter(([key, val]) => SECRET_ENV_KEY.test(key) && typeof val === 'string' && val.length >= 4)
        .map(([, val]) => val);
      const mask = (rawText: string): string => {
        let res = rawText;
        for (const s of secretsToMask) {
          res = res.replaceAll(s, '[REDACTED]');
        }
        return res;
      };
      if (stdout.trim().length > 0) parts.push(truncate(mask(stdout.trimEnd())));
      if (stderr.trim().length > 0) parts.push(`[stderr]\n${truncate(mask(stderr.trimEnd()))}`);
      const body = parts.length > 0 ? parts.join('\n\n') : '(aucune sortie)';
      finish({
        content: `code de sortie ${code ?? 'null'}\n\n${body}`,
        isError: code !== 0,
      });
    });
  });
}

/**
 * Prépare le workspace pour le shell : crée le sous-dossier temporaire.
 *
 * Le temporaire du shell est `.tmp` **dans le workspace** (et non `/tmp`),
 * pour deux raisons :
 * - c'est cohérent avec `HOME`, qui pointe déjà sur le workspace ;
 * - `/tmp` est hors workspace, donc la garde de sortie le refuse : sans ce
 *   dossier, l'agent ne peut ni utiliser `mktemp`, ni écrire le résultat
 *   d'un `curl` dans un fichier.
 *
 * Idempotent : on peut l'appeler à chaque run.
 */
export async function prepareWorkspace(root: string): Promise<void> {
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true }).catch(() => undefined);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Lot 11a — outils de code au niveau de Claude Code.
 *
 * Constat mesuré avant ce lot (B-outils.md §1) :
 * - aucune modification ciblée : `write_file` réécrit tout le fichier ;
 * - `search` répondait « Aucune correspondance » quand sa recherche dépassait
 *   8 s (faux négatif silencieux) ;
 * - `read_file` ne numérotait pas les lignes et coupait à 30 000 caractères
 *   sans dire comment lire la suite.
 *
 * Ajouts : `edit_file` (remplacements exacts, tout ou rien, après lecture),
 * `grep` (ripgrep, repli JS signalé), `glob`, `read_file` numéroté et paginé.
 * `search` reste disponible comme alias de `grep` (compatibilité).
 * ───────────────────────────────────────────────────────────────────────── */

/** Réglages internes des outils (tests, diagnostic). Tous optionnels. */
export interface WorkspaceToolOptions {
  /**
   * Chemin de ripgrep. `undefined` : recherche de `rg` dans le PATH ;
   * `null` : force le moteur de repli JavaScript.
   */
  rgPath?: string | null;
  /** Délai maximal d'une recherche `grep` / `glob` / `search` (ms). */
  searchTimeoutMs?: number;
}

const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
/** Taille d'une page de `read_file` (caractères, hors pied de page). */
const READ_PAGE_CHARS = 30_000;
const READ_DEFAULT_LIMIT = 2_000;
const READ_MAX_LINE_CHARS = 2_000;
const READ_MAX_FILE_BYTES = 50 * 1024 * 1024;
const EDIT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const EDIT_MAX_EDITS = 100;
const EDIT_SNIPPET_CONTEXT = 2;
const EDIT_SNIPPET_MAX_LINES = 80;
const GREP_DEFAULT_HEAD_LIMIT = 200;
const GREP_MAX_LINE_CHARS = 400;
const GREP_MAX_CONTEXT = 50;
/** Lignes conservées en mémoire pour la pagination (au-delà : comptées seulement). */
const GREP_MAX_STORED_LINES = 20_000;
const GLOB_DEFAULT_HEAD_LIMIT = 200;
const GLOB_MAX_LISTED = 100_000;

/** Exclusions ripgrep équivalentes à `SECRET_BASENAME_PATTERNS` (insensibles à la casse). */
const SECRET_RG_GLOBS: readonly string[] = [
  '.env',
  '.env.*',
  '.netrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.pem',
  '*.p12',
  '*.pfx',
  '.npmrc',
  'credentials',
  'credentials.json',
  '.git-credentials',
];

/** Types de fichiers reconnus par le moteur de repli (sous-ensemble de `rg --type-list`). */
const JS_ENGINE_TYPES: Record<string, string[]> = {
  ts: ['ts', 'tsx', 'cts', 'mts'],
  js: ['js', 'jsx', 'mjs', 'cjs', 'vue'],
  py: ['py', 'pyi'],
  md: ['md', 'markdown', 'mdx', 'mkd', 'mkdn', 'mdwn', 'mdown'],
  json: ['json', 'jsonl', 'sarif'],
  rust: ['rs'],
  go: ['go'],
  java: ['java', 'jsp', 'jspx', 'properties'],
  css: ['css', 'scss'],
  html: ['htm', 'html', 'ejs'],
  sh: ['sh', 'bash', 'zsh', 'ksh', 'csh'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  sql: ['sql', 'psql'],
  c: ['c', 'h', 'H', 'cats'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'inl'],
  php: ['php', 'php3', 'php4', 'php5', 'phtml'],
  rb: ['rb', 'gemspec'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'svg'],
};

/** Recherche de `rg` dans le PATH (sans lancer de processus). */
export function findRipgrep(envPath: string = process.env['PATH'] ?? ''): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, 'rg');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // absent ici : on continue
    }
  }
  return null;
}

/**
 * Glob → source d'expression régulière ancrée.
 *
 * `**` traverse les répertoires, `*` et `?` s'arrêtent à `/`, `{a,b}` et
 * `[abc]` / `[!abc]` sont reconnus. Fonction **autonome** (aucune référence
 * externe) : son texte est recopié tel quel dans le worker de repli.
 */
function globToRegExpSource(glob: string): string {
  let source = '';
  let inClass = false;
  let braceDepth = 0;
  const text = glob.startsWith('./') ? glob.slice(2) : glob;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (inClass) {
      if (c === ']') {
        inClass = false;
        source += ']';
      } else if (c === '\\') {
        source += '\\\\';
      } else {
        source += c;
      }
      continue;
    }
    if (c === '*') {
      if (text.charAt(i + 1) === '*') {
        const atSegmentStart = i === 0 || text.charAt(i - 1) === '/';
        const next = text.charAt(i + 2);
        if (atSegmentStart && next === '/') {
          source += '(?:.*/)?';
          i += 2;
          continue;
        }
        source += '.*';
        i += 1;
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (c === '?') {
      source += '[^/]';
      continue;
    }
    if (c === '[') {
      inClass = true;
      source += '[';
      if (text.charAt(i + 1) === '!' || text.charAt(i + 1) === '^') {
        source += '^';
        i += 1;
      }
      continue;
    }
    if (c === '{') {
      braceDepth += 1;
      source += '(?:';
      continue;
    }
    if (c === '}' && braceDepth > 0) {
      braceDepth -= 1;
      source += ')';
      continue;
    }
    if (c === ',' && braceDepth > 0) {
      source += '|';
      continue;
    }
    if (c === '\\' && i + 1 < text.length) {
      i += 1;
      source += text.charAt(i).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      continue;
    }
    source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  if (inClass) source += ']';
  return '^' + source + '$';
}

/**
 * Worker du moteur de repli (sans ripgrep) et de `glob`.
 *
 * Un worker plutôt que la boucle principale : une expression régulière
 * catastrophique (`(a+)+$`) ne doit pas figer le run (audit A12), et le délai
 * peut alors couper la recherche net.
 */
const JS_SEARCH_WORKER_SOURCE = `
// Le code évalué peut être traité en CommonJS ou en module ES selon les
// options du processus parent : on n'y suppose pas \`require\`.
const load = typeof require === 'function' ? require : (name) => process.getBuiltinModule(name);
const { parentPort, workerData } = load('node:worker_threads');
const fs = load('node:fs');
const path = load('node:path');
const globToRegExpSource = ${globToRegExpSource.toString()};
(function main() {
const d = workerData;
const secretPatterns = d.secretPatterns.map((p) => new RegExp(p.source, p.flags));
const skipDirs = new Set(d.skipDirs);
const isSecretBase = (name) => secretPatterns.some((p) => p.test(name));
let globRe = null;
let globHasSlash = false;
let regex = null;
try {
  if (d.glob) {
    globRe = new RegExp(globToRegExpSource(d.glob));
    globHasSlash = d.glob.replace(/^\\.\\//, '').includes('/');
  }
  if (d.kind === 'grep') regex = new RegExp(d.pattern, d.ignoreCase ? 'i' : '');
} catch (err) {
  parentPort.postMessage({ error: 'motif invalide : ' + (err && err.message ? err.message : String(err)) });
  return;
}
const startDir = d.startIsFile ? path.dirname(d.start) : d.start;
const files = [];
const listed = [];
let total = 0;
let searched = 0;
let stored = 0;
let linesTruncated = false;

function globOk(full) {
  if (!globRe) return true;
  const target = globHasSlash ? path.relative(startDir, full).split(path.sep).join('/') : path.basename(full);
  return globRe.test(target);
}
function typeOk(name) {
  if (!d.typeExts) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && d.typeExts.includes(name.slice(dot + 1));
}
function grepFile(full) {
  let buf;
  try {
    const st = fs.statSync(full);
    if (st.size > d.maxFileBytes) return;
    buf = fs.readFileSync(full);
  } catch { return; }
  if (buf.subarray(0, 8192).includes(0)) return;
  searched += 1;
  const text = buf.toString('utf8');
  const lines = text.split('\\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].endsWith('\\r') ? lines[i].slice(0, -1) : lines[i];
    lines[i] = line;
    if (regex.test(line)) {
      hits.push(i);
      if (d.mode === 'files_with_matches') break;
    }
  }
  if (hits.length === 0) return;
  const rel = path.relative(d.root, full).split(path.sep).join('/');
  const entry = { path: rel, count: hits.length, lines: [] };
  if (d.mode === 'content') {
    const keep = new Map();
    for (const m of hits) {
      const lo = Math.max(0, m - d.before);
      const hi = Math.min(lines.length - 1, m + d.after);
      for (let j = lo; j <= hi; j += 1) if (!keep.has(j)) keep.set(j, false);
      keep.set(m, true);
    }
    const order = [...keep.keys()].sort((a, b) => a - b);
    for (const j of order) {
      if (stored >= d.maxStoredLines) { linesTruncated = true; break; }
      entry.lines.push({ n: j + 1, text: lines[j], match: keep.get(j) });
      stored += 1;
    }
  }
  files.push(entry);
}
function visit(full, name) {
  if (isSecretBase(name)) return;
  if (d.kind === 'list') {
    if (!globOk(full)) return;
    total += 1;
    if (listed.length < d.maxListed) listed.push(path.relative(d.root, full).split(path.sep).join('/'));
    return;
  }
  if (!typeOk(name) || !globOk(full)) return;
  grepFile(full);
}
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    // Comme ripgrep : on ne suit pas les liens symboliques (confinement).
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(full); continue; }
    if (entry.isFile()) visit(full, entry.name);
  }
}
try {
  if (d.startIsFile) {
    if (d.kind === 'grep') grepFile(d.start); else visit(d.start, path.basename(d.start));
  } else {
    walk(d.start);
  }
  parentPort.postMessage({ result: d.kind === 'list' ? { listed, total } : { files, searched, linesTruncated } });
} catch (err) {
  parentPort.postMessage({ error: err && err.message ? err.message : String(err) });
}
})();
`;

/** Recherche interrompue par le délai : le résultat serait incomplet. */
class SearchTimeout extends Error {
  constructor(timeoutMs: number) {
    super(
      `recherche interrompue après ${(timeoutMs / 1000).toLocaleString('fr-FR')} s (délai dépassé) : résultat INCOMPLET — ` +
        'n’en concluez pas que le motif est absent. Restreignez « path », « glob » ou « type », puis relancez.',
    );
  }
}
class SearchAborted extends Error {
  constructor() {
    super('recherche annulée (run interrompu).');
  }
}
/** ripgrep introuvable au lancement : bascule vers le moteur de repli. */
class RipgrepUnavailable extends Error {}

interface GrepLine {
  n: number;
  text: string;
  match: boolean;
}
interface GrepFile {
  path: string;
  count: number;
  lines: GrepLine[];
}
type GrepMode = 'content' | 'files_with_matches' | 'count';
interface GrepQuery {
  pattern: string;
  ignoreCase: boolean;
  glob: string;
  type: string;
  before: number;
  after: number;
  mode: GrepMode;
  /** Chemin réel de départ (racine, sous-dossier ou fichier). */
  start: string;
  startIsFile: boolean;
}
interface GrepOutcome {
  files: GrepFile[];
  searched: number;
  linesTruncated: boolean;
  engine: 'ripgrep' | 'js';
  warnings: string[];
}

function workerSecretPatterns(): Array<{ source: string; flags: string }> {
  return SECRET_BASENAME_PATTERNS.map((p) => ({ source: p.source, flags: p.flags }));
}

function runJsWorker<T>(data: Record<string, unknown>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SearchAborted());
      return;
    }
    // `execArgv: []` : le worker n'hérite ni de `--input-type=module` ni d'un
    // chargeur (`--import tsx/…`) du processus parent, qui changeraient la
    // façon dont ce code est évalué (mesuré : « require is not defined »).
    const worker = new Worker(JS_SEARCH_WORKER_SOURCE, { eval: true, workerData: data, execArgv: [] });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => undefined);
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new SearchTimeout(timeoutMs))), timeoutMs);
    const onAbort = (): void => settle(() => reject(new SearchAborted()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (msg: { result?: T; error?: string }) => {
      settle(() => (msg.error !== undefined ? reject(new Error(msg.error)) : resolve(msg.result as T)));
    });
    worker.on('error', (err) => settle(() => reject(err)));
    // Une sortie sans message n'est JAMAIS « aucune correspondance ».
    worker.on('exit', () => settle(() => reject(new Error('moteur de recherche arrêté sans résultat'))));
  });
}

async function grepWithJs(
  realRoot: string,
  q: GrepQuery,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GrepOutcome> {
  let typeExts: string[] | null = null;
  if (q.type) {
    const exts = JS_ENGINE_TYPES[q.type];
    if (!exts) {
      throw new ToolRefusal(
        `type « ${q.type} » inconnu du moteur de repli (ripgrep absent) ; types connus : ${Object.keys(JS_ENGINE_TYPES).join(', ')}. Utilisez plutôt « glob ».`,
      );
    }
    typeExts = exts;
  }
  const result = await runJsWorker<{ files: GrepFile[]; searched: number; linesTruncated: boolean }>(
    {
      kind: 'grep',
      root: realRoot,
      start: q.start,
      startIsFile: q.startIsFile,
      pattern: q.pattern,
      ignoreCase: q.ignoreCase,
      glob: q.glob,
      typeExts,
      before: q.before,
      after: q.after,
      mode: q.mode,
      maxStoredLines: GREP_MAX_STORED_LINES,
      maxFileBytes: EDIT_MAX_FILE_BYTES,
      secretPatterns: workerSecretPatterns(),
      skipDirs: [...IGNORED_DIR_SEGMENTS, ...SECRET_PATH_SEGMENTS],
    },
    timeoutMs,
    signal,
  );
  return { ...result, engine: 'js', warnings: [] };
}

/** Texte d'un champ ripgrep JSON (`{text}` ou `{bytes}` en base64). */
function rgText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as { text?: unknown; bytes?: unknown };
  if (typeof v.text === 'string') return v.text;
  if (typeof v.bytes === 'string') return Buffer.from(v.bytes, 'base64').toString('utf8');
  return '';
}

/** Un chemin relatif désigne-t-il un fichier de secrets ? (défense en profondeur) */
function isSecretRelative(relative: string): boolean {
  const segments = relative.split(/[\\/]/);
  if (segments.some((s) => SECRET_PATH_SEGMENTS.includes(s))) return true;
  const base = segments[segments.length - 1] ?? '';
  return SECRET_BASENAME_PATTERNS.some((p) => p.test(base));
}

function grepWithRipgrep(
  rgPath: string,
  realRoot: string,
  q: GrepQuery,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GrepOutcome> {
  // Arguments passés en tableau (aucun shell) ; `--` avant le motif : un motif
  // ou un chemin qui commence par « - » ne peut pas devenir une option.
  const args = ['--json', '--no-config', '--hidden', q.ignoreCase ? '--ignore-case' : '--case-sensitive'];
  if (q.mode === 'content') {
    if (q.before > 0) args.push(`--before-context=${q.before}`);
    if (q.after > 0) args.push(`--after-context=${q.after}`);
  }
  if (q.mode === 'files_with_matches') args.push('--max-count=1');
  if (q.glob) args.push(`--glob=${q.glob}`);
  if (q.type) args.push(`--type=${q.type}`);
  for (const dir of [...IGNORED_DIR_SEGMENTS, ...SECRET_PATH_SEGMENTS]) args.push(`--glob=!${dir}`);
  for (const glob of SECRET_RG_GLOBS) args.push(`--iglob=!${glob}`);
  args.push('--', q.pattern);
  const relStart = path.relative(realRoot, q.start);
  if (relStart.length > 0) args.push(relStart);

  return new Promise<GrepOutcome>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SearchAborted());
      return;
    }
    const child = spawn(rgPath, args, {
      cwd: realRoot,
      detached: true,
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', LANG: process.env['LANG'] ?? 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const byPath = new Map<string, GrepFile>();
    let searched = 0;
    let completed = false;
    let stored = 0;
    let linesTruncated = false;
    let pending = '';
    let stderr = '';
    let settled = false;

    const handle = (line: string): void => {
      if (line.length === 0) return;
      let event: { type?: string; data?: Record<string, unknown> };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      const data = event.data ?? {};
      if (event.type === 'summary') {
        completed = true;
        const stats = data['stats'] as { searches?: unknown } | undefined;
        if (typeof stats?.searches === 'number') searched = stats.searches;
        return;
      }
      if (event.type !== 'match' && event.type !== 'context') return;
      const rel = rgText(data['path']).replace(/^\.\//, '');
      if (rel.length === 0 || isSecretRelative(rel)) return;
      let file = byPath.get(rel);
      if (!file) {
        file = { path: rel, count: 0, lines: [] };
        byPath.set(rel, file);
      }
      const isMatch = event.type === 'match';
      if (isMatch) file.count += 1;
      if (q.mode !== 'content') return;
      if (stored >= GREP_MAX_STORED_LINES) {
        linesTruncated = true;
        return;
      }
      const n = typeof data['line_number'] === 'number' ? (data['line_number'] as number) : 0;
      file.lines.push({ n, text: rgText(data['lines']).replace(/\r?\n$/, ''), match: isMatch });
      stored += 1;
    };

    const killGroup = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // déjà terminé
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // déjà terminé
      }
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      killGroup();
      settle(() => reject(new SearchTimeout(timeoutMs)));
    }, timeoutMs);
    const onAbort = (): void => {
      killGroup();
      settle(() => reject(new SearchAborted()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        handle(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(error.code === 'ENOENT' || error.code === 'EACCES' ? new RipgrepUnavailable(error.message) : error),
      );
    });
    child.on('close', (code) => {
      handle(pending);
      pending = '';
      const warnings = stderr.trim().length > 0 ? [stderr.trim().slice(0, 600)] : [];
      // Sans évènement `summary`, ripgrep n'a pas fini (motif ou type invalide…).
      if (!completed && (code ?? 2) >= 2) {
        settle(() => reject(new Error(`ripgrep a échoué : ${stderr.trim().slice(0, 600) || `code ${code}`}`)));
        return;
      }
      settle(() =>
        resolve({ files: [...byPath.values()], searched, linesTruncated, engine: 'ripgrep', warnings }),
      );
    });
  });
}

function clipLine(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…[${text.length} caractères]`;
}

function formatGrep(
  outcome: GrepOutcome,
  q: GrepQuery,
  headLimit: number,
  offset: number,
  scopeLabel: string,
): string {
  const files = [...outcome.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const notes: string[] = [];
  if (outcome.engine === 'js') {
    notes.push('[moteur de repli JS : ripgrep absent — regex JavaScript, .gitignore non appliqué]');
  }
  if (outcome.warnings.length > 0) notes.push(`[avertissements ripgrep : ${outcome.warnings.join(' ').replace(/\s+/g, ' ')}]`);
  if (files.length === 0) {
    return [
      `Aucune correspondance pour /${q.pattern}/${scopeLabel} (recherche complète : ${outcome.searched} fichier(s) examiné(s)).`,
      ...notes,
    ].join('\n');
  }

  // Entrées paginables ; `sep` marque un saut entre groupes non contigus.
  const entries: Array<{ text: string; sep: boolean }> = [];
  let totalMatches = 0;
  for (const file of files) totalMatches += file.count;
  if (q.mode === 'files_with_matches') {
    for (const file of files) entries.push({ text: file.path, sep: false });
  } else if (q.mode === 'count') {
    for (const file of files) entries.push({ text: `${file.path}:${file.count}`, sep: false });
  } else {
    const withContext = q.before > 0 || q.after > 0;
    for (const file of files) {
      const lines = [...file.lines].sort((a, b) => a.n - b.n);
      let previous = -1;
      for (const line of lines) {
        if (withContext && entries.length > 0 && line.n !== previous + 1) entries.push({ text: '--', sep: true });
        const marker = line.match ? ':' : '-';
        entries.push({ text: `${file.path}${marker}${line.n}${marker}${clipLine(line.text, GREP_MAX_LINE_CHARS)}`, sep: false });
        previous = line.n;
      }
    }
  }

  const realEntries = entries.filter((e) => !e.sep).length;
  const out: string[] = [];
  let index = 0;
  let shown = 0;
  let size = 0;
  for (const entry of entries) {
    if (entry.sep) {
      if (out.length > 0 && index >= offset) out.push(entry.text);
      continue;
    }
    index += 1;
    if (index <= offset) continue;
    if (shown >= headLimit || size + entry.text.length + 1 > MAX_OUTPUT_CHARS) break;
    out.push(entry.text);
    shown += 1;
    size += entry.text.length + 1;
  }
  while (out.length > 0 && out[out.length - 1] === '--') out.pop();

  const label = q.mode === 'content' ? 'lignes' : 'fichiers';
  if (offset >= realEntries) {
    return `offset ${offset} au-delà de la fin : ${realEntries} ${label} au total.`;
  }
  const end = offset + shown;
  const footer: string[] = [];
  if (q.mode === 'count') footer.push(`Total : ${totalMatches} ligne(s) correspondante(s) dans ${files.length} fichier(s).`);
  if (end < realEntries) {
    footer.push(`[${label} ${offset + 1}–${end} sur ${realEntries} ; suite : même appel avec "offset": ${end}]`);
  }
  if (outcome.linesTruncated) {
    footer.push(`[plus de ${GREP_MAX_STORED_LINES} lignes : seules les premières sont paginables — affinez la recherche]`);
  }
  return [out.join('\n'), ...footer, ...notes].filter((s) => s.length > 0).join('\n');
}

function asBoolField(input: unknown, key: string): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const value = (input as Record<string, unknown>)[key];
  return value === true || value === 'true';
}

/** Entier ≥ 0 (0 accepté, contrairement à `asNumberField`). */
function asCountField(input: unknown, key: string, fallback: number): number {
  if (typeof input !== 'object' || input === null) return fallback;
  const value = (input as Record<string, unknown>)[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Écriture atomique : fichier temporaire voisin puis `rename` (jamais de fichier à moitié écrit). */
async function writeFileAtomic(target: string, content: string, mode: number): Promise<void> {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Page numérotée d'un texte (`n<TAB>ligne`), bornée en lignes et en caractères. */
function renderNumberedPage(raw: string, offset: number, limit: number, requestedPath: string): string {
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  if (total === 0) return `(fichier vide : ${requestedPath}, 0 ligne)`;
  if (offset > total) {
    return `offset ${offset} au-delà de la fin du fichier (${total} ligne(s)). Relancez avec un offset entre 1 et ${total}.`;
  }
  const lastWanted = Math.min(total, offset - 1 + limit);
  const out: string[] = [];
  let size = 0;
  let end = offset - 1;
  for (let n = offset; n <= lastWanted; n += 1) {
    let line = lines[n - 1] ?? '';
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const row = `${n}\t${clipLine(line, READ_MAX_LINE_CHARS)}`;
    if (out.length > 0 && size + row.length + 1 > READ_PAGE_CHARS) break;
    out.push(row);
    size += row.length + 1;
    end = n;
  }
  let text = out.join('\n');
  if (end < total) {
    text += `\n\n[lignes ${offset}–${end} sur ${total} ; suite : read_file({"path":${JSON.stringify(requestedPath)},"offset":${end + 1}})]`;
  }
  return text;
}

interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** Erreur d'édition : aucune écriture n'a eu lieu. */
class EditError extends Error {}

function parseEdits(input: unknown): EditSpec[] {
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['edits'] : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new EditError('« edits » doit être une liste non vide de {old_string, new_string, replace_all?}.');
  }
  if (raw.length > EDIT_MAX_EDITS) throw new EditError(`au plus ${EDIT_MAX_EDITS} edits par appel.`);
  return raw.map((item, i) => {
    const e = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof e['old_string'] !== 'string' || typeof e['new_string'] !== 'string') {
      throw new EditError(`edit ${i + 1} : « old_string » et « new_string » (chaînes) sont obligatoires.`);
    }
    return {
      oldString: e['old_string'],
      newString: e['new_string'],
      replaceAll: e['replace_all'] === true || e['replace_all'] === 'true',
    };
  });
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count += 1;
  return count;
}

/**
 * Applique les edits en mémoire, dans l'ordre. Lève `EditError` au premier
 * edit invalide : rien n'est écrit (tout ou rien). Renvoie le nouveau texte
 * et les plages de lignes modifiées (dans le nouveau texte).
 */
function applyEdits(original: string, edits: EditSpec[]): { text: string; replacements: number; ranges: Array<[number, number]> } {
  const crlf = original.includes('\r\n');
  const toFileEol = (s: string): string => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  let text = original;
  let replacements = 0;
  let ranges: Array<[number, number]> = [];
  edits.forEach((edit, i) => {
    const label = `edit ${i + 1}`;
    if (edit.oldString.length === 0) {
      throw new EditError(`${label} : « old_string » est vide. Pour créer ou réécrire un fichier, utilisez write_file.`);
    }
    if (edit.oldString === edit.newString) {
      throw new EditError(`${label} : « old_string » et « new_string » sont identiques — rien à modifier.`);
    }
    const oldS = toFileEol(edit.oldString);
    const newS = toFileEol(edit.newString);
    const positions: number[] = [];
    for (let at = text.indexOf(oldS); at !== -1; at = text.indexOf(oldS, at + oldS.length)) positions.push(at);
    if (positions.length === 0) {
      const hint = /^\s*\d+\t/m.test(edit.oldString)
        ? ' N’incluez pas le préfixe « numéro<TAB> » affiché par read_file.'
        : ' Vérifiez espaces, indentation et caractères exacts (relisez avec read_file).';
      throw new EditError(`${label} : « old_string » introuvable dans le fichier.${hint}`);
    }
    if (positions.length > 1 && !edit.replaceAll) {
      throw new EditError(
        `${label} : « old_string » apparaît ${positions.length} occurrences. Ajoutez du contexte pour la rendre unique, ou passez "replace_all": true.`,
      );
    }
    const delta = countNewlines(newS) - countNewlines(oldS);
    const occurrenceLines: number[] = [];
    let line = 1;
    let scanned = 0;
    for (const at of positions) {
      line += countNewlines(text.slice(scanned, at));
      scanned = at;
      occurrenceLines.push(line);
    }
    ranges = ranges.map(([start, end]) => {
      const before = occurrenceLines.filter((l) => l < start).length;
      return [start + before * delta, end + before * delta] as [number, number];
    });
    occurrenceLines.forEach((l, k) => {
      const start = l + k * delta;
      ranges.push([start, start + countNewlines(newS)]);
    });
    let next = '';
    let cursor = 0;
    for (const at of positions) {
      next += text.slice(cursor, at) + newS;
      cursor = at + oldS.length;
    }
    text = next + text.slice(cursor);
    replacements += positions.length;
  });
  return { text, replacements, ranges };
}

/** Lignes modifiées avec un peu de contexte, numérotées comme read_file. */
function renderEditSnippet(text: string, ranges: Array<[number, number]>): string {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  const total = Math.max(1, lines.length);
  const windows = ranges
    .map(([s, e]) => [Math.max(1, s - EDIT_SNIPPET_CONTEXT), Math.min(total, e + EDIT_SNIPPET_CONTEXT)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  const out: string[] = [];
  let shown = 0;
  let hidden = 0;
  for (const [s, e] of merged) {
    if (out.length > 0) out.push('…');
    for (let n = s; n <= e; n += 1) {
      if (shown >= EDIT_SNIPPET_MAX_LINES) {
        hidden += 1;
        continue;
      }
      let line = lines[n - 1] ?? '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      out.push(`${n}\t${clipLine(line, GREP_MAX_LINE_CHARS)}`);
      shown += 1;
    }
  }
  while (out.length > 0 && out[out.length - 1] === '…') out.pop();
  if (hidden > 0) out.push(`[… ${hidden} autre(s) ligne(s) modifiée(s) non affichée(s) — relisez avec read_file si besoin]`);
  return out.join('\n');
}

/**
 * Construit l'ensemble d'outils. Le workspace est capturé ici : les outils ne
 * prennent jamais de racine en paramètre, donc le modèle ne peut pas la
 * déplacer.
 *
 * `extraEnv` porte les variables que l'adaptateur pose pour l'agent — en
 * pratique le JWT de run Paperclip (`PAPERCLIP_API_KEY`), sans lequel l'agent
 * ne pourrait appeler l'API du board depuis son shell. Il est fusionné dans
 * l'environnement du `shell` uniquement ; jamais journalisé.
 *
 * Un appel = un run : l'état « fichier lu » d'`edit_file` vit dans cette
 * fermeture et disparaît avec le run.
 */
export function buildWorkspaceTools(
  root: string,
  signal: AbortSignal | undefined,
  extraEnv: Record<string, string> = {},
  options: WorkspaceToolOptions = {},
): WorkspaceTool[] {
  /** Empreinte du contenu connu de l'agent, par chemin réel (lu ou écrit par lui). */
  const knownContent = new Map<string, string>();
  const searchTimeoutMs = Math.max(1, options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
  let rgResolved = false;
  let rgPath: string | null = null;
  const ripgrep = (): string | null => {
    if (!rgResolved) {
      rgPath = options.rgPath === undefined ? findRipgrep() : options.rgPath;
      rgResolved = true;
    }
    return rgPath;
  };

  /** Prépare une requête grep à partir de l'entrée du modèle (chemin confiné). */
  const prepareGrep = async (
    input: unknown,
    defaults: { ignoreCase: boolean; glob: string; mode: GrepMode },
  ): Promise<{ q: GrepQuery; realRoot: string; scopeLabel: string }> => {
    const pattern = asField(input, 'pattern');
    if (pattern.length === 0) throw new ToolRefusal('motif vide');
    const realRoot = await fs.realpath(root);
    const requested = asField(input, 'path') || '.';
    const start = await resolveConfinedPath(root, requested);
    const stat = await fs.stat(start).catch(() => null);
    if (!stat) throw new ToolRefusal(`chemin introuvable : ${requested}`);
    if (start !== realRoot) assertNotSecret(start, realRoot);
    const type = asField(input, 'type').trim();
    if (type && !/^[A-Za-z0-9_+-]+$/.test(type)) throw new ToolRefusal(`type invalide : ${type}`);
    const glob = asField(input, 'glob').trim() || defaults.glob;
    if (glob) {
      try {
        new RegExp(globToRegExpSource(glob));
      } catch {
        throw new ToolRefusal(`glob invalide : ${glob}`);
      }
    }
    const modeRaw = asField(input, 'output_mode') || defaults.mode;
    if (modeRaw !== 'content' && modeRaw !== 'files_with_matches' && modeRaw !== 'count') {
      throw new ToolRefusal(`output_mode inconnu : ${modeRaw} (content, files_with_matches ou count)`);
    }
    const context = Math.min(GREP_MAX_CONTEXT, asCountField(input, '-C', asCountField(input, 'context', 0)));
    const q: GrepQuery = {
      pattern,
      ignoreCase: defaults.ignoreCase || asBoolField(input, '-i'),
      glob,
      type,
      before: Math.min(GREP_MAX_CONTEXT, asCountField(input, '-B', context)),
      after: Math.min(GREP_MAX_CONTEXT, asCountField(input, '-A', context)),
      mode: modeRaw,
      start,
      startIsFile: stat.isFile(),
    };
    const rel = path.relative(realRoot, start);
    return { q, realRoot, scopeLabel: rel ? ` dans ${rel}` : ' dans le workspace' };
  };

  const runGrep = async (realRoot: string, q: GrepQuery): Promise<GrepOutcome> => {
    const rg = ripgrep();
    if (rg) {
      try {
        return await grepWithRipgrep(rg, realRoot, q, searchTimeoutMs, signal);
      } catch (error) {
        if (!(error instanceof RipgrepUnavailable)) throw error;
        rgPath = null;
      }
    }
    return grepWithJs(realRoot, q, searchTimeoutMs, signal);
  };

  return [
    {
      spec: {
        name: 'read_file',
        description: [
          'Lit un fichier texte du workspace. Chaque ligne est préfixée par son numéro puis une tabulation (« 12<TAB>texte ») ;',
          'ce préfixe ne fait PAS partie du fichier (ne le recopiez pas dans edit_file).',
          `Par défaut : ${READ_DEFAULT_LIMIT} lignes depuis la ligne 1, ${READ_PAGE_CHARS} caractères au plus par page.`,
          'Si le fichier est plus long, un pied de page « [lignes a–b sur N ; suite : read_file({…"offset":b+1})] » indique comment lire la suite.',
          'Pour un gros fichier, lisez seulement la zone utile (offset/limit) ou cherchez d’abord avec grep.',
          'Obligatoire avant edit_file sur ce fichier. Chemins relatifs à la racine du workspace ; secrets (.env, clés) refusés.',
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Chemin relatif au workspace.' },
            offset: { type: 'integer', description: 'Première ligne à lire (1-indexée, défaut 1).' },
            limit: { type: 'integer', description: `Nombre de lignes à lire (défaut ${READ_DEFAULT_LIMIT}).` },
          },
          required: ['path'],
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const requested = asField(input, 'path');
          const realPath = await resolveConfinedPath(root, requested);
          assertNotSecret(realPath, await fs.realpath(root));
          const stat = await fs.stat(realPath);
          if (stat.isDirectory()) {
            throw new ToolRefusal('la cible est un répertoire — utilisez `list_dir` ou `glob`');
          }
          if (stat.size > READ_MAX_FILE_BYTES) {
            throw new ToolRefusal(
              `fichier trop gros (${stat.size} octets) : cherchez la zone utile avec grep, ou utilisez shell (head, sed -n).`,
            );
          }
          const buffer = await fs.readFile(realPath);
          if (buffer.subarray(0, 8192).includes(0)) {
            throw new ToolRefusal(
              `fichier binaire (${stat.size} octets) : read_file ne lit que du texte. Utilisez shell (file, xxd | head) si besoin.`,
            );
          }
          const raw = buffer.toString('utf8');
          // Revue A 58202 : un fichier qui n'est pas de l'UTF-8 valide ne doit
          // jamais devenir éditable — edit_file réécrirait tout le texte décodé
          // et corromprait les lignes non visées (é Latin-1 → U+FFFD).
          const utf8Valid = Buffer.from(raw, 'utf8').equals(buffer);
          if (utf8Valid) knownContent.set(realPath, sha256(raw));
          else knownContent.delete(realPath);
          const offset = asNumberField(input, 'offset', 1);
          const limit = asNumberField(input, 'limit', READ_DEFAULT_LIMIT);
          const page = renderNumberedPage(raw, offset, limit, requested);
          return {
            content: utf8Valid
              ? page
              : `${page}\n[Attention : « ${requested} » n'est pas de l'UTF-8 valide (caractères affichés en �). edit_file refusera ce fichier : utilisez shell (iconv, sed) pour le modifier.]`,
            isError: false,
          };
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
    {
      spec: {
        name: 'write_file',
        description: [
          'Écrit un fichier COMPLET dans le workspace, en créant les répertoires manquants. Écrase le fichier existant.',
          'Pour créer un fichier ou le réécrire entièrement. Pour modifier quelques lignes d’un fichier existant, préférez edit_file :',
          'moins coûteux et sans risque d’écraser le reste du fichier.',
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Chemin relatif au workspace.' },
            content: { type: 'string', description: 'Contenu complet du fichier.' },
          },
          required: ['path', 'content'],
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const realRoot = await fs.realpath(root);
          const realPath = await resolveConfinedPath(root, asField(input, 'path'));
          assertNotSecret(realPath, realRoot);
          // Contrôle local en plus de la validation de la boucle : un appel
          // direct sans `content` ne doit jamais tronquer un fichier (A8b).
          const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['content'] : undefined;
          if (typeof raw !== 'string') {
            return { content: 'write_file : « content » (chaîne) est obligatoire ; aucun fichier modifié.', isError: true };
          }
          const content = raw;
          await fs.mkdir(path.dirname(realPath), { recursive: true });
          await fs.writeFile(realPath, content, 'utf8');
          // L'agent connaît ce contenu : il peut l'éditer sans relecture.
          knownContent.set(realPath, sha256(content));
          const relative = path.relative(realRoot, realPath);
          return {
            content: `Écrit ${relative} (${Buffer.byteLength(content, 'utf8')} octets).`,
            isError: false,
          };
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
    {
      spec: {
        name: 'edit_file',
        description: [
          'Modifie un fichier existant par remplacements EXACTS de texte, sans le réécrire : à préférer à write_file pour toute modification partielle.',
          'Règles : (1) lisez d’abord le fichier avec read_file pendant ce run ; s’il a changé depuis (shell, autre outil), relisez-le.',
          '(2) « old_string » est recopié à l’identique du fichier (espaces et indentation compris), SANS le préfixe « numéro<TAB> » de read_file.',
          '(3) chaque « old_string » doit être unique dans le fichier : ajoutez quelques lignes de contexte, ou « replace_all »: true pour remplacer toutes les occurrences.',
          '(4) les edits s’appliquent dans l’ordre, chacun sur le résultat du précédent ; si un seul échoue, AUCUN n’est appliqué (tout ou rien).',
          'Exemple : {"path":"src/a.ts","edits":[{"old_string":"return 1;","new_string":"return 2;"}]}.',
          'Le retour montre les lignes modifiées, numérotées, avec un peu de contexte.',
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Chemin relatif au workspace (fichier existant).' },
            edits: {
              type: 'array',
              description: 'Remplacements appliqués dans l’ordre, tout ou rien.',
              items: {
                type: 'object',
                properties: {
                  old_string: { type: 'string', description: 'Texte exact à remplacer (unique sauf replace_all).' },
                  new_string: { type: 'string', description: 'Texte de remplacement (différent de old_string).' },
                  replace_all: { type: 'boolean', description: 'Remplacer toutes les occurrences (défaut false).' },
                },
                required: ['old_string', 'new_string'],
              },
            },
          },
          required: ['path', 'edits'],
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const realRoot = await fs.realpath(root);
          const requested = asField(input, 'path');
          const realPath = await resolveConfinedPath(root, requested);
          assertNotSecret(realPath, realRoot);
          const stat = await fs.stat(realPath).catch(() => null);
          if (!stat) {
            throw new ToolRefusal(`fichier introuvable : ${requested} — edit_file ne crée pas de fichier, utilisez write_file.`);
          }
          if (!stat.isFile()) throw new ToolRefusal(`« ${requested} » n’est pas un fichier.`);
          if (stat.size > EDIT_MAX_FILE_BYTES) {
            throw new ToolRefusal(`fichier trop gros pour edit_file (${stat.size} octets).`);
          }
          const edits = parseEdits(input);
          const currentBytes = await fs.readFile(realPath);
          const current = currentBytes.toString('utf8');
          if (!Buffer.from(current, 'utf8').equals(currentBytes)) {
            knownContent.delete(realPath);
            throw new EditError(
              `« ${requested} » n’est pas de l’UTF-8 valide : edit_file le corromprait. Aucune modification appliquée ; utilisez shell (iconv, sed) pour ce fichier.`,
            );
          }
          const known = knownContent.get(realPath);
          if (known === undefined) {
            throw new EditError(
              `lisez d’abord « ${requested} » avec read_file (au moins une fois pendant ce run) avant de l’éditer. Aucune modification appliquée.`,
            );
          }
          if (sha256(current) !== known) {
            knownContent.delete(realPath);
            throw new EditError(
              `« ${requested} » a changé depuis votre dernière lecture (shell ou autre processus) : relisez-le avec read_file, puis refaites l’édition. Aucune modification appliquée.`,
            );
          }
          let applied: ReturnType<typeof applyEdits>;
          try {
            applied = applyEdits(current, edits);
          } catch (error) {
            if (error instanceof EditError) {
              throw new EditError(`aucune modification appliquée (tout ou rien) — ${error.message}`);
            }
            throw error;
          }
          await writeFileAtomic(realPath, applied.text, stat.mode & 0o7777);
          knownContent.set(realPath, sha256(applied.text));
          const relative = path.relative(realRoot, realPath);
          return {
            content:
              `Modifié ${relative} : ${applied.replacements} remplacement(s) (${edits.length} edit(s)).\n\n` +
              renderEditSnippet(applied.text, applied.ranges),
            isError: false,
          };
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
    {
      spec: {
        name: 'list_dir',
        description:
          'Liste le contenu d’un répertoire du workspace (un seul niveau). Les répertoires de dépendances et de build sont masqués. Pour chercher des fichiers par motif dans toute l’arborescence, utilisez glob.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Chemin relatif (défaut : racine).' },
          },
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const realRoot = await fs.realpath(root);
          const requested = asField(input, 'path') || '.';
          const realPath = await resolveConfinedPath(root, requested);
          const entries = await fs.readdir(realPath, { withFileTypes: true });
          const rows = entries
            .filter((entry) => !IGNORED_DIR_SEGMENTS.includes(entry.name))
            .slice(0, MAX_LIST_ENTRIES)
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort();
          const relative = path.relative(realRoot, realPath) || '.';
          return {
            content: `${relative} :\n${rows.join('\n') || '(vide)'}`,
            isError: false,
          };
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
    {
      spec: {
        name: 'grep',
        description: [
          'Recherche une expression régulière dans le CONTENU des fichiers du workspace (ripgrep). À préférer à `shell` + grep/rg.',
          'Syntaxe regex de ripgrep (proche de PCRE, sans lookaround) ; échappez les caractères spéciaux pour un texte littéral (ex. « foo\\(\\) »).',
          'Sensible à la casse sauf « -i »: true. Ignore .git, node_modules, dist, build, les fichiers .gitignore et les secrets.',
          'output_mode : « content » (défaut ; lignes « fichier:ligne:texte », contexte « fichier-ligne-texte », groupes séparés par « -- »),',
          '« files_with_matches » (chemins seulement : le moins coûteux pour repérer où chercher), « count » (nombre de lignes par fichier).',
          '« -A »/« -B »/« -C » : lignes de contexte (mode content). « glob » filtre les fichiers (« *.ts », « *.{ts,tsx} », « src/**/*.md ») ; « type » par langage (ts, py, md, json, rust…).',
          `Résultats paginés par « head_limit » (défaut ${GREP_DEFAULT_HEAD_LIMIT}) et « offset » ; le pied de page indique la suite.`,
          '« Aucune correspondance » n’est renvoyé QUE si la recherche est complète ; un délai dépassé est une ERREUR (résultat incomplet).',
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Expression régulière à chercher.' },
            path: { type: 'string', description: 'Fichier ou répertoire où chercher (défaut : racine du workspace).' },
            glob: { type: 'string', description: 'Filtre de fichiers, ex. « *.ts » ou « *.{ts,tsx} ».' },
            type: { type: 'string', description: 'Type de fichier ripgrep, ex. « ts », « py », « md ».' },
            output_mode: {
              type: 'string',
              enum: ['content', 'files_with_matches', 'count'],
              description: 'content (défaut), files_with_matches ou count.',
            },
            '-i': { type: 'boolean', description: 'Insensible à la casse.' },
            '-A': { type: 'integer', description: 'Lignes de contexte après chaque correspondance.' },
            '-B': { type: 'integer', description: 'Lignes de contexte avant chaque correspondance.' },
            '-C': { type: 'integer', description: 'Lignes de contexte avant et après.' },
            head_limit: { type: 'integer', description: `Nombre maximal d’entrées renvoyées (défaut ${GREP_DEFAULT_HEAD_LIMIT}).` },
            offset: { type: 'integer', description: 'Entrées à sauter (pagination, défaut 0).' },
          },
          required: ['pattern'],
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const { q, realRoot, scopeLabel } = await prepareGrep(input, { ignoreCase: false, glob: '', mode: 'content' });
          const outcome = await runGrep(realRoot, q);
          const headLimit = asNumberField(input, 'head_limit', GREP_DEFAULT_HEAD_LIMIT);
          const offset = asCountField(input, 'offset', 0);
          return { content: formatGrep(outcome, q, headLimit, offset, scopeLabel), isError: false };
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
    {
      spec: {
        name: 'glob',
        description: [
          'Liste les fichiers du workspace dont le chemin correspond à un motif glob, triés par chemin.',
          'Motif sans « / » : comparé au NOM du fichier, à toute profondeur (« *.ts », « *.{ts,tsx} », « README* »).',
          'Motif avec « / » : comparé au chemin relatif à « path » (« src/**/*.test.ts », « docs/*.md »). « ** » traverse les répertoires.',
          'Ignore .git, node_modules, dist, build, les liens symboliques et les fichiers de secrets.',
          `Plafond « head_limit » (défaut ${GLOB_DEFAULT_HEAD_LIMIT}) avec « offset » ; le total est toujours indiqué.`,
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Motif glob, ex. « **/*.ts ».' },
            path: { type: 'string', description: 'Répertoire de départ (défaut : racine).' },
            head_limit: { type: 'integer', description: `Nombre maximal de chemins renvoyés (défaut ${GLOB_DEFAULT_HEAD_LIMIT}).` },
            offset: { type: 'integer', description: 'Chemins à sauter (pagination, défaut 0).' },
          },
          required: ['pattern'],
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const pattern = asField(input, 'pattern').trim();
          if (pattern.length === 0) throw new ToolRefusal('motif vide');
          try {
            new RegExp(globToRegExpSource(pattern));
          } catch {
            throw new ToolRefusal(`glob invalide : ${pattern}`);
          }
          const realRoot = await fs.realpath(root);
          const requested = asField(input, 'path') || '.';
          const start = await resolveConfinedPath(root, requested);
          const stat = await fs.stat(start).catch(() => null);
          if (!stat?.isDirectory()) throw new ToolRefusal(`répertoire introuvable : ${requested}`);
          const result = await runJsWorker<{ listed: string[]; total: number }>(
            {
              kind: 'list',
              root: realRoot,
              start,
              startIsFile: false,
              glob: pattern,
              maxListed: GLOB_MAX_LISTED,
              secretPatterns: workerSecretPatterns(),
              skipDirs: [...IGNORED_DIR_SEGMENTS, ...SECRET_PATH_SEGMENTS],
            },
            searchTimeoutMs,
            signal,
          );
          const scope = path.relative(realRoot, start) || '.';
          if (result.total === 0) {
            return { content: `Aucun fichier ne correspond à « ${pattern} » sous ${scope} (parcours complet).`, isError: false };
          }
          const sorted = [...result.listed].sort();
          const headLimit = asNumberField(input, 'head_limit', GLOB_DEFAULT_HEAD_LIMIT);
          const offset = asCountField(input, 'offset', 0);
          const page = sorted.slice(offset, offset + headLimit);
          const end = offset + page.length;
          const lines = [...page];
          if (end < result.total || offset > 0) {
            lines.push(
              end < result.total
                ? `[fichiers ${offset + 1}–${end} sur ${result.total} ; suite : même appel avec "offset": ${end}, ou motif plus précis]`
                : `[fichiers ${offset + 1}–${end} sur ${result.total}]`,
            );
          }
          if (result.total > result.listed.length) {
            lines.push(`[seuls les ${result.listed.length} premiers chemins sont paginables — affinez le motif]`);
          }
          return { content: lines.join('\n'), isError: false };
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
    {
      spec: {
        name: 'search',
        description:
          'Ancien nom de grep, gardé pour compatibilité : recherche INSENSIBLE à la casse, « glob » = liste d’extensions (« ts » ou « ts,md »). Préférez grep (modes, contexte, chemin, pagination).',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Expression régulière.' },
            glob: { type: 'string', description: 'Filtre d’extension, ex. « ts » ou « ts,md ».' },
            maxResults: { type: 'integer', description: 'Plafond de résultats (défaut 200).' },
          },
          required: ['pattern'],
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const extensions = asField(input, 'glob')
            .split(',')
            .map((value) => value.trim().replace(/^\*?\./, ''))
            .filter((value) => /^[A-Za-z0-9_+-]+$/.test(value));
          const glob =
            extensions.length === 0 ? '' : extensions.length === 1 ? `*.${extensions[0]}` : `*.{${extensions.join(',')}}`;
          const compat = { pattern: asField(input, 'pattern') };
          const { q, realRoot, scopeLabel } = await prepareGrep(compat, { ignoreCase: true, glob, mode: 'content' });
          const outcome = await runGrep(realRoot, q);
          const maxResults = asNumberField(input, 'maxResults', GREP_DEFAULT_HEAD_LIMIT);
          return { content: formatGrep(outcome, q, maxResults, 0, scopeLabel), isError: false };
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
    {
      spec: {
        name: 'shell',
        description:
          'Exécute une commande shell dans le workspace. Utile pour pnpm, git, tests et builds. Non interactif : les commandes qui attendent une saisie échouent. Pour lire, chercher ou modifier des fichiers, préférez read_file, grep, glob et edit_file. Ne poussez jamais vers un dépôt distant (git push) : le workspace local est la source de vérité.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Commande à exécuter.' },
            timeoutMs: {
              type: 'integer',
              description: `Délai maximal en millisecondes (défaut ${DEFAULT_SHELL_TIMEOUT_MS}).`,
            },
          },
          required: ['command'],
        },
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const command = asField(input, 'command');
          if (command.trim().length === 0) throw new ToolRefusal('commande vide');
          if (detectsRemotePublication(command)) {
            throw new ToolRefusal(
              'publication distante interdite : le workspace local est la source de vérité et aucun distant n’est garanti.',
            );
          }
          if (detectsSecretAccess(command)) {
            throw new ToolRefusal(
              'accès refusé : la commande cible un fichier sensible protégé. Utilisez le coffre Paperclip pour les identifiants.',
            );
          }
          const escape = findWorkspaceEscape(command, root);
          if (escape !== null) {
            throw new ToolRefusal(
              `sortie du workspace interdite : « ${escape.slice(0, 120)} » vise un chemin hors du répertoire de travail. ` +
                'Utilisez des chemins relatifs, et .tmp/ pour les fichiers temporaires.',
            );
          }
          const timeoutMs = Math.min(
            asNumberField(input, 'timeoutMs', DEFAULT_SHELL_TIMEOUT_MS),
            600_000,
          );
          return await runShell(root, command, timeoutMs, signal, extraEnv);
        } catch (error) {
          return { content: describeToolError(error), isError: true };
        }
      },
    },
  ];
}

/**
 * Message d'erreur destiné au modèle. Les refus (`ToolRefusal`) sont explicites
 * et définitifs — le modèle doit changer d'approche, pas réessayer à
 * l'identique ; les autres erreurs sont des échecs d'E/S classiques.
 */
function describeToolError(error: unknown): string {
  if (error instanceof ToolRefusal) return `Refusé : ${error.message}`;
  if (error instanceof Error) return `Erreur : ${error.message}`;
  return `Erreur inconnue : ${String(error)}`;
}

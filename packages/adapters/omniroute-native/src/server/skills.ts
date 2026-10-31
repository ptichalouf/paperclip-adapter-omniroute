/**
 * Skills Paperclip — montage des skills d'un run pour un adaptateur sans CLI.
 *
 * Les adaptateurs natifs comme `claude_local` délèguent la lecture des skills
 * à leur CLI : le serveur materialize les skills sur disque, le CLI les
 * découvre dans son répertoire (`~/.claude/skills`) et n'y pense plus.
 *
 * Notre adaptateur n'a **aucun CLI** derrière : il ne fournit que
 * l'inférence. Il faut donc faire le travail du CLI : découvrir les skills du
 * run, les rendre lisibles, et les annoncer au modèle.
 *
 * Le modèle n'a pas besoin du contenu complet des skills dans son prompt :
 * le skill `paperclip` fait 70 ko, et l'injecter en entier à chaque tour
 * coûterait plus cher que la tâche. On procède donc comme un agent outillé :
 *
 * - le **prompt système** porte un index (nom + description + clé de lecture) ;
 * - un outil `read_skill` lit le contenu d'un skill **à la demande**.
 *
 * C'est ce qui rend le montage utile sans être coûteux : le modèle lit le
 * skill dont il a besoin, quand il en a besoin.
 *
 * Le confinement est ici **plus simple** que celui du workspace : on ne lit
 * que dans le répertoire d'un skill monté, résolu puis vérifié.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
  buildRuntimeMountedSkillSnapshot,
} from '@paperclipai/adapter-utils/server-utils';
import type { AdapterSkillContext, AdapterSkillSnapshot } from '@paperclipai/adapter-utils';

import type { WorkspaceTool, ToolResult } from './tools.js';

/** Un skill monté pour ce run. */
export interface SkillMount {
  /** Identifiant Paperclip du skill (`paperclipai/paperclip/paperclip`). */
  key: string;
  /** Nom court, celui du dossier (`paperclip`). */
  runtimeName: string;
  /** Répertoire source du skill, hors workspace. */
  source: string;
  /** Description lue dans le frontmatter, pour l'index du prompt. */
  description: string | null;
}

/**
 * Skills du run, réduits à ceux qui sont **désirables**.
 *
 * `config.paperclipRuntimeSkills` porte la bibliothèque de l'entreprise
 * entière ; `paperclipSkillSync` porte le choix de l'opérateur. On ne monte
 * que le choix, plus le skill opérationnel Paperclip (le resolver « legacy »
 * l'ajoute toujours : c'est lui qui donne à l'agent le contrat d'appel de
 * l'API du board).
 */
export function resolveDesiredSkillMounts(
  config: Record<string, unknown>,
): SkillMount[] {
  const entries = normalizeEntries(config['paperclipRuntimeSkills']);
  if (entries.length === 0) return [];

  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, entries));
  const mounts: SkillMount[] = [];

  for (const entry of entries) {
    if (!desired.has(entry.key)) continue;
    const source = typeof entry.source === 'string' ? entry.source.trim() : '';
    if (source.length === 0) continue;
    mounts.push({
      key: entry.key,
      runtimeName:
        typeof entry.runtimeName === 'string' && entry.runtimeName.trim().length > 0
          ? entry.runtimeName.trim()
          : entry.key,
      source,
      description: null,
    });
  }

  return mounts;
}

/**
 * Index des skills montés, destiné au prompt système.
 *
 * Une ligne par skill : nom, description, et la façon de le lire. Sans
 * description, l'agent ne sait pas à quoi le skill sert et ne le lira jamais.
 */
export function buildSkillIndex(mounts: SkillMount[]): string {
  if (mounts.length === 0) return '';
  const lines = mounts.map((mount) => {
    const description = mount.description?.trim();
    const header = description ? `- **${mount.runtimeName}** — ${description}` : `- **${mount.runtimeName}**`;
    return `${header}\n  lire : \`read_skill({ "skill": "${mount.runtimeName}" })\``;
  });
  return [
    '## Skills Paperclip',
    '',
    'Ces skills sont montés pour ce run. Lis celui qui correspond à ta tâche',
    '**avant** de l\'appliquer — un skill contient le contrat exact',
    '(API, formats, règles) à suivre.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Outil `read_skill` : lit un fichier d'un skill monté.
 *
 * Le chemin est relatif au répertoire du skill. On résout le chemin réel et on
 * vérifie qu'il reste dans le skill : sans cela, `../../` permettrait de lire
 * n'importe quel fichier du serveur.
 */
export function buildReadSkillTool(mounts: SkillMount[]): WorkspaceTool {
  const byName = new Map<string, SkillMount>();
  for (const mount of mounts) byName.set(mount.runtimeName, mount);

  return {
    spec: {
      name: 'read_skill',
      description:
        'Lit un skill Paperclip monté pour ce run. Le paramètre « skill » est le nom du skill (voir la section Skills du prompt système), « file » est le fichier relatif à lire dans le skill (défaut : SKILL.md). ' +
        `Lecture par pages de ${SKILL_PAGE_CHARS} caractères au plus : si le fichier est plus long, un pied de page « [caractères a–b sur N ; suite : read_skill({…"offset":b})] » donne l’appel exact pour lire la suite. Lisez toutes les pages utiles avant d’appliquer le skill.`,
      input_schema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Nom du skill monté.' },
          file: { type: 'string', description: 'Fichier relatif dans le skill (défaut SKILL.md).' },
          offset: { type: 'integer', description: 'Position de départ en caractères (défaut 0), donnée par le pied de page.' },
          limit: { type: 'integer', description: `Nombre maximal de caractères (défaut et plafond ${SKILL_PAGE_CHARS}).` },
        },
        required: ['skill'],
      },
    },
    async run(input: unknown): Promise<ToolResult> {
      try {
        const skill = asField(input, 'skill');
        const mount = byName.get(skill);
        if (!mount) {
          const available = [...byName.keys()].join(', ') || '(aucun)';
          return {
            content: `Skill inconnu : « ${skill} ». Skills montés : ${available}.`,
            isError: true,
          };
        }
        const file = asField(input, 'file');
        const relative = file || 'SKILL.md';
        const raw = await readWithinSkill(mount.source, relative);
        const offset = asCount(input, 'offset', 0);
        const limit = Math.min(SKILL_PAGE_CHARS, Math.max(1, asCount(input, 'limit', SKILL_PAGE_CHARS)));
        return { content: renderSkillPage(raw, offset, limit, skill, file), isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `Erreur : ${message}`, isError: true };
      }
    },
  };
}

/**
 * Taille d'une page de `read_skill` (lot 11a). Avant, le skill était coupé à
 * 30 000 caractères sans moyen de lire la suite : le skill `paperclip`
 * (≈ 70 000 caractères) n'était lu qu'aux deux cinquièmes. La page reste
 * sous 30 000 caractères, pied de page compris.
 */
const SKILL_PAGE_CHARS = 29_000;

/**
 * Page d'un fichier de skill, découpée en caractères. La coupe se fait de
 * préférence après une fin de ligne ; le pied de page donne l'appel exact
 * pour lire la suite. Un fichier qui tient en une page est rendu tel quel.
 */
function renderSkillPage(raw: string, offset: number, limit: number, skill: string, file: string): string {
  const total = raw.length;
  if (offset === 0 && total <= limit) return raw;
  if (offset >= total) {
    return `offset ${offset} au-delà de la fin du fichier (${total} caractères).`;
  }
  let end = Math.min(total, offset + limit);
  if (end < total) {
    const newline = raw.lastIndexOf('\n', end - 1);
    if (newline >= offset + Math.floor(limit / 2)) end = newline + 1;
  }
  const page = raw.slice(offset, end);
  if (end >= total) return `${page}\n\n[caractères ${offset}–${end} sur ${total} ; fin du fichier]`;
  const next: Record<string, string | number> = { skill };
  if (file) next['file'] = file;
  next['offset'] = end;
  return `${page}\n\n[caractères ${offset}–${end} sur ${total} ; suite : read_skill(${JSON.stringify(next)})]`;
}

/** Entier ≥ 0 lu dans l'entrée d'outil (nombre ou chaîne numérique). */
function asCount(input: unknown, key: string, fallback: number): number {
  if (typeof input !== 'object' || input === null) return fallback;
  const value = (input as Record<string, unknown>)[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Lit un fichier dans un skill, en refusant toute sortie du répertoire. */
async function readWithinSkill(skillDir: string, relative: string): Promise<string> {
  const base = await fs.realpath(skillDir);
  const target = path.resolve(base, relative);
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch {
    throw new Error(`fichier introuvable dans le skill : ${relative}`);
  }
  if (realTarget !== base && !realTarget.startsWith(base + path.sep)) {
    throw new Error(`chemin hors du skill : ${relative}`);
  }
  return fs.readFile(realTarget, 'utf8');
}

/**
 * Instantané des skills pour l'API Paperclip (`GET /agents/:id/skills`).
 *
 * On s'appuie sur les helpers natifs : ils savent traduire la préférence de
 * l'opérateur en entrées d'aperçu (état `configured` / `available` /
 * `missing`), ce qui est exactement le contrat attendu par le board.
 */
export async function listOmniRouteSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOmniRouteSkillSnapshot(ctx.config);
}

/**
 * Synchronisation des skills.
 *
 * L'état désiré est **persisté par Paperclip** dans la config de l'agent
 * (clé `paperclipSkillSync`) : l'adaptateur n'a rien à écrire. Le montage,
 * lui, est refait à chaque run. On renvoie donc l'instantané, comme le font
 * les adaptateurs natifs.
 */
export async function syncOmniRouteSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildOmniRouteSkillSnapshot(ctx.config);
}

async function buildOmniRouteSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  // Le répertoire du module sert à retrouver les skills fournis avec le
  // paquet quand la config n'en liste aucun : sans cela, la liste serait
  // vide et le board n'afficherait rien.
  const moduleDir = path.dirname(new URL(import.meta.url).pathname);
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);

  return buildRuntimeMountedSkillSnapshot({
    adapterType: 'omniroute_native',
    availableEntries,
    desiredSkills,
    configuredDetail:
      'Monté pour ce run : le skill est lisible par l\'agent via l\'outil `read_skill`.',
    missingDetail:
      'Paperclip ne trouve pas ce skill dans son répertoire de skills : il ne sera pas monté pour ce run.',
  });
}

/** Entrées de `paperclipRuntimeSkills`, forme normalisée. */
function normalizeEntries(
  value: unknown,
): Array<{ key: string; runtimeName?: string | null; source?: unknown }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ key: string; runtimeName?: string | null; source?: unknown }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { key?: unknown; runtimeName?: unknown; source?: unknown };
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    if (key.length === 0) continue;
    const runtimeName =
      typeof entry.runtimeName === 'string' && entry.runtimeName.trim().length > 0
        ? entry.runtimeName.trim()
        : null;
    out.push({ key, runtimeName, source: entry.source });
  }
  return out;
}

/** Lecture d'un champ texte d'un objet d'entrée d'outil. */
function asField(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return '';
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Ne garde que les skills **lisibles**.
 *
 * Une entrée de `paperclipRuntimeSkills` peut pointer vers une source
 * disparue (version supprimée, materialisation échouée). Monter un skill
 * illisible donnerait au modèle une entrée d'index qui ne mène nulle part :
 * pire que pas d'entrée du tout.
 */
export async function filterAvailableMounts(mounts: SkillMount[]): Promise<SkillMount[]> {
  const out: SkillMount[] = [];
  for (const mount of mounts) {
    const stat = await fs.stat(mount.source).catch(() => null);
    if (stat?.isDirectory()) out.push(mount);
  }
  return out;
}

/**
 * Descriptions des skills montés, lues dans le frontmatter de leur
 * `SKILL.md`. Une description manquante ne bloque pas le montage : l'index
 * affichera le skill sans description.
 */
export async function enrichSkillDescriptions(mounts: SkillMount[]): Promise<SkillMount[]> {
  const out: SkillMount[] = [];
  for (const mount of mounts) {
    out.push({ ...mount, description: await readSkillDescription(mount.source) });
  }
  return out;
}

async function readSkillDescription(skillDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    const description = match[1]?.match(/^description:\s*(.*)$/m)?.[1]?.trim();
    if (!description) return null;
    // Un frontmatter YAML peut replier la description sur plusieurs lignes :
    // on retire les guillemets et on recolle les lignes suivantes.
    return description.replace(/^['"]|['"]$/g, '').trim() || null;
  } catch {
    return null;
  }
}


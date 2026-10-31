/**
 * Bundle d'instructions — le « AGENTS.md » de l'agent.
 *
 * Paperclip gère un bundle d'instructions par agent : un répertoire de
 * fichiers dont l'entrée (`AGENTS.md`) est l'instruction durable. Le serveur
 * en dépose le chemin dans la config d'exécution, sous la clé
 * `instructionsFilePath` (clé configurable via `instructionsPathKey`).
 *
 * Les adaptateurs natifs le transmettent à leur CLI, qui l'injecte dans le
 * prompt système. Nous n'avons pas de CLI : il faut le lire nous-mêmes.
 *
 * Deux points de conception :
 *
 * 1. **L'entrée du bundle est un fichier, pas un répertoire.** Le serveur
 *    donne le chemin du *fichier* d'entrée. Le reste du répertoire (références,
 *    scripts) est ce que l'agent doit pouvoir consulter — donc il doit aussi
 *    être lisible.
 * 2. **Un bundle volumineux ne va pas en entier dans le prompt.** On injecte
 *    l'entrée (le contrat) dans le prompt système, et on donne à l'agent un
 *    moyen de lire le reste à la demande.
 *
 * On s'appuie sur le montage des skills pour la partie « lecture à la
 * demande » : un bundle d'instructions est un répertoire de référence, pas un
 * skill, mais la mécanique de lecture/confinement est la même.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';

import type { WorkspaceTool, ToolResult } from './tools.js';

/**
 * Clé de config qui porte le chemin du bundle.
 *
 * Le serveur lit `instructionsPathKey` de l'adaptateur ; il vaut
 * `instructionsFilePath` par défaut. On lit les deux, dans cet ordre, pour
 * rester compatible avec un serveur qui ne lirait pas la clé personnalisée.
 */
export const DEFAULT_INSTRUCTIONS_PATH_KEY = 'instructionsFilePath';

/** Taille maximale de l'instruction injectée dans le prompt système. */
export const MAX_INSTRUCTIONS_CHARS = 60_000;

/**
 * Chemin du bundle d'instructions, lu dans la config d'exécution.
 */
export function resolveInstructionsFilePath(
  config: Record<string, unknown>,
  pathKey: string = DEFAULT_INSTRUCTIONS_PATH_KEY,
): string | null {
  const candidates = [pathKey, DEFAULT_INSTRUCTIONS_PATH_KEY];
  for (const key of candidates) {
    const value = config[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Lit le bundle d'instructions d'un run.
 *
 * Renvoie `null` quand il n'y a rien à charger — c'est le cas normal, pas
 * une erreur. Un fichier illisible, en revanche, remonte une erreur : un
 * bundle présent mais illisible est un problème d'opérateur, et le taire
 * ferait croire à l'agent qu'il n'a pas d'instructions.
 */
export async function loadInstructionsBundle(
  ctx: AdapterExecutionContext,
  pathKey: string = DEFAULT_INSTRUCTIONS_PATH_KEY,
): Promise<InstructionsBundle | null> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const filePath = resolveInstructionsFilePath(config, pathKey);
  if (!filePath) return null;

  let entry: string;
  try {
    entry = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Bundle d'instructions illisible (${filePath}) : ${reason}. Vérifiez le chemin dans la configuration de l'agent.`,
    );
  }

  const dir = path.dirname(filePath);
  const truncated = entry.length > MAX_INSTRUCTIONS_CHARS;
  const content = truncated ? entry.slice(0, MAX_INSTRUCTIONS_CHARS) : entry;

  return {
    filePath,
    dir,
    content,
    truncated,
    originalLength: entry.length,
  };
}

export interface InstructionsBundle {
  /** Chemin du fichier d'entrée, tel que donné par le serveur. */
  filePath: string;
  /** Répertoire du bundle : les fichiers de référence sont à côté. */
  dir: string;
  /** Contenu de l'entrée, éventuellement tronqué. */
  content: string;
  /** Vrai si l'entrée dépassait la limite d'injection. */
  truncated: boolean;
  /** Longueur réelle de l'entrée sur le disque. */
  originalLength: number;
}

/**
 * Bloc d'instructions pour le prompt système.
 *
 * Le contenu vient **avant** le reste : ce sont les instructions de l'agent,
 * elles priment sur la description de l'outil et sur l'index des skills.
 */
export function buildInstructionsSection(bundle: InstructionsBundle | null): string {
  if (!bundle) return '';
  const lines = [
    '## Instructions de l\'agent',
    '',
    bundle.content.trim(),
  ];
  if (bundle.truncated) {
    lines.push(
      '',
      `_Note : l'instruction a été tronquée à ${MAX_INSTRUCTIONS_CHARS} caractères (longueur réelle : ${bundle.originalLength}). Les fichiers de référence sont dans \`${bundle.dir}\`._`,
    );
  }
  return lines.join('\n');
}

/**
 * Outil `read_instructions_file` : lit un fichier du bundle d'instructions.
 *
 * Le bundle contient souvent des références (`references/*.md`) que l'agent
 * doit pouvoir consulter sans que tout tienne dans le prompt. Le chemin est
 * relatif au répertoire du bundle, résolu puis vérifié : aucune sortie.
 */
export function buildReadInstructionsTool(bundle: InstructionsBundle | null): WorkspaceTool | null {
  if (!bundle) return null;

  return {
    spec: {
      name: 'read_instructions_file',
      description:
        'Lit un fichier du bundle d\'instructions de cet agent. Le paramètre « file » est le chemin relatif au bundle (ex. « references/plan.md »).',
      input_schema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Chemin relatif dans le bundle d\'instructions.' },
        },
        required: ['file'],
      },
    },
    async run(input: unknown): Promise<ToolResult> {
      try {
        const relative = asField(input, 'file');
        if (relative.length === 0) {
          return { content: 'Paramètre « file » vide.', isError: true };
        }
        const base = await fs.realpath(bundle.dir);
        const target = path.resolve(base, relative);
        let realTarget: string;
        try {
          realTarget = await fs.realpath(target);
        } catch {
          return {
            content: `Fichier introuvable dans le bundle d'instructions : ${relative}`,
            isError: true,
          };
        }
        if (realTarget !== base && !realTarget.startsWith(base + path.sep)) {
          return {
            content: `Chemin hors du bundle d'instructions : ${relative}`,
            isError: true,
          };
        }
        const content = await fs.readFile(realTarget, 'utf8');
        return { content, isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `Erreur : ${message}`, isError: true };
      }
    },
  };
}

/** Lecture d'un champ texte d'un objet d'entrée d'outil. */
function asField(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return '';
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

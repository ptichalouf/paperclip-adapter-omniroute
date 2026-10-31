/**
 * Lot 11a — aides communes aux tests des outils de code.
 *
 * Un jeu d'outils = un run : l'état « fichier lu » d'`edit_file` vit dans la
 * fermeture de `buildWorkspaceTools`, il faut donc garder le même jeu entre
 * `read_file` et `edit_file`.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWorkspaceTools, type ToolResult, type WorkspaceTool } from '../../src/server/tools.js';

export interface Toolset {
  run(name: string, input: unknown): Promise<ToolResult>;
  tools: WorkspaceTool[];
}

export function toolset(root: string, options: Record<string, unknown> = {}): Toolset {
  // Quatrième paramètre optionnel (lot 11a) : moteur de recherche et délai.
  const build = buildWorkspaceTools as unknown as (
    r: string,
    s: AbortSignal | undefined,
    e: Record<string, string>,
    o: Record<string, unknown>,
  ) => WorkspaceTool[];
  const tools = build(root, undefined, {}, options);
  return {
    tools,
    async run(name, input) {
      const tool = tools.find((t) => t.spec.name === name);
      if (!tool) throw new Error(`outil absent : ${name}`);
      return tool.run(input);
    },
  };
}

export async function makeWorkspace(prefix: string): Promise<{ outer: string; root: string }> {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(outer, 'workspace');
  await fs.mkdir(root);
  return { outer, root };
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
}

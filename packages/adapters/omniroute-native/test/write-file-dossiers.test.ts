/**
 * Lot 18d — `write_file` crée les répertoires manquants, comme annoncé dans sa
 * description (parité avec l'outil Write de claude_local).
 *
 * Mesuré sur le banc du 31/10 (main 14e8cc1) : 3 des 12 erreurs d'outil
 * étaient « Refusé : répertoire parent introuvable : …/banc/T01-on-… » —
 * la résolution confinée refusait tout chemin dont le parent n'existait pas
 * encore, avant même le `mkdir -p` de write_file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { makeWorkspace, toolset, type Toolset } from './support/code-tools-helpers.js';

let outer: string;
let root: string;
let t: Toolset;

beforeEach(async () => {
  ({ outer, root } = await makeWorkspace('lot18d-'));
  t = toolset(root);
});
afterEach(async () => {
  await fs.rm(outer, { recursive: true, force: true });
});

describe('write_file — répertoires manquants', () => {
  it('crée plusieurs niveaux de répertoires manquants (cas du banc)', async () => {
    const res = await t.run('write_file', { path: 'banc/T01-on-10311414/analyse.md', content: '# Analyse\n' });
    expect(res.isError).toBe(false);
    expect(await fs.readFile(path.join(root, 'banc/T01-on-10311414/analyse.md'), 'utf8')).toBe('# Analyse\n');
  });

  it('chemin absolu dans le workspace avec parents manquants : accepté', async () => {
    const target = path.join(root, 'a/b/c.txt');
    const res = await t.run('write_file', { path: target, content: 'x' });
    expect(res.isError).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe('x');
  });

  it('parents manquants HORS du workspace : toujours refusé, rien créé', async () => {
    const res = await t.run('write_file', { path: '../dehors/neuf/x.txt', content: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/hors du workspace/);
    await expect(fs.stat(path.join(outer, 'dehors'))).rejects.toThrow();
  });

  it('lien symbolique vers l’extérieur suivi de répertoires manquants : refusé, rien créé', async () => {
    await fs.mkdir(path.join(outer, 'cible'));
    await fs.symlink(path.join(outer, 'cible'), path.join(root, 'lien'));
    const res = await t.run('write_file', { path: 'lien/neuf/sous/x.txt', content: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/hors du workspace/);
    await expect(fs.stat(path.join(outer, 'cible', 'neuf'))).rejects.toThrow();
  });

  it('répertoire de secrets avec parents manquants : refusé', async () => {
    const res = await t.run('write_file', { path: '.ssh/neuf/id_ed25519', content: 'x' });
    expect(res.isError).toBe(true);
  });

  it('read_file sur un fichier dont le parent n’existe pas : erreur claire, pas de création', async () => {
    const res = await t.run('read_file', { path: 'absent/fichier.txt' });
    expect(res.isError).toBe(true);
    await expect(fs.stat(path.join(root, 'absent'))).rejects.toThrow();
  });
});

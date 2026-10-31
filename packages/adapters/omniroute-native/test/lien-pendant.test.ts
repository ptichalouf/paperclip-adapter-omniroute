/**
 * Lot 18e — un lien symbolique PENDANT (cible absente) ne doit jamais permettre
 * d'écrire hors du workspace (trouvaille qa_reviewer, revue A de la PR #23,
 * carte t_d9199316 ; défaut préexistant sur main 8b5c94f).
 *
 * `fs.realpath` échoue sur un lien pendant ; la résolution le traitait comme un
 * segment « manquant » et `writeFile` suivait ensuite le lien vers l'extérieur.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { makeWorkspace, toolset, type Toolset } from './support/code-tools-helpers.js';

let outer: string;
let root: string;
let t: Toolset;
const exists = async (p: string) => fs.lstat(p).then(() => true, () => false);

beforeEach(async () => {
  ({ outer, root } = await makeWorkspace('lot18e-'));
  t = toolset(root);
});
afterEach(async () => {
  await fs.rm(outer, { recursive: true, force: true });
});

describe('lien symbolique pendant', () => {
  it('final, vers l’extérieur : write_file refuse et ne crée rien dehors', async () => {
    await fs.symlink(path.join(outer, 'fuite.txt'), path.join(root, 'pendant'));
    const res = await t.run('write_file', { path: 'pendant', content: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/lien symbolique/);
    expect(await exists(path.join(outer, 'fuite.txt'))).toBe(false);
  });

  it('final, vers l’intérieur du workspace : refusé aussi (cible non résolue)', async () => {
    await fs.symlink(path.join(root, 'absent.txt'), path.join(root, 'pendant-interne'));
    const res = await t.run('write_file', { path: 'pendant-interne', content: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/lien symbolique/);
  });

  it('intermédiaire, vers l’extérieur, avec sous-dossiers manquants : refusé, rien créé', async () => {
    await fs.mkdir(path.join(outer, 'cible'));
    await fs.symlink(path.join(outer, 'cible', 'absent'), path.join(root, 'pendant'));
    const res = await t.run('write_file', { path: 'pendant/neuf/x.txt', content: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/lien symbolique/);
    expect(await exists(path.join(outer, 'cible', 'absent'))).toBe(false);
  });

  it('edit_file sur un lien pendant : refusé', async () => {
    await fs.symlink(path.join(outer, 'fuite2.txt'), path.join(root, 'pendant3'));
    const res = await t.run('edit_file', { path: 'pendant3', edits: [{ old_string: 'a', new_string: 'b' }] });
    expect(res.isError).toBe(true);
    expect(await exists(path.join(outer, 'fuite2.txt'))).toBe(false);
  });

  it('non-régression : un lien valide vers l’intérieur reste utilisable', async () => {
    await fs.writeFile(path.join(root, 'vrai.txt'), 'a');
    await fs.symlink(path.join(root, 'vrai.txt'), path.join(root, 'lien-ok'));
    const res = await t.run('write_file', { path: 'lien-ok', content: 'b' });
    expect(res.isError).toBe(false);
    expect(await fs.readFile(path.join(root, 'vrai.txt'), 'utf8')).toBe('b');
  });
});

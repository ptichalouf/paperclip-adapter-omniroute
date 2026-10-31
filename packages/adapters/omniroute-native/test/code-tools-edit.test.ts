/**
 * Lot 11a — `edit_file` : modification ciblée, atomique, après lecture.
 *
 * Avant ce lot, la seule façon de changer une ligne était `write_file`, qui
 * réécrit tout le fichier (coût en tokens de sortie, risque d'écraser du code).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { makeWorkspace, toolset, writeFiles, type Toolset } from './support/code-tools-helpers.js';

let outer: string;
let root: string;
let t: Toolset;

const SOURCE = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}', ''].join('\n');

beforeEach(async () => {
  ({ outer, root } = await makeWorkspace('lot11a-edit-'));
  await writeFiles(root, { 'src/a.ts': SOURCE, 'dup.txt': 'x\nx\nx\n', '.env': 'TOKEN=fictif\n' });
  t = toolset(root);
});
afterEach(async () => {
  await fs.rm(outer, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');

describe('edit_file — modification ciblée', () => {
  it('est proposé au modèle avec path et edits obligatoires', () => {
    const spec = t.tools.find((x) => x.spec.name === 'edit_file')?.spec;
    expect(spec).toBeDefined();
    expect((spec!.input_schema as { required: string[] }).required).toEqual(['path', 'edits']);
  });

  it('applique un remplacement unique et renvoie les lignes modifiées numérotées', async () => {
    await t.run('read_file', { path: 'src/a.ts' });
    const res = await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: 'return 1;', new_string: 'return 42;' }] });
    expect(res.isError).toBe(false);
    expect(await read('src/a.ts')).toBe(SOURCE.replace('return 1;', 'return 42;'));
    expect(res.content).toMatch(/^\s*2\t {2}return 42;$/m);
    // Retour compact : pas le fichier entier.
    expect(res.content).not.toContain('return 2;');
  });

  it('applique plusieurs remplacements dans l’ordre, en une seule écriture', async () => {
    await t.run('read_file', { path: 'src/a.ts' });
    const res = await t.run('edit_file', {
      path: 'src/a.ts',
      edits: [
        { old_string: 'return 1;', new_string: 'return 10;' },
        { old_string: 'return 2;', new_string: 'return 20;' },
        { old_string: 'return 10;', new_string: 'return 11;' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(await read('src/a.ts')).toBe(SOURCE.replace('return 1;', 'return 11;').replace('return 2;', 'return 20;'));
  });

  it('est atomique : un edit invalide = aucun changement sur le disque', async () => {
    await t.run('read_file', { path: 'src/a.ts' });
    const res = await t.run('edit_file', {
      path: 'src/a.ts',
      edits: [
        { old_string: 'return 1;', new_string: 'return 10;' },
        { old_string: 'introuvable', new_string: 'y' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('edit 2');
    expect(await read('src/a.ts')).toBe(SOURCE);
    // Aucun fichier temporaire laissé derrière.
    expect((await fs.readdir(path.join(root, 'src'))).sort()).toEqual(['a.ts']);
  });

  it('refuse une occurrence non unique en donnant le nombre, sauf replace_all', async () => {
    await t.run('read_file', { path: 'dup.txt' });
    const res = await t.run('edit_file', { path: 'dup.txt', edits: [{ old_string: 'x', new_string: 'y' }] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('3 occurrences');
    expect(await read('dup.txt')).toBe('x\nx\nx\n');

    const all = await t.run('edit_file', { path: 'dup.txt', edits: [{ old_string: 'x', new_string: 'y', replace_all: true }] });
    expect(all.isError).toBe(false);
    expect(await read('dup.txt')).toBe('y\ny\ny\n');
  });

  it('refuse old_string identique à new_string, ou vide', async () => {
    await t.run('read_file', { path: 'src/a.ts' });
    const same = await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: 'return 1;', new_string: 'return 1;' }] });
    expect(same.isError).toBe(true);
    const empty = await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: '', new_string: 'z' }] });
    expect(empty.isError).toBe(true);
    expect(await read('src/a.ts')).toBe(SOURCE);
  });

  it('exige une lecture préalable du fichier pendant le run', async () => {
    const res = await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: 'return 1;', new_string: 'return 9;' }] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('read_file');
    expect(await read('src/a.ts')).toBe(SOURCE);
  });

  it('refuse si le fichier a changé depuis la lecture, puis accepte après relecture', async () => {
    await t.run('read_file', { path: 'src/a.ts' });
    await fs.writeFile(path.join(root, 'src/a.ts'), SOURCE.replace('return 2;', 'return 3;'));
    const res = await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: 'return 1;', new_string: 'return 9;' }] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/relis|relire/i);
    expect(await read('src/a.ts')).toContain('return 1;');

    await t.run('read_file', { path: 'src/a.ts' });
    const ok = await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: 'return 1;', new_string: 'return 9;' }] });
    expect(ok.isError).toBe(false);
    expect(await read('src/a.ts')).toContain('return 3;');
  });

  it('enchaîne deux éditions sans relecture (l’état lu suit ses propres écritures)', async () => {
    await t.run('read_file', { path: 'src/a.ts' });
    expect((await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: 'return 1;', new_string: 'return 5;' }] })).isError).toBe(false);
    expect((await t.run('edit_file', { path: 'src/a.ts', edits: [{ old_string: 'return 5;', new_string: 'return 6;' }] })).isError).toBe(false);
    expect(await read('src/a.ts')).toContain('return 6;');
  });

  it('refuse toute sortie du workspace et les fichiers de secrets', async () => {
    await fs.writeFile(path.join(outer, 'outside.txt'), 'dehors\n');
    for (const p of ['../outside.txt', path.join(outer, 'outside.txt'), '/etc/hosts']) {
      const res = await t.run('edit_file', { path: p, edits: [{ old_string: 'dehors', new_string: 'pris' }] });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/hors du workspace|introuvable/);
    }
    expect(await fs.readFile(path.join(outer, 'outside.txt'), 'utf8')).toBe('dehors\n');

    const env = await t.run('edit_file', { path: '.env', edits: [{ old_string: 'fictif', new_string: 'autre' }] });
    expect(env.isError).toBe(true);
    expect(env.content).toContain('sensible');
  });

  it('conserve les droits du fichier et gère les fins de ligne CRLF', async () => {
    const script = path.join(root, 'run.sh');
    await fs.writeFile(script, '#!/bin/sh\r\necho un\r\necho deux\r\n');
    await fs.chmod(script, 0o755);
    await t.run('read_file', { path: 'run.sh' });
    const res = await t.run('edit_file', { path: 'run.sh', edits: [{ old_string: 'echo un\necho deux', new_string: 'echo 1\necho 2' }] });
    expect(res.isError).toBe(false);
    expect(await fs.readFile(script, 'utf8')).toBe('#!/bin/sh\r\necho 1\r\necho 2\r\n');
    expect((await fs.stat(script)).mode & 0o777).toBe(0o755);
  });
});

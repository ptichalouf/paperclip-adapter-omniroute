/**
 * Lot 11a — correctif de la revue A (commentaire Gitea 58202) : `edit_file`
 * corrompait en silence les lignes non visées d'un fichier non UTF-8
 * (« café » en Latin-1 : `é` = 0xE9 devenait U+FFFD après une édition de la
 * ligne suivante). Désormais : read_file prévient, edit_file refuse, octets
 * intacts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { makeWorkspace, toolset, type Toolset } from './support/code-tools-helpers.js';

let outer: string;
let root: string;
let t: Toolset;
const LATIN1 = Buffer.from('636166e90a783d310a', 'hex'); // "caf\xe9\nx=1\n"

beforeEach(async () => {
  ({ outer, root } = await makeWorkspace('lot11a-enc-'));
  await fs.writeFile(path.join(root, 'latin1.txt'), LATIN1);
  await fs.writeFile(path.join(root, 'utf8.txt'), 'café\nx=1\n', 'utf8');
  t = toolset(root);
});
afterEach(async () => {
  await fs.rm(outer, { recursive: true, force: true });
});

describe('edit_file — fichier non UTF-8 (revue A 58202)', () => {
  it('refuse l’édition et laisse les octets intacts', async () => {
    const read = await t.run('read_file', { path: 'latin1.txt' });
    expect(read.isError).toBe(false);
    expect(read.content).toMatch(/pas de l'UTF-8 valide/);
    const res = await t.run('edit_file', { path: 'latin1.txt', edits: [{ old_string: 'x=1', new_string: 'x=2' }] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/UTF-8/);
    expect((await fs.readFile(path.join(root, 'latin1.txt'))).equals(LATIN1)).toBe(true);
  });

  it('refuse aussi si le fichier devient non UTF-8 après la lecture', async () => {
    await t.run('read_file', { path: 'utf8.txt' });
    await fs.writeFile(path.join(root, 'utf8.txt'), LATIN1);
    const res = await t.run('edit_file', { path: 'utf8.txt', edits: [{ old_string: 'x=1', new_string: 'x=2' }] });
    expect(res.isError).toBe(true);
    expect((await fs.readFile(path.join(root, 'utf8.txt'))).equals(LATIN1)).toBe(true);
  });

  it('un fichier UTF-8 avec accents reste éditable, accents conservés', async () => {
    await t.run('read_file', { path: 'utf8.txt' });
    const res = await t.run('edit_file', { path: 'utf8.txt', edits: [{ old_string: 'x=1', new_string: 'x=2' }] });
    expect(res.isError).toBe(false);
    expect(await fs.readFile(path.join(root, 'utf8.txt'), 'utf8')).toBe('café\nx=2\n');
  });
});

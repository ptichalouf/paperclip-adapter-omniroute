/**
 * Lot 11a — `grep` (ripgrep, repli JS), `glob` et l'alias `search`.
 *
 * Constat avant ce lot : `search` renvoyait « Aucune correspondance » quand
 * sa recherche dépassait 8 s — un faux négatif silencieux. Un délai dépassé
 * doit être une ERREUR explicite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import * as toolsModule from '../src/server/tools.js';
import { makeWorkspace, toolset, writeFiles, type Toolset } from './support/code-tools-helpers.js';

let outer: string;
let root: string;

const FILES: Record<string, string> = {
  'src/a.ts': 'const alpha = 1;\nconst Beta = 2;\n// TODO alpha\nexport { alpha };\n',
  'src/b.ts': 'import { alpha } from "./a";\nconsole.log(alpha);\n',
  'src/deep/c.tsx': 'export const Alpha = () => null;\n',
  'docs/guide.md': '# Guide\nalpha dans la doc\nrm -rf tmp\n',
  'notes.txt': 'ligne 1\nligne 2\ncible\nligne 4\nligne 5\nligne 6\nligne 7\ncible\nligne 9\n',
  'node_modules/pkg/index.ts': 'const alpha = "dépendance";\n',
  '.env': 'ALPHA_TOKEN=fictif-alpha\n',
  'conf/.npmrc': 'alpha=fictif\n',
};

beforeEach(async () => {
  ({ outer, root } = await makeWorkspace('lot11a-grep-'));
  await writeFiles(root, FILES);
});
afterEach(async () => {
  await fs.rm(outer, { recursive: true, force: true });
});

const findRipgrep = (toolsModule as unknown as { findRipgrep?: () => string | null }).findRipgrep;
const RG = typeof findRipgrep === 'function' ? findRipgrep() : null;

/** Les deux moteurs doivent se comporter pareil ; ripgrep n'est testé que s'il est installé. */
const engines: Array<{ name: string; rgPath: string | null; skip: boolean }> = [
  { name: 'ripgrep', rgPath: RG, skip: RG === null },
  { name: 'repli JS', rgPath: null, skip: false },
];

for (const engine of engines) {
  describe.skipIf(engine.skip)(`grep — moteur ${engine.name}`, () => {
    let t: Toolset;
    beforeEach(() => {
      t = toolset(root, { rgPath: engine.rgPath });
    });

    it('mode content : fichier:ligne:texte, sensible à la casse par défaut', async () => {
      const res = await t.run('grep', { pattern: 'alpha', path: 'src' });
      expect(res.isError).toBe(false);
      expect(res.content).toContain('src/a.ts:1:const alpha = 1;');
      expect(res.content).toContain('src/b.ts:2:console.log(alpha);');
      expect(res.content).not.toContain('Alpha = ()');
    });

    it('-i rend la recherche insensible à la casse', async () => {
      const res = await t.run('grep', { pattern: 'alpha', path: 'src', '-i': true });
      expect(res.content).toContain('src/deep/c.tsx:1:export const Alpha');
    });

    it('mode files_with_matches : un chemin par ligne, trié', async () => {
      const res = await t.run('grep', { pattern: 'alpha', output_mode: 'files_with_matches' });
      expect(res.isError).toBe(false);
      const lines = res.content.split('\n').filter((l) => /\.(ts|tsx|md|txt)$/.test(l));
      expect(lines).toEqual(['docs/guide.md', 'src/a.ts', 'src/b.ts']);
    });

    it('mode count : nombre de lignes correspondantes par fichier', async () => {
      const res = await t.run('grep', { pattern: 'alpha', output_mode: 'count', path: 'src' });
      expect(res.content).toContain('src/a.ts:3');
      expect(res.content).toContain('src/b.ts:2');
    });

    it('lignes de contexte -C / -A / -B', async () => {
      const res = await t.run('grep', { pattern: 'cible', path: 'notes.txt', '-C': 1 });
      expect(res.isError).toBe(false);
      expect(res.content).toContain('notes.txt-2-ligne 2');
      expect(res.content).toContain('notes.txt:3:cible');
      expect(res.content).toContain('notes.txt-4-ligne 4');
      expect(res.content).toContain('--');
      expect(res.content).not.toContain('ligne 5');
      const after = await t.run('grep', { pattern: 'cible', path: 'notes.txt', '-A': 1 });
      expect(after.content).toContain('notes.txt-9-ligne 9');
      expect(after.content).not.toContain('ligne 2');
    });

    it('filtre glob et type', async () => {
      const md = await t.run('grep', { pattern: 'alpha', glob: '*.md' });
      expect(md.content).toContain('docs/guide.md:2:alpha dans la doc');
      expect(md.content).not.toContain('src/');
      const ts = await t.run('grep', { pattern: 'alpha', type: 'ts', '-i': true });
      expect(ts.content).toContain('src/deep/c.tsx');
      expect(ts.content).not.toContain('docs/guide.md');
    });

    it('un motif commençant par « - » est un motif, pas une option', async () => {
      const res = await t.run('grep', { pattern: '-rf', output_mode: 'files_with_matches' });
      expect(res.isError).toBe(false);
      expect(res.content).toContain('docs/guide.md');
      const files = await t.run('grep', { pattern: '--files' });
      expect(files.isError).toBe(false);
      expect(files.content).toContain('Aucune correspondance');
    });

    it('ignore node_modules et ne renvoie jamais de fichier de secrets', async () => {
      const res = await t.run('grep', { pattern: 'alpha', '-i': true, glob: '*' });
      expect(res.content).not.toContain('node_modules');
      expect(res.content).not.toContain('fictif');
      expect(res.content).not.toContain('.env');
    });

    it('plafonne les résultats et indique comment lire la suite', async () => {
      const big = Array.from({ length: 50 }, (_, i) => `match ${i}`).join('\n');
      await writeFiles(root, { 'big.txt': big });
      const res = await t.run('grep', { pattern: 'match', path: 'big.txt', head_limit: 10 });
      expect(res.content).toContain('big.txt:10:match 9');
      expect(res.content).not.toContain('match 10');
      expect(res.content).toMatch(/offset[^0-9]*10/);
      const next = await t.run('grep', { pattern: 'match', path: 'big.txt', head_limit: 10, offset: 10 });
      expect(next.content).toContain('big.txt:11:match 10');
    });

    it('aucune correspondance = recherche complète, pas une erreur', async () => {
      const res = await t.run('grep', { pattern: 'zzz_introuvable' });
      expect(res.isError).toBe(false);
      expect(res.content).toContain('Aucune correspondance');
    });

    it('refuse un chemin hors du workspace et un motif invalide', async () => {
      const out = await t.run('grep', { pattern: 'root', path: '/etc' });
      expect(out.isError).toBe(true);
      expect(out.content).toContain('hors du workspace');
      const bad = await t.run('grep', { pattern: '(' });
      expect(bad.isError).toBe(true);
    });
  });
}

describe('grep — délai dépassé = erreur explicite', () => {
  it('ripgrep trop lent : erreur, jamais « Aucune correspondance »', async () => {
    const fake = path.join(outer, 'rg-lent');
    await fs.writeFile(fake, '#!/bin/sh\nexec sleep 10\n');
    await fs.chmod(fake, 0o755);
    const t = toolset(root, { rgPath: fake, searchTimeoutMs: 300 });
    const started = Date.now();
    const res = await t.run('grep', { pattern: 'alpha' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/délai/i);
    expect(res.content).not.toContain('Aucune correspondance');
  });

  it('moteur de repli trop lent : erreur aussi', async () => {
    const t = toolset(root, { rgPath: null, searchTimeoutMs: 1 });
    const res = await t.run('grep', { pattern: 'alpha' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/délai/i);
  });

  it('l’alias search ne masque plus un délai dépassé', async () => {
    const t = toolset(root, { rgPath: null, searchTimeoutMs: 1 });
    const res = await t.run('search', { pattern: 'alpha' });
    expect(res.isError).toBe(true);
    expect(res.content).not.toContain('Aucune correspondance');
  });
});

describe('search — compatibilité', () => {
  it('reste disponible, insensible à la casse, filtre par extensions', async () => {
    const t = toolset(root);
    const res = await t.run('search', { pattern: 'ALPHA', glob: 'tsx' });
    expect(res.isError).toBe(false);
    expect(res.content).toContain('src/deep/c.tsx:1:');
    expect(res.content).not.toContain('src/a.ts');
  });
});

describe('glob — liste de fichiers par motif', () => {
  let t: Toolset;
  beforeEach(() => {
    t = toolset(root);
  });

  it('liste récursivement, trié, sans node_modules ni secrets', async () => {
    const res = await t.run('glob', { pattern: '**/*.ts' });
    expect(res.isError).toBe(false);
    expect(res.content.split('\n').filter((l) => l.endsWith('.ts'))).toEqual(['src/a.ts', 'src/b.ts']);
    const all = await t.run('glob', { pattern: '**/*' });
    expect(all.content).not.toContain('node_modules');
    expect(all.content).not.toContain('.env');
    expect(all.content).not.toContain('.npmrc');
  });

  it('motif sans « / » = nom de fichier à toute profondeur ; avec « / » = chemin', async () => {
    const any = await t.run('glob', { pattern: '*.{ts,tsx}' });
    expect(any.content).toContain('src/deep/c.tsx');
    const direct = await t.run('glob', { pattern: 'src/*.ts' });
    expect(direct.content).toContain('src/a.ts');
    expect(direct.content).not.toContain('c.tsx');
  });

  it('respecte path et plafonne avec un avis', async () => {
    await writeFiles(root, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`many/f${String(i).padStart(2, '0')}.log`, 'x'])));
    const res = await t.run('glob', { pattern: '*.log', path: 'many', head_limit: 5 });
    expect(res.content).toContain('many/f00.log');
    expect(res.content).not.toContain('many/f05.log');
    expect(res.content).toMatch(/30/);
  });

  it('refuse un chemin hors du workspace', async () => {
    const res = await t.run('glob', { pattern: '*', path: '../' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('hors du workspace');
  });

  it('aucun fichier : message explicite', async () => {
    const res = await t.run('glob', { pattern: '**/*.rs' });
    expect(res.isError).toBe(false);
    expect(res.content).toContain('Aucun fichier');
  });
});

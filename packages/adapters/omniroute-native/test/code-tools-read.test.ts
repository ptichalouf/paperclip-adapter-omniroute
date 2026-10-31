/**
 * Lot 11a — lecture paginée : `read_file` numéroté, `read_skill` au-delà de 30 000 caractères.
 *
 * Constat avant ce lot : `read_file` ne numérotait les lignes qu'avec
 * `offset`/`limit` et coupait à 30 000 caractères sans dire comment lire la
 * suite ; `read_skill` coupait le skill paperclip (≈ 70 000 caractères) à
 * 30 000, sans aucun moyen de lire le reste.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { buildReadSkillTool } from '../src/server/skills.js';
import { makeWorkspace, toolset, writeFiles, type Toolset } from './support/code-tools-helpers.js';

let outer: string;
let root: string;
let t: Toolset;

beforeEach(async () => {
  ({ outer, root } = await makeWorkspace('lot11a-read-'));
  t = toolset(root);
});
afterEach(async () => {
  await fs.rm(outer, { recursive: true, force: true });
});

describe('read_file — numéroté et paginé', () => {
  it('numérote les lignes même sans offset ni limit (usage historique)', async () => {
    await writeFiles(root, { 'a.txt': 'un\ndeux\ntrois\n' });
    const res = await t.run('read_file', { path: 'a.txt' });
    expect(res.isError).toBe(false);
    expect(res.content.split('\n').slice(0, 3)).toEqual(['1\tun', '2\tdeux', '3\ttrois']);
    expect(res.content).not.toContain('suite');
  });

  it('offset/limit renvoie une fenêtre et indique comment lire la suite', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `ligne ${i + 1}`);
    await writeFiles(root, { 'big.txt': lines.join('\n') + '\n' });
    const res = await t.run('read_file', { path: 'big.txt', offset: 100, limit: 50 });
    expect(res.content).toContain('100\tligne 100');
    expect(res.content).toContain('149\tligne 149');
    expect(res.content).not.toContain('150\tligne 150');
    expect(res.content).toContain('500');
    expect(res.content).toMatch(/offset"?\s*:\s*150/);
  });

  it('un gros fichier est découpé en pages, sans perte entre deux pages', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `l${i + 1}`);
    await writeFiles(root, { 'huge.txt': lines.join('\n') });
    const first = await t.run('read_file', { path: 'huge.txt' });
    const next = Number(/offset"?\s*:\s*(\d+)/.exec(first.content)?.[1]);
    expect(next).toBeGreaterThan(1);
    expect(first.content).toContain(`${next - 1}\tl${next - 1}`);
    const second = await t.run('read_file', { path: 'huge.txt', offset: next });
    expect(second.content.startsWith(`${next}\tl${next}`)).toBe(true);
  });

  it('borne la page à 30 000 caractères en coupant sur une fin de ligne', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${i}:` + 'x'.repeat(100));
    await writeFiles(root, { 'wide.txt': lines.join('\n') });
    const res = await t.run('read_file', { path: 'wide.txt' });
    expect(res.content.length).toBeLessThanOrEqual(30_500);
    const next = Number(/offset"?\s*:\s*(\d+)/.exec(res.content)?.[1]);
    expect(next).toBeGreaterThan(100);
    expect(res.content).toContain(`${next - 1}\t${next - 2}:`);
  });

  it('fichier vide et offset au-delà de la fin : messages explicites', async () => {
    await writeFiles(root, { 'vide.txt': '', 'a.txt': 'un\n' });
    expect((await t.run('read_file', { path: 'vide.txt' })).content).toMatch(/vide/);
    const beyond = await t.run('read_file', { path: 'a.txt', offset: 10 });
    expect(beyond.content).toMatch(/au-delà de la fin/);
  });

  it('refuse toujours les secrets et la sortie du workspace', async () => {
    await writeFiles(root, { '.env': 'TOKEN=fictif\n' });
    expect((await t.run('read_file', { path: '.env' })).isError).toBe(true);
    expect((await t.run('read_file', { path: '../x' })).isError).toBe(true);
  });
});

describe('read_skill — paginé au-delà de 30 000 caractères', () => {
  it('lit tout un skill de 70 000 caractères par pages, sans perte', async () => {
    const skillDir = path.join(outer, 'skill');
    await fs.mkdir(skillDir);
    const body = Array.from({ length: 1400 }, (_, i) => `ligne ${String(i).padStart(4, '0')} ${'y'.repeat(40)}`).join('\n');
    expect(body.length).toBeGreaterThan(70_000);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf8');
    const tool = buildReadSkillTool([{ key: 'k', runtimeName: 'paperclip', source: skillDir, description: null }]);
    expect(Object.keys((tool.spec.input_schema as { properties: object }).properties)).toContain('offset');

    let offset = 0;
    let rebuilt = '';
    for (let page = 0; page < 10; page += 1) {
      const res = await tool.run({ skill: 'paperclip', offset });
      expect(res.isError).toBe(false);
      expect(res.content.length).toBeLessThanOrEqual(30_100);
      const footer = /\n\n\[caractères (\d+)–(\d+) sur (\d+)[^\]]*\]$/.exec(res.content);
      expect(footer).not.toBeNull();
      rebuilt += res.content.slice(0, footer!.index);
      const end = Number(footer![2]);
      if (end >= Number(footer![3])) break;
      expect(res.content).toContain(`"offset":${end}`);
      offset = end;
    }
    expect(rebuilt).toBe(body);
  });

  it('un petit skill est rendu tel quel, sans pied de page', async () => {
    const skillDir = path.join(outer, 'petit');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'court', 'utf8');
    const tool = buildReadSkillTool([{ key: 'k', runtimeName: 'p', source: skillDir, description: null }]);
    expect((await tool.run({ skill: 'p' })).content).toBe('court');
  });
});

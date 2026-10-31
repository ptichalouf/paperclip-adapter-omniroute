import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  buildReadInstructionsTool,
  buildInstructionsSection,
  loadInstructionsBundle,
  resolveInstructionsFilePath,
  MAX_INSTRUCTIONS_CHARS,
} from '../src/server/instructions.js';
import {
  buildReadSkillTool,
  buildSkillIndex,
  enrichSkillDescriptions,
  resolveDesiredSkillMounts,
} from '../src/server/skills.js';

/**
 * Bundle d'instructions et skills Paperclip.
 *
 * Le contrat que ces tests verrouillent :
 * - le bundle d'instructions **prime** sur le reste du prompt ;
 * - un bundle illisible est **remonté**, pas silencieusement ignoré ;
 * - les skills sont un **index** dans le prompt, leur contenu se lit à la
 *   demande (le skill `paperclip` fait 70 ko : l'injecter en entier à
 *   chaque tour coûterait plus cher que la tâche) ;
 * - la lecture est **confinée** : un skill ne doit pas devenir un chemin
 *   vers le reste du disque.
 */
describe('instructions — bundle d\'instructions de l\'agent', () => {
  it('lit le chemin dans instructionsFilePath', () => {
    expect(resolveInstructionsFilePath({ instructionsFilePath: '/a/AGENTS.md' })).toBe('/a/AGENTS.md');
  });

  it('ne renvoie rien quand il n\'y a pas de bundle', () => {
    expect(resolveInstructionsFilePath({})).toBeNull();
    expect(resolveInstructionsFilePath({ instructionsFilePath: '   ' })).toBeNull();
  });

  it('charge le contenu du bundle', async () => {
    const dir = path.join('/tmp', `omniroute-instr-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, 'Travaille par blocs de 30 minutes.', 'utf8');

    const bundle = await loadInstructionsBundle({
      config: { instructionsFilePath: file },
    } as never);

    expect(bundle).not.toBeNull();
    expect(bundle!.content).toContain('blocs de 30 minutes');
    expect(bundle!.dir).toBe(dir);
    expect(bundle!.truncated).toBe(false);
  });

  it('remonte un bundle illisible au lieu de le taire', async () => {
    await expect(
      loadInstructionsBundle({
        config: { instructionsFilePath: '/chemin/qui/nexiste/AGENTS.md' },
      } as never),
    ).rejects.toThrow(/illisible/);
  });

  it('tronque une instruction trop longue et le dit', async () => {
    const dir = path.join('/tmp', `omniroute-instr-long-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 500), 'utf8');

    const bundle = await loadInstructionsBundle({ config: { instructionsFilePath: file } } as never);

    expect(bundle!.truncated).toBe(true);
    expect(bundle!.content.length).toBe(MAX_INSTRUCTIONS_CHARS);
    expect(bundle!.originalLength).toBe(MAX_INSTRUCTIONS_CHARS + 500);
  });

  it('injecte l\'instruction dans le prompt système', async () => {
    const dir = path.join('/tmp', `omniroute-instr-section-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, 'Règle : jamais de push.', 'utf8');

    const bundle = await loadInstructionsBundle({ config: { instructionsFilePath: file } } as never);
    const section = buildInstructionsSection(bundle);

    expect(section).toContain('jamais de push');
    expect(section).toContain('Instructions de l\'agent');
  });

  it('ne produit aucune section sans bundle', () => {
    expect(buildInstructionsSection(null)).toBe('');
  });

  it('permet de lire un fichier de référence du bundle', async () => {
    const dir = path.join('/tmp', `omniroute-instr-ref-${process.pid}`);
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, 'racine', 'utf8');
    await fs.writeFile(path.join(dir, 'references', 'plan.md'), 'le plan', 'utf8');

    const bundle = await loadInstructionsBundle({ config: { instructionsFilePath: file } } as never);
    const tool = buildReadInstructionsTool(bundle)!;

    const result = await tool.run({ file: 'references/plan.md' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('le plan');
  });

  it('refuse de lire hors du bundle', async () => {
    const dir = path.join('/tmp', `omniroute-instr-esc-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, 'racine', 'utf8');

    const bundle = await loadInstructionsBundle({ config: { instructionsFilePath: file } } as never);
    const tool = buildReadInstructionsTool(bundle)!;

    const result = await tool.run({ file: '../../../../etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('hors du bundle');
  });

  it('n\'expose pas d\'outil de lecture sans bundle', () => {
    expect(buildReadInstructionsTool(null)).toBeNull();
  });
});

describe('skills — index dans le prompt, lecture à la demande', () => {
  const skillConfig = {
    paperclipRuntimeSkills: [
      { key: 'paperclipai/paperclip/paperclip', runtimeName: 'paperclip', source: '/skills/paperclip' },
      { key: 'paperclipai/paperclip/slack', runtimeName: 'slack', source: '/skills/slack' },
      { key: 'autre/cle', runtimeName: 'autre', source: '/skills/autre' },
    ],
    paperclipSkillSync: {
      desiredSkills: [{ key: 'paperclipai/paperclip/paperclip', versionId: null }],
    },
  };

  it('ne monte que les skills désirés', () => {
    const mounts = resolveDesiredSkillMounts(skillConfig);
    const keys = mounts.map((m) => m.key);

    expect(keys).toContain('paperclipai/paperclip/paperclip');
    // `autre/cle` n'est pas désiré : il ne doit pas être monté.
    expect(keys).not.toContain('autre/cle');
  });

  it('ne monte rien sans configuration de skills', () => {
    expect(resolveDesiredSkillMounts({})).toEqual([]);
  });

  it('indexe les skills avec leur mode de lecture', async () => {
    const dir = path.join('/tmp', `omniroute-skill-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: paperclip\ndescription: Contrat API du board\n---\n\n# Paperclip\n',
      'utf8',
    );

    const mounts = await enrichSkillDescriptions(
      resolveDesiredSkillMounts({
        ...skillConfig,
        paperclipRuntimeSkills: [
          { key: 'paperclipai/paperclip/paperclip', runtimeName: 'paperclip', source: dir },
        ],
        paperclipSkillSync: {
          desiredSkills: [{ key: 'paperclipai/paperclip/paperclip', versionId: null }],
        },
      }),
    );

    const index = buildSkillIndex(mounts);
    expect(index).toContain('paperclip');
    expect(index).toContain('Contrat API du board');
    expect(index).toContain('read_skill');
    // Le contenu du skill ne doit PAS être dans le prompt : il est lu à la
    // demande (70 ko pour le skill Paperclip).
    expect(index).not.toContain('# Paperclip\n');
  });

  it('n\'indexe rien quand aucun skill n\'est monté', () => {
    expect(buildSkillIndex([])).toBe('');
  });

  it('lit un skill monté', async () => {
    const dir = path.join('/tmp', `omniroute-skill-read-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'CONTENU DU SKILL', 'utf8');

    const tool = buildReadSkillTool([
      { key: 'k', runtimeName: 'paperclip', source: dir, description: null },
    ]);

    const result = await tool.run({ skill: 'paperclip' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('CONTENU DU SKILL');
  });

  it('refuse un skill inconnu et liste les skills montés', async () => {
    const dir = path.join('/tmp', `omniroute-skill-unknown-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });

    const tool = buildReadSkillTool([
      { key: 'k', runtimeName: 'paperclip', source: dir, description: null },
    ]);

    const result = await tool.run({ skill: 'inexistant' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('paperclip');
  });

  it('refuse de lire hors du répertoire du skill', async () => {
    const dir = path.join('/tmp', `omniroute-skill-esc-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'ok', 'utf8');

    const tool = buildReadSkillTool([
      { key: 'k', runtimeName: 'paperclip', source: dir, description: null },
    ]);

    const result = await tool.run({ skill: 'paperclip', file: '../../../../etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('hors du skill');
  });
});

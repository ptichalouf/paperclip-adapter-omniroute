import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { buildWorkspaceTools, prepareWorkspace } from '../src/server/tools.js';

/**
 * Le temporaire du shell doit être dans le workspace.
 *
 * Sinon l'agent doit écrire dans /tmp — chemin hors workspace, donc refusé
 * par la garde de sortie. C'est ce qui est arrivé en recette ACC-2258 :
 * `curl … > /tmp/inv.json` a été refusé.
 */
describe('TMPDIR — le temporaire est dans le workspace', () => {
  it('pose TMPDIR dans le workspace, pas dans /tmp', async () => {
    const root = path.join('/tmp', `workspace-tmp-${process.pid}`);
    await prepareWorkspace(root);

    const tools = buildWorkspaceTools(root, undefined, {});
    const shell = tools.find((t) => t.spec.name === 'shell');
    expect(shell).toBeDefined();

    const result = await shell!.run({ command: 'printf "%s" "$TMPDIR"' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain(path.join(root, '.tmp'));
    expect(result.content).not.toBe('/tmp');
  });

  it('HOME reste le workspace', async () => {
    const root = path.join('/tmp', `workspace-home-${process.pid}`);
    await prepareWorkspace(root);

    const tools = buildWorkspaceTools(root, undefined, {});
    const shell = tools.find((t) => t.spec.name === 'shell');

    const result = await shell!.run({ command: 'printf "%s" "$HOME"' });

    expect(result.isError).toBe(false);
    // La sortie du shell est préfixée par « code de sortie 0 ».
    expect(result.content).toContain(root);
    expect(result.content).not.toContain('/root');
  });

  it('prepareWorkspace crée le sous-dossier .tmp', async () => {
    const root = path.join('/tmp', `workspace-mkdir-${process.pid}`);

    await prepareWorkspace(root);

    expect(existsSync(path.join(root, '.tmp'))).toBe(true);
  });

  it('prepareWorkspace est idempotent', async () => {
    const root = path.join('/tmp', `workspace-idem-${process.pid}`);

    await prepareWorkspace(root);
    await expect(prepareWorkspace(root)).resolves.toBeUndefined();

    expect(existsSync(path.join(root, '.tmp'))).toBe(true);
  });
});

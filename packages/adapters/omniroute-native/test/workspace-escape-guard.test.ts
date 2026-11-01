import { describe, expect, it } from 'vitest';

import { detectsWorkspaceEscape } from '../src/server/tools.js';

describe('detectsWorkspaceEscape — le shell reste dans le workspace', () => {
  it('refuse la remontée de répertoire', () => {
    expect(detectsWorkspaceEscape('cd ..')).toBe(true);
    expect(detectsWorkspaceEscape('cd ../..')).toBe(true);
    expect(detectsWorkspaceEscape('cat ../secrets.txt')).toBe(true);
    expect(detectsWorkspaceEscape('cd /etc && cat passwd')).toBe(true);
    expect(detectsWorkspaceEscape('cd ~')).toBe(true);
  });

  it('refuse la remontée quoting', () => {
    expect(detectsWorkspaceEscape("cd '..'")).toBe(true);
    expect(detectsWorkspaceEscape('cd ".."')).toBe(true);
  });

  it('refuse les cibles hors workspace', () => {
    expect(detectsWorkspaceEscape('cd /')).toBe(true);
    expect(detectsWorkspaceEscape('cd -')).toBe(true);
    expect(detectsWorkspaceEscape('cat ~/.ssh/id_rsa')).toBe(true);
    expect(detectsWorkspaceEscape('cat ~root/.ssh/id_rsa')).toBe(true);
    expect(detectsWorkspaceEscape('cat /etc/passwd')).toBe(true);
    expect(detectsWorkspaceEscape('cat /var/run/docker.sock')).toBe(true);
  });

  it('refuse une fuite cachee derriere une URL', () => {
    expect(detectsWorkspaceEscape('curl -s http://x.test/a && cat /etc/passwd')).toBe(true);
    expect(detectsWorkspaceEscape('curl http://x.test && cd ..')).toBe(true);
  });

  it('laisse passer le workspace lui-meme en chemin absolu', () => {
    // L'agent fait souvent `cd <chemin-absolu-du-workspace>` pour etre sur de
    // sa position : c'est son propre workspace, pas une sortie.
    const ws = '/paperclip/instances/default/workspaces/abc-123';
    expect(detectsWorkspaceEscape(`cd ${ws} && ls -la`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`cd ${ws}/sub && ls`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`cat ${ws}/notes.txt`, ws)).toBe(false);
  });

  it('refuse un chemin absolu hors workspace', () => {
    const ws = '/paperclip/instances/default/workspaces/abc-123';
    expect(detectsWorkspaceEscape('cat /etc/passwd', ws)).toBe(true);
    expect(detectsWorkspaceEscape('cat /paperclip/secrets.txt', ws)).toBe(true);
    // Un chemin qui commence par le workspace mais en sort est refusé.
    expect(detectsWorkspaceEscape(`cat ${ws}-other/secret.txt`, ws)).toBe(true);
  });

  it('refuse tout chemin absolu si le workspace est inconnu', () => {
    expect(detectsWorkspaceEscape('cat /etc/passwd')).toBe(true);
    expect(detectsWorkspaceEscape('cd /paperclip/instances/default/workspaces/abc-123')).toBe(true);
  });

  it('laisse passer la navigation dans le workspace', () => {
    expect(detectsWorkspaceEscape('cd src')).toBe(false);
    expect(detectsWorkspaceEscape('cd packages/adapters')).toBe(false);
    expect(detectsWorkspaceEscape('ls -la')).toBe(false);
    expect(detectsWorkspaceEscape('pnpm test')).toBe(false);
    expect(detectsWorkspaceEscape('cd ./src && npm run build')).toBe(false);
  });

  it('laisse passer les URL, qui ne sont pas des chemins', () => {
    // Régression trouvée par la recette ACC-2253 : l'agent ne pouvait plus
    // appeler une URL en shell, et tournait en boucle sur des refus.
    expect(detectsWorkspaceEscape('curl -s http://127.0.0.1:3100/health')).toBe(false);
    expect(detectsWorkspaceEscape('curl -s https://exemple.test/api/v1')).toBe(false);
    expect(detectsWorkspaceEscape('wget https://exemple.test/a/../b')).toBe(false);
    expect(detectsWorkspaceEscape('curl -sS -X POST http://127.0.0.1:20128/v1/chat/completions')).toBe(false);
    expect(detectsWorkspaceEscape('echo "http://exemple.test"')).toBe(false);
  });

  it('ne confond pas un nom de fichier qui contient cd', () => {
    expect(detectsWorkspaceEscape('cat cdn.txt')).toBe(false);
    expect(detectsWorkspaceEscape('echo "cd est une commande"')).toBe(false);
  });
});

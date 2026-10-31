import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectsWorkspaceEscape } from '../src/server/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = '/paperclip/instances/default/workspaces/2ae3514c-ddb7-480f-a0b3-f7ae26b4423c';

describe('lot 8a — le garde-fou ne refuse plus les commandes sûres', () => {
  it('accepte les 6 commandes réelles refusées à tort pendant ACC-2278', () => {
    const commands = JSON.parse(
      readFileSync(path.join(here, 'fixtures/acc2278-commandes-refusees.json'), 'utf8'),
    ) as string[];
    expect(commands).toHaveLength(6);
    for (const command of commands) {
      expect({ command: command.slice(0, 80), refused: detectsWorkspaceEscape(command, ws) }).toEqual({
        command: command.slice(0, 80),
        refused: false,
      });
    }
  });

  it('accepte un programme shell imbriqué qui reste dans le workspace', () => {
    expect(detectsWorkspaceEscape(`bash -c 'cd src && ls -la'`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`sh -c "jq '.a // .b' f.json"`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`jq '.. | .id? // empty' f.json`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`grep -rn "\\.\\." src`, ws)).toBe(false);
  });

  it('accepte l opérateur jq « // » (valeur par défaut) entre quotes', () => {
    expect(detectsWorkspaceEscape(`jq -r '.[] | .assigneeAgentId // "aucun"' is.json`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`jq '.a//"x"' f.json`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`jq '.. | .id? // empty' f.json`, ws)).toBe(false);
  });

  it('accepte les motifs awk, sed et grep qui ressemblent à des chemins', () => {
    expect(detectsWorkspaceEscape(`awk '/ERROR/ {print $1}' app.log`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`sed -n '/debut/,/fin/p' notes.md`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`grep -rn '/api/issues' src`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`grep -c "/companies/" out.json`, ws)).toBe(false);
  });

  it('accepte les redirections vers /dev/null et les outils système', () => {
    expect(detectsWorkspaceEscape('ls > /dev/null 2>&1', ws)).toBe(false);
    expect(detectsWorkspaceEscape('cmd 2>/dev/null', ws)).toBe(false);
    expect(detectsWorkspaceEscape('/usr/bin/env python3 script.py', ws)).toBe(false);
    expect(detectsWorkspaceEscape('/bin/echo ok', ws)).toBe(false);
  });

  it('accepte les URL de l API construites avec des variables', () => {
    expect(
      detectsWorkspaceEscape(`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID"`, ws),
    ).toBe(false);
  });
});

describe('lot 8a — les vraies sorties restent refusées', () => {
  const refused = [
    'cd ..',
    'cat ../secrets.txt',
    "cd '..'",
    'cat /etc/passwd',
    "cat '/etc'/passwd",
    'cat "/etc/my file"',
    'ls /',
    'cd /',
    'cat //etc/passwd',
    'cat /usr/../etc/passwd',
    'echo x > /etc/cron.d/x',
    'echo x >/paperclip/instances/default/companies/x',
    'cat /proc/self/environ',
    `cat ${ws}-other/secret.txt`,
    'cat ~/.ssh/id_rsa',
    'cat $HOME/.ssh/id_rsa',
    'cat ${HOME}/.ssh/id_rsa',
    `bash -c 'cat ../x'`,
    `sh -c "cat /etc/passwd"`,
    `python3 -c 'print(open("/etc/passwd").read())'`,
    `python3 -c 'print(open("../x").read())'`,
    'echo "$(cat ../x)"',
    'echo `cat /etc/passwd`',
    'cat /tmp/autre-agent.txt',
    'cd && ls',
    'cd',
    // Revue A 3320 : `..` dans un programme passé à un shell ou à python.
    `bash -c 'cd ..; cat secret'`,
    `sh -c "cd ..; ls"`,
    `python3 -c 'import os; os.chdir(".."); print(os.listdir())'`,
    // Trous déjà présents sur la base, comblés ici.
    `bash -c 'cd; ls'`,
    `bash -c 'cd -; ls'`,
    `bash -c 'cd $HOME; ls'`,
    `bash -c 'cd /; ls'`,
    `bash -c 'ls / | head'`,
    `/bin/bash -lc 'cat ../x'`,
    `eval 'cd ..'`,
    // Revue A 3321 : variantes du même programme.
    `bash -c -- 'cd ..; ls'`,
    `bash <<< 'cd ..; ls'`,
    `echo 'cd ..; ls' | bash`,
    `printf 'cd ..\nls' | sh`,
    `env bash -c 'cat ../x'`,
  ];
  for (const command of refused) {
    it(`refuse : ${command}`, () => {
      expect(detectsWorkspaceEscape(command, ws)).toBe(true);
    });
  }
});

describe('lot 8a — le refus dit quoi corriger', () => {
  it('nomme le fragment fautif et propose .tmp/', async () => {
    const { findWorkspaceEscape } = await import('../src/server/tools.js');
    expect(findWorkspaceEscape('cat /etc/passwd', ws)).toBe('/etc/passwd');
    expect(findWorkspaceEscape('cat ../x', ws)).toBe('../x');
    expect(findWorkspaceEscape(`jq '.a // "b"' f.json`, ws)).toBeNull();
  });
});

describe('lot 8a — opérateur jq « // » sans autre syntaxe', () => {
  it('accepte jq .a // .b', () => {
    expect(detectsWorkspaceEscape(`jq '.a // .b' f.json`, ws)).toBe(false);
    expect(detectsWorkspaceEscape(`jq ".a // .b" f.json`, ws)).toBe(false);
  });
  it('refuse toujours ls // et ls "/"', () => {
    expect(detectsWorkspaceEscape('ls //', ws)).toBe(true);
    expect(detectsWorkspaceEscape('ls "/"', ws)).toBe(true);
  });
});

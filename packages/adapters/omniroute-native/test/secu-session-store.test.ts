/**
 * Lot solidité — stockage des sessions (ACC-2297).
 *
 * Constats mesurés (D-exploitation Q2/Q3) : dossier qui suit la copie de run
 * (`file-sync/runs/<run>/live`, continuité cassée), écriture directe sans
 * verrou ni renommage (dernier écrivain gagnant, JSON tronqué possible),
 * fichiers 0644 jamais purgés, aucun `.gitignore`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadSessionMessages,
  resolveSessionBaseDir,
  saveSessionMessages,
  sessionFilePath,
} from '../src/server/session.js';
import type { WireMessage } from '../src/shared/wire.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';
import { startScriptedGateway } from './support/secu-gateway.js';

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

const exchange = (label: string): WireMessage[] => [
  { role: 'user', content: [{ type: 'text', text: `consigne ${label}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `réponse ${label}` }] },
];

async function sessionModule() {
  return import('../src/server/session.js');
}
async function storeModule() {
  return import('../src/server/session-store.js');
}

describe('secu — dossier de session stable', () => {
  it('ignore la copie de run et garde le home stable de l’agent', () => {
    const home = '/paperclip/instances/default/workspaces/agent-1';
    const run1 = { paperclipWorkspace: { cwd: '/w', agentHome: '/c/agents/agent-1/file-sync/runs/r1/live', agentHomeForPermissions: home } };
    const run2 = { paperclipWorkspace: { cwd: '/w', agentHome: '/c/agents/agent-1/file-sync/runs/r2/live', agentHomeForPermissions: home } };
    expect(resolveSessionBaseDir(run1, '/w')).toBe(path.join(home, '.omniroute-sessions'));
    expect(resolveSessionBaseDir(run2, '/w')).toBe(resolveSessionBaseDir(run1, '/w'));
  });

  it('n’utilise jamais un dossier propre à un run, même sans home de permission', () => {
    const ctx = { paperclipWorkspace: { cwd: '/projet', agentHome: '/c/agents/a/file-sync/runs/r9/live' } };
    expect(resolveSessionBaseDir(ctx, '/projet')).not.toContain('file-sync');
  });

  it('garde le home ordinaire quand il est stable', () => {
    const ctx = { paperclipWorkspace: { cwd: '/projet', agentHome: '/paperclip/workspaces/a' } };
    expect(resolveSessionBaseDir(ctx, '/projet')).toBe('/paperclip/workspaces/a/.omniroute-sessions');
  });
});

describe('secu — droits, .gitignore et écriture atomique', () => {
  it('écrit le fichier en 0600 et le dossier en 0700, même s’il existait en 0755', async () => {
    const root = await tempDir('secu-mode-');
    const dir = path.join(root, '.omniroute-sessions');
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);
    await saveSessionMessages(dir, 's-mode', exchange('a'));
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(sessionFilePath(dir, 's-mode'))).mode & 0o777).toBe(0o600);
  });

  it('pose un .gitignore « * » dans le dossier de sessions', async () => {
    const root = await tempDir('secu-gi-');
    const dir = path.join(root, '.omniroute-sessions');
    await saveSessionMessages(dir, 's-gi', exchange('a'));
    const lines = (await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).split('\n').map((l) => l.trim());
    expect(lines).toContain('*');
  });

  it('remplace le fichier par renommage (nouvel inode), sans temporaire résiduel', async () => {
    const root = await tempDir('secu-atomic-');
    const dir = path.join(root, '.omniroute-sessions');
    await saveSessionMessages(dir, 's-atomic', exchange('a'));
    const first = (await fs.stat(sessionFilePath(dir, 's-atomic'))).ino;
    await saveSessionMessages(dir, 's-atomic', [...exchange('a'), ...exchange('b')]);
    const second = (await fs.stat(sessionFilePath(dir, 's-atomic'))).ino;
    expect(second).not.toBe(first);
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp') || name.endsWith('.lock'));
    expect(leftovers).toEqual([]);
  });

  it('un lecteur concurrent ne voit jamais un JSON tronqué', async () => {
    const root = await tempDir('secu-reader-');
    const dir = path.join(root, '.omniroute-sessions');
    const big = (label: string): WireMessage[] => [
      { role: 'user', content: [{ type: 'text', text: `consigne ${label}` }] },
      { role: 'assistant', content: [{ type: 'text', text: label.repeat(400_000) }] },
    ];
    await saveSessionMessages(dir, 's-reader', big('a'));
    let corrupt = 0;
    let reading = true;
    const reader = (async () => {
      while (reading) {
        const raw = await fs.readFile(sessionFilePath(dir, 's-reader'), 'utf8').catch(() => '');
        try {
          JSON.parse(raw);
        } catch {
          corrupt += 1;
        }
      }
    })();
    for (let i = 0; i < 8; i += 1) await saveSessionMessages(dir, 's-reader', big(i % 2 ? 'b' : 'c'));
    reading = false;
    await reader;
    expect(corrupt).toBe(0);
  });
});

describe('secu — verrou par session', () => {
  it('deux runs qui sauvegardent en même temps conservent leurs deux échanges', async () => {
    const { SessionWriter } = await sessionModule();
    const root = await tempDir('secu-lock-');
    const dir = path.join(root, '.omniroute-sessions');
    await saveSessionMessages(dir, 's-lock', exchange('base'));
    const history = await loadSessionMessages(dir, 's-lock');
    const runA = new SessionWriter({ baseDir: dir, sessionId: 's-lock', historyLength: history.length });
    const runB = new SessionWriter({ baseDir: dir, sessionId: 's-lock', historyLength: history.length });
    const [a, b] = await Promise.all([
      runA.save([...history, ...exchange('A')]),
      runB.save([...history, ...exchange('B')]),
    ]);
    expect(a && b).toBe(true);
    const stored = JSON.stringify(await loadSessionMessages(dir, 's-lock'));
    expect(stored).toContain('consigne base');
    expect(stored).toContain('consigne A');
    expect(stored).toContain('consigne B');
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('les points de contrôle successifs d’un même run ne dupliquent rien', async () => {
    const { SessionWriter } = await sessionModule();
    const root = await tempDir('secu-ckpt-');
    const dir = path.join(root, '.omniroute-sessions');
    const writer = new SessionWriter({ baseDir: dir, sessionId: 's-ckpt', historyLength: 0 });
    const run: WireMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'tâche' }] }];
    run.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls' } }] });
    run.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a b' }] });
    await writer.save(run);
    run.push({ role: 'assistant', content: [{ type: 'text', text: 'fini' }] });
    await writer.save(run);
    expect(await loadSessionMessages(dir, 's-ckpt')).toEqual(run);
  });

  it('attend un verrou vivant puis renonce sans rien écrire', async () => {
    const root = await tempDir('secu-live-');
    const dir = path.join(root, '.omniroute-sessions');
    await saveSessionMessages(dir, 's-live', exchange('base'));
    const lock = `${sessionFilePath(dir, 's-live')}.lock`;
    // Verrou d'un autre processus vivant (le parent du worker de test).
    await fs.writeFile(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), token: 'x', createdAt: new Date().toISOString() }));
    const { withSessionLock } = await storeModule();
    await expect(withSessionLock(sessionFilePath(dir, 's-live'), async () => 'pris', { timeoutMs: 150 })).rejects.toThrow();
    expect(await fs.readFile(lock, 'utf8')).toContain('"token":"x"');
  });

  it('reprend un verrou périmé (processus mort)', async () => {
    const root = await tempDir('secu-stale-');
    const dir = path.join(root, '.omniroute-sessions');
    await saveSessionMessages(dir, 's-stale', exchange('base'));
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const lock = `${sessionFilePath(dir, 's-stale')}.lock`;
    await fs.writeFile(lock, JSON.stringify({ pid: dead, host: os.hostname(), token: 'mort', createdAt: new Date().toISOString() }));
    await saveSessionMessages(dir, 's-stale', [...exchange('base'), ...exchange('suite')]);
    expect(JSON.stringify(await loadSessionMessages(dir, 's-stale'))).toContain('consigne suite');
    await expect(fs.stat(lock)).rejects.toThrow();
  });
});

describe('secu — purge des sessions', () => {
  it('supprime les sessions de plus de 14 jours mais garde la session courante', async () => {
    const { purgeSessionDir } = await storeModule();
    const root = await tempDir('secu-ttl-');
    const dir = path.join(root, '.omniroute-sessions');
    for (const id of ['vieille', 'courante', 'recente']) await saveSessionMessages(dir, id, exchange(id));
    const old = new Date(Date.now() - 15 * 24 * 3600 * 1000);
    await fs.utimes(sessionFilePath(dir, 'vieille'), old, old);
    await fs.utimes(sessionFilePath(dir, 'courante'), old, old);
    const report = await purgeSessionDir(dir, { keep: ['courante'] });
    expect(report.deleted).toBe(1);
    const names = (await fs.readdir(dir)).sort();
    expect(names).toEqual(['.gitignore', 'courante.json', 'recente.json']);
  });

  it('plafonne le nombre de sessions par agent en gardant les plus récentes', async () => {
    const { purgeSessionDir } = await storeModule();
    const root = await tempDir('secu-max-');
    const dir = path.join(root, '.omniroute-sessions');
    for (let i = 0; i < 12; i += 1) {
      await saveSessionMessages(dir, `s${i}`, exchange(String(i)));
      const at = new Date(Date.now() - (12 - i) * 60_000);
      await fs.utimes(sessionFilePath(dir, `s${i}`), at, at);
    }
    await purgeSessionDir(dir, { maxFiles: 5 });
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    expect(names).toEqual(['s10.json', 's11.json', 's7.json', 's8.json', 's9.json']);
  });

  it('remet en 0600 et masque un ancien fichier 0644', async () => {
    const { purgeSessionDir } = await storeModule();
    const root = await tempDir('secu-scrub-');
    const dir = path.join(root, '.omniroute-sessions');
    await fs.mkdir(dir, { recursive: true });
    const legacyToken = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJsZWdhY3kifQ', 'c2lnbmF0dXJlLWZpY3RpdmU'].join('.');
    const file = path.join(dir, 'legacy.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, sessionId: 'legacy', updatedAt: '', messages: [{ role: 'user', content: [{ type: 'text', text: `X_TOKEN=${legacyToken}` }] }] }), { mode: 0o644 });
    await fs.chmod(file, 0o644);
    const report = await purgeSessionDir(dir, {});
    expect(report.scrubbed).toBe(1);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, 'utf8')).not.toContain(legacyToken);
  });
});

describe('secu — aucun fichier interne dans un dépôt git de projet', () => {
  it('un run dans un checkout laisse `git status` propre (sessions hors du dépôt, .tmp ignoré)', async () => {
    const repo = await tempDir('secu-repo-');
    const home = await tempDir('secu-home-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q');
    await fs.writeFile(path.join(repo, 'README.md'), 'projet\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const gateway = await startScriptedGateway((_req, index) =>
      index === 0 ? { toolCalls: [{ id: 'c0', name: 'shell', input: { command: 'mktemp >/dev/null; echo ok' } }] } : { text: 'fini' },
    );
    try {
      const { ctx } = makeTestContext({
        config: { baseUrl: gateway.baseUrl },
        context: { paperclipWorkspace: { cwd: repo, agentHome: home } },
      });
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
    } finally {
      await gateway.close();
    }
    expect(git('status', '--porcelain')).toBe('');
    expect((await fs.readdir(path.join(home, '.omniroute-sessions'))).some((n) => n.endsWith('.json'))).toBe(true);
    expect(await fs.readFile(path.join(repo, '.tmp', '.gitignore'), 'utf8')).toContain('*');
  });

  it('un fichier de session tronqué est signalé au lieu d’être ignoré en silence', async () => {
    const home = await tempDir('secu-corrupt-');
    const dir = path.join(home, '.omniroute-sessions');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'tronquee.json'), '{"version":1,"messages":[{"role":"user","content":[{"type":"te');
    const gateway = await startScriptedGateway(() => ({ text: 'ok' }));
    const logs: string[] = [];
    try {
      const { ctx } = makeTestContext({
        logs,
        config: { baseUrl: gateway.baseUrl },
        context: { paperclipWorkspace: { cwd: home, agentHome: home } },
        runtime: { sessionId: null, sessionParams: { sessionId: 'tronquee', omnirouteNativeSession: true }, sessionDisplayId: null, taskKey: null },
      });
      await execute(ctx as never);
    } finally {
      await gateway.close();
    }
    expect(logs.join('')).toMatch(/tronquee illisible/);
  });
});

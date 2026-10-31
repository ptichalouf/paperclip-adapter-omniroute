import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  createOmniRouteSessionParams,
  loadSessionMessages,
  readOmniRouteSessionParams,
  resolveSessionBaseDir,
  saveSessionMessages,
  sessionFilePath,
  trimSessionMessages,
  SESSION_MARKER_KEY,
} from '../src/server/session.js';
import type { WireMessage } from '../src/shared/wire.js';

/**
 * Continuité de session.
 *
 * OmniRoute n'a pas de session côté fournisseur : la continuité Paperclip
 * n'existe que si l'adaptateur la matérialise. Ces tests vérifient les trois
 * points qui peuvent la faire échouer silencieusement :
 *
 * 1. les `sessionParams` d'un **autre** adaptateur ne sont pas repris ;
 * 2. l'historique survit à un aller-retour disque ;
 * 3. l'historique rejoué est **borné**, sinon le coût croît sans borne.
 */
describe('session — continuité entre deux runs', () => {
  it('reconnaît ses propres sessionParams', () => {
    const params = createOmniRouteSessionParams();
    expect(readOmniRouteSessionParams({ sessionParams: params })).toEqual(params);
  });

  it('ignore les sessionParams qui ne sont pas les siens', () => {
    // Une session{d'un autre adaptateur} ne doit pas être reprise : on
    // partirait d'un historique inconnu.
    expect(
      readOmniRouteSessionParams({ sessionParams: { sessionId: 'autre-session' } }),
    ).toBeNull();
    expect(readOmniRouteSessionParams({ sessionParams: null })).toBeNull();
    expect(readOmniRouteSessionParams(undefined)).toBeNull();
  });

  it('ignore une session vide', () => {
    expect(
      readOmniRouteSessionParams({ sessionParams: { sessionId: '   ' } }),
    ).toBeNull();
  });

  it('porte un marqueur identifiable', () => {
    const params = createOmniRouteSessionParams();
    expect(params[SESSION_MARKER_KEY]).toBe(true);
    expect(params.sessionId.length).toBeGreaterThan(0);
  });

  it('conserve un identifiant de session dans un chemin sûr', () => {
    const base = '/tmp/sessions';
    const file = sessionFilePath(base, '../../etc/passwd');
    expect(file.startsWith(base + path.sep)).toBe(true);
    expect(file).not.toContain('..');
  });

  it('fait survivre l\'historique à un aller-retour disque', async () => {
    const dir = path.join('/tmp', `omniroute-session-${process.pid}`);
    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'fais la recette' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c\'est parti' }] },
    ];

    await saveSessionMessages(dir, 'session-1', messages);
    const reloaded = await loadSessionMessages(dir, 'session-1');

    expect(reloaded).toEqual(messages);
  });

  it('renvoie un historique vide si le fichier n\'existe pas', async () => {
    const dir = path.join('/tmp', `omniroute-session-absent-${process.pid}`);
    expect(await loadSessionMessages(dir, 'jamais-vue')).toEqual([]);
  });

  it('écrase l\'historique au lieu de l\'accumuler', async () => {
    const dir = path.join('/tmp', `omniroute-session-replace-${process.pid}`);
    await saveSessionMessages(dir, 's', [
      { role: 'user', content: [{ type: 'text', text: 'un' }] },
    ]);
    await saveSessionMessages(dir, 's', [
      { role: 'user', content: [{ type: 'text', text: 'deux' }] },
    ]);

    const reloaded = await loadSessionMessages(dir, 's');
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.content[0]).toEqual({ type: 'text', text: 'deux' });
  });

  it('borne l\'historique rejoué, en gardant la fin', () => {
    const messages: WireMessage[] = [];
    for (let i = 0; i < 50; i += 1) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `message ${i} `.repeat(50) }] });
    }

    const trimmed = trimSessionMessages(messages, 2_000);

    expect(trimmed.length).toBeLessThan(messages.length);
    // La fin est ce qui est en train de se passer : elle doit être gardée.
    const last = trimmed[trimmed.length - 1]?.content[0];
    expect(last).toEqual({ type: 'text', text: 'message 49 '.repeat(50) });
  });

  it('garde au moins un message, même s\'il dépasse le budget', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
    ];
    expect(trimSessionMessages(messages, 10)).toHaveLength(1);
  });

  it('ne casse pas sur un historique vide', () => {
    expect(trimSessionMessages([])).toEqual([]);
  });

  it('place les sessions dans le home de l\'agent, pas dans le workspace de run', () => {
    const base = resolveSessionBaseDir(
      { paperclipWorkspace: { cwd: '/workspace/run', agentHome: '/home/agent-1' } },
      '/workspace/run',
    );
    // Le home de l'agent est stable d'un run à l'autre ; le workspace peut
    // changer (workspace réinitialisé) et ferait perdre l'historique.
    expect(base).toContain('/home/agent-1');
    expect(base).not.toContain('/workspace/run');
  });

  it('retombe sur le workspace quand le home de l\'agent est absent', () => {
    const base = resolveSessionBaseDir(
      { paperclipWorkspace: { cwd: '/workspace/run' } },
      '/workspace/run',
    );
    expect(base).toContain('/workspace/run');
  });

  it('ignore un historique corrompu sur le disque', async () => {
    const dir = path.join('/tmp', `omniroute-session-corrupt-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 's.json'), '{ pas du json', 'utf8');

    expect(await loadSessionMessages(dir, 's')).toEqual([]);
  });
});

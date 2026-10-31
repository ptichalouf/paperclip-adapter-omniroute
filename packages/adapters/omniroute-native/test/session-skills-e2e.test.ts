import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { execute } from '../src/server/execute.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';

/**
 * Passage de relais — preuve bout en bout, sans passerelle réelle.
 *
 * Un serveur HTTP local joue le rôle de la passerelle OmniRoute : il reçoit
 * les requêtes `/v1/chat/completions` et **enregistre les corps reçus**.
 *
 * Ce que ce test prouve, et qu'un test unitaire ne pourrait pas prouver :
 *
 * 1. l'historique de session est **réellement rejoué** dans le corps de la
 *    requête — c'est la continuité de session de bout en bout ;
 * 2. les `sessionParams` sont **renvoyés** au serveur Paperclip ;
 * 3. le bundle d'instructions arrive dans le prompt **système** ;
 * 4. l'index des skills arrive dans le prompt système, et le contenu du
 *    skill **non** (il se lit à la demande) ;
 * 5. l'outil `read_skill` est proposé au modèle et lit le skill.
 */

describe('passage de relais — session, instructions et skills de bout en bout', () => {
  it('rejoue l\'historique de session et renvoie les sessionParams', async () => {
    const gateway = await startFakeGateway();
    const workspace = path.join('/tmp', `omniroute-e2e-${process.pid}`);
    await fs.mkdir(workspace, { recursive: true });

    try {
      // ── Run 1 : crée la session ────────────────────────────────────────
      const first = await execute(
        makeTestContext({
          config: { baseUrl: gateway.baseUrl },
          context: { paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
        }).ctx as never,
      );

      expect(first.exitCode).toBe(0);
      const sessionParams = first.sessionParams as { sessionId?: string } | undefined;
      expect(sessionParams?.sessionId).toBeTruthy();
      expect(first.sessionDisplayId).toBe(sessionParams?.sessionId);

      // ── Run 2 : la session est reprise, l'historique est rejoué ────────
      const second = await execute(
        makeTestContext({
          config: { baseUrl: gateway.baseUrl },
          context: { paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
          runtime: {
            sessionId: sessionParams?.sessionId ?? null,
            sessionParams,
            sessionDisplayId: sessionParams?.sessionId ?? null,
            taskKey: null,
          },
        }).ctx as never,
      );

      expect(second.exitCode).toBe(0);
      expect(second.sessionParams).toEqual(sessionParams);

      // La deuxième requête contient bien le message du premier run.
      expect(gateway.captured.length).toBe(2);
      const secondMessages = gateway.captured[1]?.messages ?? [];
      expect(secondMessages.length).toBeGreaterThan(1);
      const rendered = JSON.stringify(secondMessages);
      expect(rendered).toContain('bonjour');
    } finally {
      await gateway.close();
    }
  });

  it('injecte le bundle d\'instructions et l\'index des skills dans le prompt système', async () => {
    const gateway = await startFakeGateway();
    const workspace = path.join('/tmp', `omniroute-e2e-instr-${process.pid}`);
    await fs.mkdir(workspace, { recursive: true });
    const instructionsFile = path.join(workspace, 'AGENTS.md');
    await fs.writeFile(instructionsFile, 'RÈGLE UNIQUE : toujours livrer un fichier.', 'utf8');

    const skillDir = path.join(workspace, 'skill-demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo\ndescription: Un skill de démonstration\n---\n\nCONTENU SECRET DU SKILL\n',
      'utf8',
    );

    try {
      const result = await execute(
        makeTestContext({
          config: {
            baseUrl: gateway.baseUrl,
            instructionsFilePath: instructionsFile,
            paperclipRuntimeSkills: [
              { key: 'demo', runtimeName: 'demo', source: skillDir },
            ],
            paperclipSkillSync: { desiredSkills: [{ key: 'demo', versionId: null }] },
          },
          context: { paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
        }).ctx as never,
      );

      expect(result.exitCode).toBe(0);
      const system = gateway.captured[0]?.system ?? '';
      expect(system).toContain('RÈGLE UNIQUE');
      expect(system).toContain('demo');
      expect(system).toContain('Un skill de démonstration');
      // Le contenu du skill n'est PAS dans le prompt : il se lit à la demande.
      expect(system).not.toContain('CONTENU SECRET DU SKILL');
      // L'outil de lecture du skill est proposé.
      expect(gateway.captured[0]?.tools).toContain('read_skill');
    } finally {
      await gateway.close();
    }
  });

  it('permet au modèle de lire un skill monté', async () => {
    const gateway = await startFakeGateway({
      toolCall: { name: 'read_skill', input: { skill: 'demo' } },
    });
    const workspace = path.join('/tmp', `omniroute-e2e-skill-${process.pid}`);
    await fs.mkdir(workspace, { recursive: true });
    const skillDir = path.join(workspace, 'skill-demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo\ndescription: Un skill de démonstration\n---\n\nCONTENU SECRET DU SKILL\n',
      'utf8',
    );

    try {
      const logs: string[] = [];
      const result = await execute(
        makeTestContext({
          logs,
          config: {
            baseUrl: gateway.baseUrl,
            paperclipRuntimeSkills: [
              { key: 'demo', runtimeName: 'demo', source: skillDir },
            ],
            paperclipSkillSync: { desiredSkills: [{ key: 'demo', versionId: null }] },
          },
          context: { paperclipWorkspace: { cwd: workspace, agentHome: workspace } },
        }).ctx as never,
      );

      expect(result.exitCode).toBe(0);
      // L'appel d'outil a bien eu lieu, et le skill a été lu : le contenu du
      // skill doit apparaître dans le transcript du run.
      const transcript = logs.join('\n');
      expect(transcript).toContain('read_skill');
      expect(transcript).toContain('CONTENU SECRET DU SKILL');
    } finally {
      await gateway.close();
    }
  });

  it('échoue explicitement quand le bundle d\'instructions est illisible', async () => {
    const gateway = await startFakeGateway();

    try {
      const result = await execute(
        makeTestContext({
          config: {
            baseUrl: gateway.baseUrl,
            instructionsFilePath: '/chemin/inexistant/AGENTS.md',
          },
        }).ctx as never,
      );

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe('omniroute_instructions_unreadable');
      expect(result.errorFamily).toBe('configuration');
      // Aucune requête à la passerelle : on ne facture pas un run impossible.
      expect(gateway.captured.length).toBe(0);
    } finally {
      await gateway.close();
    }
  });
});

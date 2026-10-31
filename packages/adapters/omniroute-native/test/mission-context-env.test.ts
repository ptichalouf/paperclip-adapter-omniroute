import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAgentShellEnvForTest, buildSystemPromptForTest } from '../src/server/execute.js';
import { buildWorkspaceTools } from '../src/server/tools.js';

/**
 * Lot 8b — contexte de mission complet, comme claude_local
 * (packages/adapters/claude-local/src/server/execute.ts:221-296 côté hôte).
 * Mesuré sur ACC-2278 : `TASK=` vide dans le shell, URL de l'API masquée.
 */
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    agent: { id: 'agent-1', companyId: 'company-1', name: 'Pilote' },
    runId: 'run-42',
    authToken: 'SECRET-RUN-JWT-0001',
    agentIdentity: { keyId: 'kid-1', publicKeyPem: 'PUBLIC-PEM', privateKeyPem: 'PRIVATE-PEM-SECRET' },
    config: {
      env: {
        MON_OUTIL_URL: 'http://outil.local',
        PAPERCLIP_API_KEY: 'usurpation',
        PAPERCLIP_TASK_ID: 'faux-ticket',
        GITEA_TOKEN: 'SECRET-GITEA-0003',
        NON_TEXTE: 12,
      },
    },
    context: {
      taskId: 'issue-123',
      wakeReason: 'issue_commented',
      wakeCommentId: 'comment-9',
      approvalId: 'approval-7',
      approvalStatus: 'approved',
      issueIds: ['issue-123', 'issue-456'],
      paperclipIssue: { workMode: 'standard' },
      paperclipWorkspace: {
        cwd: '/ws/agent-1',
        source: 'project_primary',
        strategy: 'git_worktree',
        workspaceId: 'w-1',
        repoUrl: 'http://gitea/r.git',
        repoRef: 'main',
        branchName: 'feat/x',
        worktreePath: '/ws/agent-1/wt',
        agentHome: '/home-agent/agent-1',
      },
      paperclipWorkspaces: [{ cwd: '/ws/other', projectId: 'p-2' }],
      paperclipRuntimeServiceIntents: [{ name: 'web' }],
      paperclipRuntimeServices: [{ name: 'web', url: 'http://127.0.0.1:5173' }],
      paperclipRuntimePrimaryUrl: 'http://127.0.0.1:5173',
    },
    ...overrides,
  } as never;
}

describe('lot 8b — variables de mission dans le shell de l agent', () => {
  it('pose les 11 variables de mission de claude_local + le run', () => {
    const env = buildAgentShellEnvForTest(ctx());
    expect(env).toMatchObject({
      PAPERCLIP_RUN_ID: 'run-42',
      PAPERCLIP_TASK_ID: 'issue-123',
      PAPERCLIP_WAKE_REASON: 'issue_commented',
      PAPERCLIP_WAKE_COMMENT_ID: 'comment-9',
      PAPERCLIP_APPROVAL_ID: 'approval-7',
      PAPERCLIP_APPROVAL_STATUS: 'approved',
      PAPERCLIP_LINKED_ISSUE_IDS: 'issue-123,issue-456',
      PAPERCLIP_WORKSPACE_CWD: '/ws/agent-1',
      PAPERCLIP_WORKSPACE_SOURCE: 'project_primary',
      PAPERCLIP_WORKSPACE_STRATEGY: 'git_worktree',
      PAPERCLIP_WORKSPACE_ID: 'w-1',
      PAPERCLIP_WORKSPACE_REPO_URL: 'http://gitea/r.git',
      PAPERCLIP_WORKSPACE_REPO_REF: 'main',
      PAPERCLIP_WORKSPACE_BRANCH: 'feat/x',
      PAPERCLIP_WORKSPACE_WORKTREE_PATH: '/ws/agent-1/wt',
      AGENT_HOME: '/home-agent/agent-1',
      PAPERCLIP_RUNTIME_PRIMARY_URL: 'http://127.0.0.1:5173',
      PAPERCLIP_AGENT_KEY_ID: 'kid-1',
    });
    expect(JSON.parse(env['PAPERCLIP_WORKSPACES_JSON']!)).toEqual([{ cwd: '/ws/other', projectId: 'p-2' }]);
    expect(JSON.parse(env['PAPERCLIP_RUNTIME_SERVICES_JSON']!)).toEqual([{ name: 'web', url: 'http://127.0.0.1:5173' }]);
    expect(JSON.parse(env['PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON']!)).toEqual([{ name: 'web' }]);
    expect(env['PAPERCLIP_ISSUE_WORK_MODE']).toBe('standard');
  });

  it('retombe sur issueId et commentId comme claude_local', () => {
    const env = buildAgentShellEnvForTest(ctx({ context: { issueId: 'issue-9', commentId: 'c-1' } }));
    expect(env['PAPERCLIP_TASK_ID']).toBe('issue-9');
    expect(env['PAPERCLIP_WAKE_COMMENT_ID']).toBe('c-1');
  });

  it('transmet les variables configurées sur l agent, sans laisser usurper le runtime', () => {
    const env = buildAgentShellEnvForTest(ctx());
    expect(env['MON_OUTIL_URL']).toBe('http://outil.local');
    expect(env['GITEA_TOKEN']).toBe('SECRET-GITEA-0003');
    expect(env['PAPERCLIP_API_KEY']).toBe('SECRET-RUN-JWT-0001');
    expect(env['PAPERCLIP_TASK_ID']).toBe('issue-123');
    expect(env['NON_TEXTE']).toBeUndefined();
  });
});

describe('lot 8b — seuls les secrets sont masqués dans les sorties d outils', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'mission-env-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('montre l identifiant de tâche et l URL, masque le jeton et la clé privée', async () => {
    const env = buildAgentShellEnvForTest(ctx());
    const shell = buildWorkspaceTools(root, undefined, env).find((t) => t.spec.name === 'shell')!;
    const out = await shell.run({
      command: 'echo "T=$PAPERCLIP_TASK_ID A=$PAPERCLIP_AGENT_ID K=$PAPERCLIP_API_KEY P=$PAPERCLIP_AGENT_PRIVATE_KEY G=$GITEA_TOKEN"',
    });
    expect(out.content).toContain('T=issue-123');
    expect(out.content).toContain('A=agent-1');
    expect(out.content).not.toContain('SECRET-RUN-JWT-0001');
    expect(out.content).not.toContain('PRIVATE-PEM-SECRET');
    expect(out.content).not.toContain('SECRET-GITEA-0003');
  });
});

describe('lot 8b — le prompt système reste stable et sans secret', () => {
  it('nomme les variables de mission sans y figer les valeurs du run', () => {
    const prompt = buildSystemPromptForTest(ctx());
    expect(prompt).toContain('PAPERCLIP_TASK_ID');
    expect(prompt).not.toContain('issue-123');
    expect(prompt).not.toContain('run-42');
    expect(prompt).not.toContain('PRIVATE-PEM-SECRET');
    expect(prompt).not.toContain('SECRET-GITEA-0003');
  });
});

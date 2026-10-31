import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPaperclipTools, isSafeApiPath, redactSecrets } from '../src/server/paperclip-tools.js';
import { startFakePaperclip, type FakePaperclip } from './support/fake-paperclip.js';

/**
 * Lot 9 — corrections demandées par la revue A (58189) :
 * 1. le masquage du jeton se faisait APRÈS la troncature : un jeton coupé par
 *    la limite de sortie laissait un fragment visible ;
 * 2. `paperclip_api_request` acceptait `..` encodé (`%2e%2e`) et pouvait sortir
 *    de /api.
 */
const TOKEN = 'FAKE-RUN-JWT-lot9-revue-a-0001';
const RUN = 'run-lot9-revue-a';
const AGENT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';

let fake: FakePaperclip;
beforeEach(async () => {
  fake = await startFakePaperclip();
});
afterEach(async () => {
  await fake.close();
});

function tool(name: string) {
  const list = buildPaperclipTools({ apiUrl: fake.baseUrl, apiKey: TOKEN, runId: RUN, agentId: AGENT, companyId: COMPANY, taskId: TASK });
  const found = list.find((t) => t.spec.name === name);
  if (!found) throw new Error(`outil absent : ${name}`);
  return found;
}

describe('lot 9 — revue A : masquage avant troncature', () => {
  it('aucun fragment du jeton quand il est coupé par la limite de sortie', async () => {
    // Le jeton est placé à cheval sur les limites de découpe : 600 caractères
    // par chaîne (réponse réduite) et 12 000 caractères de sortie.
    for (const offset of [585, 590, 595, 599, 11_870, 11_880, 11_995]) {
      fake.route('GET /api/agents/me', { body: 'x'.repeat(offset) + TOKEN + 'y'.repeat(2_000) });
      const result = await tool('paperclip_api_request').run({ method: 'GET', path: '/agents/me' });
      for (let size = 8; size <= TOKEN.length; size += 1) {
        for (let start = 0; start + size <= TOKEN.length; start += 1) {
          expect(result.content.includes(TOKEN.slice(start, start + size))).toBe(false);
        }
      }
    }
  });

  it('redactSecrets ignore les secrets trop courts', () => {
    expect(redactSecrets('abc abcdef', ['abc', 'abcdef'])).toBe('abc [REDACTED]');
  });
});

describe('lot 9 — revue A : chemin d’API sûr', () => {
  it.each([
    '/issues/%2e%2e/%2e%2e/admin',
    '/issues/%2E%2E/x',
    '/issues/%252e%252e/x',
    '/issues/..%2fadmin',
    '/issues/x%2f..%2fadmin',
    '/issues\\\\..\\\\admin',
    '/issues/./x',
    'http://evil/x',
    '//evil/x',
    '/x?y=http://evil',
  ])('refuse %s', async (path) => {
    expect(isSafeApiPath(path)).toBe(false);
    const result = await tool('paperclip_api_request').run({ method: 'GET', path });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it.each(['/agents/me', '/issues/ACC-1/heartbeat-context', '/companies/abc/issues?status=todo&limit=5'])('accepte %s', (path) => {
    expect(isSafeApiPath(path)).toBe(true);
  });
});

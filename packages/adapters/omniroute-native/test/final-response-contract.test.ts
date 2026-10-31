import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { execute } from '../src/server/execute.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('résultat final en commentaire Paperclip', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omni-final-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('pose finalResponse.disposition=final + summary sur un run qui a du texte', async () => {
    const gateway = await startFakeGateway();
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, context: { paperclipWorkspace: { cwd } } });
    try {
      const result = await execute(ctx as never);
      const fr = (result.resultJson ?? {})['finalResponse'] as Record<string, unknown> | undefined;
      expect(fr?.['disposition']).toBe('final');
      expect(typeof fr?.['text']).toBe('string');
      expect((fr?.['text'] as string).trim().length).toBeGreaterThan(0);
      expect(typeof (result.resultJson ?? {})['summary']).toBe('string');
      expect(((result.resultJson ?? {})['summary'] as string).trim().length).toBeGreaterThan(0);
    } finally { await gateway.close(); }
  });
});

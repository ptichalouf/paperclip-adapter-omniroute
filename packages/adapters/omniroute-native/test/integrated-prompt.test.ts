import { describe, expect, it } from 'vitest';
import { buildPromptForTest, buildSystemPromptForTest } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';

describe('integrated prompt contract', () => {
  it('keeps universal MCP and decision guidance identical across MCP and handoff variants', () => {
    const prompts: string[] = [];
    for (const mcp of [false, true]) {
      for (const handoff of ['', 'First handoff', 'Different handoff']) {
        const { ctx } = makeTestContext({ context: {
          taskId: `task-${handoff}`,
          paperclipFreshSessionHandoffMarkdown: handoff,
        } });
        if (mcp) ctx['runtimeMcp'] = { getServers: () => [{
          name: 'private-server', url: 'http://private.invalid', bearerToken: 'opaque-private-token',
        }] };
        const prompt = buildSystemPromptForTest(ctx as never);
        prompts.push(prompt);
        expect(prompt).not.toContain('opaque-private-token');
        expect(prompt).not.toContain('private-server');
        if (handoff) {
          expect(prompt).not.toContain(handoff);
          expect(buildPromptForTest(ctx as never)).toContain(handoff);
        }
      }
    }
    expect(new Set(prompts).size).toBe(1);
    for (const tool of ['mcp_search_tools', 'mcp_run_tool', 'paperclip_ask_user', 'paperclip_request_confirmation']) {
      expect(prompts[0]).toContain(tool);
    }
    expect(prompts[0]).not.toContain('appel atomique');
  });
});

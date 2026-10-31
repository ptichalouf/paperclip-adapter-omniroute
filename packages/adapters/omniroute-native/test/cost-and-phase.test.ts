import { describe, expect, it, vi } from 'vitest';

import { asCost, projectChunk } from '../src/shared/chat-completions.js';
import { execute } from '../src/server/execute.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';

describe('coût OmniRoute en streaming', () => {
  it('lit usage.cost du chunk d usage SSE', () => {
    const fx = projectChunk({ choices: [], usage: { prompt_tokens: 18, completion_tokens: 4, cost: 0.0000193 } });
    expect(fx?.usage?.costUsd).toBeCloseTo(0.0000193);
  });
  it('un coût absent reste inconnu, jamais 0 inventé', () => {
    expect(projectChunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })?.usage?.costUsd).toBeNull();
    expect(asCost('0.0000193000')).toBeCloseTo(0.0000193);
    expect(asCost(-1)).toBeNull();
    expect(asCost('abc')).toBeNull();
  });
});

describe('coût remonté à Paperclip', () => {
  it('somme usage.cost de chaque tour et le déclare reported', async () => {
    const gateway = await startFakeGateway({ toolCall: { name: 'list_files', input: { path: '.' } }, costUsd: 0.0025 });
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl } });
    try {
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      expect(gateway.captured.length).toBeGreaterThan(1);
      expect(result.costUsd).toBeCloseTo(0.0025 * gateway.captured.length, 10);
      expect(result.costStatus).toBe('reported');
      expect(result.pricingProvenance?.source).toBe('provider_reported');
    } finally {
      await gateway.close();
    }
  });
  it('modèle servi avec barème connu : calcule le coût exact même si la passerelle ne le renvoie pas', async () => {
    const gateway = await startFakeGateway({
      model: 'claude/claude-opus-5-5',
      usage: { prompt_tokens: 10_000, completion_tokens: 1_000 },
    });
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl, model: 'AC-pro-coding' } });
    try {
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      // 10 000 * 4/1M + 1 000 * 20/1M = 0,04 + 0,02 = 0,06 $
      expect(result.costUsd).toBeCloseTo(0.06, 4);
      expect(result.costStatus).toBe('estimated');
      expect(result.pricingProvenance?.source).toBe('rate_card');
    } finally {
      await gateway.close();
    }
  });

  it('sans coût de la passerelle et modèle sans barème : costUsd null, aucun statut inventé', async () => {
    const gateway = await startFakeGateway();
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl } });
    try {
      const result = await execute(ctx as never);
      expect(result.costUsd).toBeNull();
      expect(result.costStatus).toBeUndefined();
    } finally {
      await gateway.close();
    }
  });
});

describe('phase d exécution', () => {
  it('ouvre puis ferme adapter_execution autour de la boucle', async () => {
    const gateway = await startFakeGateway();
    const release = vi.fn();
    const onExecutionPhase = vi.fn(() => release);
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl } });
    (ctx as Record<string, unknown>)['onExecutionPhase'] = onExecutionPhase;
    try {
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      expect(onExecutionPhase).toHaveBeenCalledWith('adapter_execution');
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await gateway.close();
    }
  });
  it('un puits de phase qui lève ne casse pas le run', async () => {
    const gateway = await startFakeGateway();
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl } });
    (ctx as Record<string, unknown>)['onExecutionPhase'] = () => { throw new Error('puits cassé'); };
    try {
      expect((await execute(ctx as never)).exitCode).toBe(0);
    } finally {
      await gateway.close();
    }
  });
});

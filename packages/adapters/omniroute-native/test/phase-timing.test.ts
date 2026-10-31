/**
 * Phases `run.phase.timing` (lot 2, t_e02303e7).
 *
 * Contrat mesuré dans l'image Paperclip : adapter-utils/src/acpx-engine/
 * startup-timing.ts:804-863 — événement émis via ctx.onEvent, payload fermé
 * { phase, durationMs, outcome }, phase prise dans une liste fermée. C'est ce
 * que le run CEO (claude_local) produit 9 fois et que omniroute_native
 * n'émettait jamais (onExecutionPhase, lui, ne crée aucun événement).
 */
import { describe, expect, it } from 'vitest';

import { execute } from '../src/server/execute.js';
import { RUN_PHASE_NAMES, emitRunPhaseTiming } from '../src/server/phase-timing.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';

type Ev = { eventType: string; stream?: string; payload?: Record<string, unknown> };

describe('run.phase.timing', () => {
  it('un run réussi émet les phases attendues, dans l ordre, au format fermé', async () => {
    const gateway = await startFakeGateway();
    const events: Ev[] = [];
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl } });
    (ctx as Record<string, unknown>)['onEvent'] = async (e: Ev) => { events.push(e); };
    try {
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
    } finally {
      await gateway.close();
    }
    const timings = events.filter((e) => e.eventType === 'run.phase.timing');
    expect(timings.map((e) => e.payload?.['phase'])).toEqual(['place_workspace', 'ensure_session', 'configure_session', 'turn', 'end_session']);
    for (const e of timings) {
      expect(Object.keys(e.payload ?? {}).sort()).toEqual(['durationMs', 'outcome', 'phase']);
      expect(e.payload?.['outcome']).toBe('ok');
      expect(typeof e.payload?.['durationMs']).toBe('number');
      expect(e.stream).toBe('system');
    }
  });

  it('workspace absent : place_workspace en échec', async () => {
    const events: Ev[] = [];
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://127.0.0.1:9' }, context: {} });
    (ctx as Record<string, unknown>)['onEvent'] = async (e: Ev) => { events.push(e); };
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(events.filter((e) => e.eventType === 'run.phase.timing').map((e) => [e.payload?.['phase'], e.payload?.['outcome']]))
      .toEqual([['place_workspace', 'failed']]);
  });

  it('un puits d événements qui lève ne casse pas le run', async () => {
    const gateway = await startFakeGateway();
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl } });
    (ctx as Record<string, unknown>)['onEvent'] = async () => { throw new Error('puits cassé'); };
    try {
      expect((await execute(ctx as never)).exitCode).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it('une phase hors liste fermée n émet rien ; une durée invalide vaut 0', async () => {
    const events: Ev[] = [];
    const sink = async (e: Ev) => { events.push(e); };
    await emitRunPhaseTiming(sink as never, 'libre' as never, 5, 'ok');
    await emitRunPhaseTiming(sink as never, 'turn', Number.NaN, 'ok');
    expect(events.map((e) => e.payload)).toEqual([{ phase: 'turn', durationMs: 0, outcome: 'ok' }]);
    expect(RUN_PHASE_NAMES).toContain('ensure_session');
  });
});

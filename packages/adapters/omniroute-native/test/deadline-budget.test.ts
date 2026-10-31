import { describe, expect, it } from 'vitest';

import { combineWithDeadline, remainingMs, withDeadline } from '../src/shared/client.js';

describe('deadline globale — le délai annoncé est un budget de run, pas de requête', () => {
  it('porte une échéance lisible sur le signal', () => {
    const signal = withDeadline(60_000);
    const remaining = remainingMs(signal);

    expect(remaining).not.toBeNull();
    expect(remaining).toBeGreaterThan(55_000);
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it('reste sans échéance pour un signal ordinaire', () => {
    expect(remainingMs(new AbortController().signal)).toBeNull();
  });

  it('propage l échéance quand on combine le signal hôte et la deadline', () => {
    const host = new AbortController().signal;
    const deadline = withDeadline(30_000);
    const combined = combineWithDeadline(host, deadline);

    const remaining = remainingMs(combined);
    expect(remaining).not.toBeNull();
    expect(remaining).toBeGreaterThan(25_000);
    expect(remaining).toBeLessThanOrEqual(30_000);
  });

  it('annule le signal combiné quand le signal hôte est annulé', () => {
    const controller = new AbortController();
    const deadline = withDeadline(30_000);
    const combined = combineWithDeadline(controller.signal, deadline);

    expect(combined.aborted).toBe(false);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });

  it('annule le signal combiné quand la deadline expire', async () => {
    const deadline = withDeadline(30);
    const combined = combineWithDeadline(new AbortController().signal, deadline);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(combined.aborted).toBe(true);
  });
});

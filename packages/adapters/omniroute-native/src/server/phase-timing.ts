/**
 * Événements `run.phase.timing` : la durée de chaque phase du run dans le
 * flux d'événements Paperclip (`heartbeat_run_events`).
 *
 * Contrat repris de l'image Paperclip (adapter-utils/src/acpx-engine/
 * startup-timing.ts:804-863, `emitRunPhaseTiming`) : un événement par phase,
 * via `ctx.onEvent`, payload **fermé** `{ phase, durationMs, outcome }`, nom de
 * phase pris dans une liste fermée — jamais de commande, chemin, valeur
 * d'environnement ni identifiant. Réimplémenté ici plutôt qu'importé : la
 * version liée des types (2026.916.1) n'est pas celle du serveur, et ce module
 * de l'engine ACPX n'est pas une API publique stable.
 *
 * `onExecutionPhase` (portées de diagnostic en mémoire) ne produit, lui,
 * aucun événement : c'était l'hypothèse fausse de la PR #3.
 */
import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';

export const RUN_PHASE_TIMING_EVENT_TYPE = 'run.phase.timing';

/** Même liste fermée que le serveur. */
export const RUN_PHASE_NAMES = [
  'place_workspace',
  'start_transport',
  'create_runtime',
  'ensure_session',
  'configure_session',
  'prepare_turn',
  'turn',
  'end_session',
  'settle_reuse',
  'stop_transport',
  'sync_back',
  'release_staging_lease',
] as const;

export type RunPhaseName = (typeof RUN_PHASE_NAMES)[number];
export type RunPhaseOutcome = 'ok' | 'failed';
type EventSink = AdapterExecutionContext['onEvent'];

const PHASES: ReadonlySet<string> = new Set(RUN_PHASE_NAMES);

/** Émet un événement de phase ; un puits qui lève ne fait jamais échouer le run. */
export async function emitRunPhaseTiming(
  onEvent: EventSink,
  phase: RunPhaseName,
  durationMs: number,
  outcome: RunPhaseOutcome,
): Promise<void> {
  if (!onEvent || !PHASES.has(phase)) return;
  const safe = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
  try {
    await onEvent({
      eventType: RUN_PHASE_TIMING_EVENT_TYPE,
      stream: 'system',
      level: 'info',
      message: `run phase: ${phase} (${safe}ms)`,
      payload: { phase, durationMs: safe, outcome },
    });
  } catch {
    // Télémétrie : jamais une cause d'échec.
  }
}

/** Chronomètre explicite, pour les phases dont l'issue se décide après coup. */
export function startPhase(onEvent: EventSink, phase: RunPhaseName) {
  const started = Date.now();
  let done = false;
  return async (outcome: RunPhaseOutcome): Promise<void> => {
    if (done) return;
    done = true;
    await emitRunPhaseTiming(onEvent, phase, Date.now() - started, outcome);
  };
}

/**
 * Lot 20 (B) — escalade : quand une tentative échoue RÉELLEMENT, la tâche est
 * reprise, avec l'historique déjà accumulé, sur le modèle suivant d'une
 * échelle configurée (ex. `AC-code` puis `AC-pro-coding`).
 *
 * À ne pas confondre avec `fallbackModel` (lot 6) : le repli porte sur la
 * DISPONIBILITÉ d'un modèle pendant un appel ; l'escalade porte sur la
 * QUALITÉ du travail d'une tentative entière.
 *
 * Mesure de départ (rapport E-produit, idée 4) : 19 % de runs natifs non
 * réussis contre 8 % pour `claude_local`.
 */
import { OmniRouteError } from '../shared/client.js';
import type { SubtaskRecord } from './subtask.js';

/** Détail d'une escalade, publié dans `resultJson.escalations`. */
export interface EscalationRecord {
  from: string;
  to: string;
  reason: string;
  /** Tours cumulés (toutes tentatives) avant l'escalade. */
  turnsBefore: number;
}

/** Erreurs d'outil identiques consécutives qui signalent une boucle bloquée. */
export const STUCK_TOOL_ERROR_THRESHOLD = 3;

/**
 * En dessous de ce délai restant, une nouvelle tentative n'a pas le temps de
 * produire un travail utile : on n'escalade pas.
 */
export const MIN_ESCALATION_REMAINING_MS = 60_000;

/** Défaut de `maxEscalations` quand une échelle est configurée (source : `shared/config.ts`). */
export { DEFAULT_MAX_ESCALATIONS } from '../shared/config.js';

/**
 * Codes d'erreur passerelle qui NE justifient PAS une escalade : un autre
 * modèle derrière la même passerelle et la même clé ne répare pas une clé
 * refusée.
 */
const NON_ESCALATING_ERROR_CODES = new Set(['omniroute_auth_rejected']);

export interface AttemptOutcome {
  completion: string;
  finalText: string;
  stuck: boolean;
  error?: unknown;
}

/**
 * Motif d'échec réel d'une tentative, ou `null` si la tentative n'appelle pas
 * d'escalade (réussite, annulation, sortie coupée par `maxTokens`, erreur non
 * passerelle ou identifiants refusés).
 */
export function escalationReason(attempt: AttemptOutcome): string | null {
  if (attempt.error !== undefined) {
    if (!(attempt.error instanceof OmniRouteError)) return null;
    const code = attempt.error.classified.errorCode;
    if (NON_ESCALATING_ERROR_CODES.has(code)) return null;
    return `model_error:${code}`;
  }
  if (attempt.stuck) return 'stuck_tool_errors';
  if (attempt.completion === 'max_turns') return 'no_final_response';
  if (attempt.completion === 'completed' && attempt.finalText.trim().length === 0) return 'no_final_response';
  return null;
}

/** Libellé lisible d'un motif, pour le message de reprise et le transcript. */
export function describeEscalationReason(reason: string): string {
  if (reason === 'no_final_response') return 'pas de réponse finale, même après le tour de synthèse';
  if (reason === 'stuck_tool_errors') return `boucle bloquée : ${STUCK_TOOL_ERROR_THRESHOLD} erreurs d'outil identiques de suite`;
  if (reason.startsWith('model_error:')) return `erreur du modèle non récupérable (${reason.slice('model_error:'.length)})`;
  return reason;
}

/**
 * Modèle suivant de l'échelle : celui qui suit le modèle courant s'il y
 * figure, sinon le premier ; jamais un modèle déjà essayé dans ce run.
 */
export function nextEscalationModel(ladder: readonly string[], current: string, tried: ReadonlySet<string>): string | null {
  const index = ladder.indexOf(current);
  const candidates = index >= 0 ? ladder.slice(index + 1) : ladder;
  return candidates.find((model) => !tried.has(model)) ?? null;
}

/** Message utilisateur ajouté à l'historique avant la reprise. */
export function escalationPrompt(from: string, reason: string): string {
  return (
    `La tentative avec « ${from} » a échoué (${describeEscalationReason(reason)}). ` +
    'Tu prends le relais : reprends la tâche là où elle en est, à partir de l’historique ci-dessus, ' +
    'sans refaire ce qui est déjà fait, puis termine-la et donne ta réponse finale.'
  );
}

/**
 * Champs ajoutés au `resultJson` du run (lot 20). Vide quand aucune
 * sous-tâche ni escalade n'a eu lieu : sans réglage, le résultat est inchangé.
 */
export function delegationResultFields(result: {
  subtasks?: SubtaskRecord[];
  escalations?: EscalationRecord[];
  finalModel?: string;
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (result.subtasks && result.subtasks.length > 0) fields['subtasks'] = result.subtasks;
  if (result.escalations && result.escalations.length > 0) {
    fields['escalations'] = result.escalations;
    if (result.finalModel) fields['finalModel'] = result.finalModel;
  }
  return fields;
}

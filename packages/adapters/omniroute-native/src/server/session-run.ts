/**
 * Session d'un run : ouverture, points de contrôle, essai à neuf
 * (ACC-2297, ACC-2289).
 *
 * `execute.ts` orchestre le run ; ce module porte tout ce qui touche à la
 * session pour que ses retouches restent courtes :
 *
 * - **ouverture** : dossier stable et privé, purge, historique rechargé et
 *   masqué, état « reprise » réel (une session sans historique sur le disque
 *   n'est pas une reprise : le modèle ne se souviendrait de rien) ;
 * - **points de contrôle** : à la fin de chaque tour d'outils, la session est
 *   sauvegardée et l'usage cumulé remonté à l'hôte par `ctx.onUsage` ; un run
 *   qui plante ou qui est coupé ne perd ni l'historique ni l'usage ;
 * - **essai à neuf** : si le modèle refuse l'historique repris (400, contexte
 *   dépassé, paire outil incohérente), on recommence une fois sans historique
 *   avec une passation courte, sur une nouvelle session ; référence
 *   `claude-local/src/server/execute.ts:1347-1388`.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { OmniRouteError } from '../shared/client.js';
import type { WireMessage } from '../shared/wire.js';
import type { OmniRouteUsageCheckpoint } from './contract.js';
import {
  createOmniRouteSessionParams,
  deleteSessionFile,
  loadSessionState,
  readOmniRouteSessionParams,
  resolveSessionStorage,
  SessionWriter,
  trimSessionMessages,
  type OmniRouteSessionParams,
  type SessionStorageSource,
} from './session.js';
import { ensureGitIgnoreAll, ensurePrivateDir, purgeSessionDir } from './session-store.js';

export interface RunSessionAttempt {
  params: OmniRouteSessionParams;
  history: WireMessage[];
  /** Vraie reprise : une session connue **et** un historique rejoué. */
  resumed: boolean;
  writer: SessionWriter;
  /** Essai à neuf après un historique refusé. */
  freshRetry: boolean;
}

export interface OpenRunSessionInput {
  context: Record<string, unknown> | undefined;
  runtime: { sessionParams?: Record<string, unknown> | null } | undefined;
  workspaceCwd: string;
  historyBudget: number;
  redact: (text: string) => string;
  log: (text: string) => Promise<void>;
  warn: (text: string) => Promise<void>;
}

export interface OpenedRunSession {
  attempt: RunSessionAttempt;
  baseDir: string;
  source: SessionStorageSource;
}

/** Ouvre la session du run (ne lève jamais : au pire, une session neuve). */
export async function openRunSession(input: OpenRunSessionInput): Promise<OpenedRunSession> {
  const { baseDir, source } = resolveSessionStorage(input.context, input.workspaceCwd);
  const existing = readOmniRouteSessionParams(input.runtime);

  try {
    await ensurePrivateDir(baseDir);
  } catch (error) {
    await input.warn(`dossier de session inutilisable (${error instanceof Error ? error.message : String(error)}) : continuité non garantie`);
  }
  // `.tmp/` (TMPDIR du shell) est dans le workspace : un `.gitignore` « * »
  // l'exclut d'un `git add -A` dans un checkout de projet.
  await ensureGitIgnoreAll(path.join(input.workspaceCwd, '.tmp')).catch(() => undefined);
  if (source === 'workspace') {
    await input.warn('home stable de l’agent absent : sessions rangées dans le workspace (dossier privé, ignoré par git)');
  }

  const purge = await purgeSessionDir(baseDir, {
    keep: existing ? [existing.sessionId] : [],
  }).catch(() => null);
  if (purge && (purge.deleted > 0 || purge.scrubbed > 0)) {
    await input.log(`[omniroute_native] sessions : ${purge.deleted} purgée(s), ${purge.scrubbed} ancienne(s) remise(s) en 0600 et masquée(s)`);
  }

  let history: WireMessage[] = [];
  if (existing) {
    const state = await loadSessionState(baseDir, existing.sessionId, input.redact);
    if (state.status === 'corrupt') {
      await input.warn(`fichier de session ${existing.sessionId} illisible (tronqué ?) : reprise sans historique`);
    }
    history = trimSessionMessages(state.messages, input.historyBudget);
  }
  const params = existing ?? createOmniRouteSessionParams();
  return {
    baseDir,
    source,
    attempt: {
      params,
      history,
      resumed: Boolean(existing) && history.length > 0,
      writer: new SessionWriter({
        baseDir,
        sessionId: params.sessionId,
        historyLength: history.length,
        budget: input.historyBudget,
        redact: input.redact,
      }),
      freshRetry: false,
    },
  };
}

/**
 * L'erreur signifie-t-elle « le modèle refuse l'historique repris » ?
 *
 * Seulement si un historique a été rejoué, si aucun tour d'outils n'a encore
 * abouti dans ce run (sinon le travail du run serait perdu ; la session,
 * sauvegardée à chaque tour, sera reprise au réveil suivant), et si l'erreur
 * est un refus de forme (400/413/422) ou un dépassement de contexte. Un 401,
 * un 404 (modèle inconnu), un 429 ou un 5xx ne viennent pas de l'historique.
 */
export function isHistoryRejection(error: unknown, attempt: RunSessionAttempt, checkpointsInAttempt: number): boolean {
  if (attempt.freshRetry || attempt.history.length === 0 || checkpointsInAttempt > 0) return false;
  if (!(error instanceof OmniRouteError)) return false;
  const code = error.classified.errorCode;
  if (code === 'omniroute_context_length_exceeded') return true;
  return code === 'omniroute_invalid_request' && (error.status === 400 || error.status === 413 || error.status === 422);
}

/**
 * Passe à une session neuve après un historique refusé : l'ancien fichier
 * est supprimé (il serait refusé à chaque réveil), une passation courte est
 * rendue pour le prompt.
 */
export async function startFreshAttempt(
  opened: OpenedRunSession,
  error: unknown,
  redact: (text: string) => string,
  historyBudget: number,
): Promise<{ attempt: RunSessionAttempt; handoff: string }> {
  const previous = opened.attempt;
  await deleteSessionFile(opened.baseDir, previous.params.sessionId);
  const params = createOmniRouteSessionParams();
  const code = error instanceof OmniRouteError ? error.classified.errorCode : 'omniroute_run_failed';
  const attempt: RunSessionAttempt = {
    params,
    history: [],
    resumed: false,
    writer: new SessionWriter({ baseDir: opened.baseDir, sessionId: params.sessionId, historyLength: 0, budget: historyBudget, redact }),
    freshRetry: true,
  };
  opened.attempt = attempt;
  return {
    attempt,
    handoff: [
      '## Passation (session repartie à neuf)',
      '',
      `La session précédente n'a pas pu être reprise : le modèle a refusé son historique (${code}).`,
      'Tu repars d\'une session neuve, sans cet historique. Avant d\'agir, vérifie l\'état réel de la tâche (ticket, commentaires, fichiers du workspace) pour ne pas refaire une action déjà faite.',
    ].join('\n'),
  };
}

/** Instantané reçu de la boucle à la fin de chaque tour d'outils. */
export interface LoopCheckpoint {
  messages: WireMessage[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costTurnsMissing: number;
  servedModel: string | null;
}

/**
 * Points de contrôle d'un run : sauvegarde de la session et reçu d'usage
 * intermédiaire (`complete: false`), sous un `attemptId` unique pour tout le
 * run — l'hôte remplace le reçu précédent au lieu de l'additionner, puis le
 * résultat final le remplace à son tour.
 */
export class RunCheckpointer {
  readonly attemptId = randomUUID();
  last: LoopCheckpoint | null = null;
  /** Points de contrôle de l'essai en cours (remis à zéro à l'essai à neuf). */
  inAttempt = 0;
  private warnedSave = false;

  constructor(
    private readonly opened: OpenedRunSession,
    private readonly onUsage: ((receipt: OmniRouteUsageCheckpoint) => Promise<void>) | undefined,
    private readonly warn: (text: string) => Promise<void>,
  ) {}

  newAttempt(): void {
    this.inAttempt = 0;
  }

  readonly onCheckpoint = async (snapshot: LoopCheckpoint): Promise<void> => {
    this.inAttempt += 1;
    this.last = snapshot;
    const writer = this.opened.attempt.writer;
    if (!(await writer.save(snapshot.messages)) && !this.warnedSave) {
      this.warnedSave = true;
      await this.warn(`point de contrôle de session non écrit : ${writer.lastError ?? 'erreur inconnue'}`);
    }
    const receipt = usageReceipt(snapshot, this.attemptId);
    if (!receipt || !this.onUsage) return;
    try {
      await this.onUsage(receipt);
    } catch (error) {
      await this.warn(`reçu d'usage intermédiaire refusé par l'hôte : ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** Reçu d'usage intermédiaire ; `null` s'il n'y a encore ni jeton ni coût. */
export function usageReceipt(snapshot: LoopCheckpoint, attemptId: string): OmniRouteUsageCheckpoint | null {
  const tokens = snapshot.inputTokens + snapshot.outputTokens + snapshot.cacheReadTokens + snapshot.cacheWriteTokens;
  // Même règle que le résultat final (lot 10) : 0 $ avec des tours sans coût = inconnu.
  const cost = snapshot.costUsd === null || (snapshot.costTurnsMissing > 0 && snapshot.costUsd === 0) ? null : snapshot.costUsd;
  if (tokens === 0 && cost === null) return null;
  return {
    attemptId,
    usage: {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cachedInputTokens: snapshot.cacheReadTokens,
      cacheWriteTokens: snapshot.cacheWriteTokens,
    },
    usageBasis: 'per_run',
    provider: 'omniroute_native',
    model: snapshot.servedModel,
    billingType: 'api',
    costUsd: cost,
    ...(cost === null ? {} : { costStatus: snapshot.costTurnsMissing > 0 ? ('estimated' as const) : ('reported' as const) }),
    complete: false,
  };
}

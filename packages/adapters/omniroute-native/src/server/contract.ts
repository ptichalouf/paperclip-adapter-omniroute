/**
 * Contrat d'exécution — l'écart entre les types embarqués et le contrat réel.
 *
 * **Le problème.** L'instance Paperclip lie une version d'`adapter-utils`
 * (`2026.916.1`) dans le `node_modules` de l'agent, mais le **serveur**
 * (`/app/packages/adapter-utils`) applique un contrat plus récent :
 *
 * | Élément | Types linked (`2026.916.1`) | Contrat du serveur |
 * |---|---|---|
 * | `ctx.onProviderStopped` | absent | présent (fourni par `runtime-execution.ts`) |
 * | `ctx.onExecutionPhase` | absent | présent (phases de runtime) |
 * | `errorFamily: "configuration"` | absent de l'union | accepté |
 *
 * Déclarer une dépendance sur la version **du serveur** (`2026.1023.0`)
 * ferait passer le typecheck local — le typecheck raisonne alors sur des
 * types que l'instance n'embarque pas. Le code exécuterait sur
 * `2026.916.1`, où `onProviderStopped` n'est pas dans le contrat : le
 * hook deviendrait invisible au typecheck et pourrait disparaître.
 *
 * Déclarer une dépendance sur `2026.916.1` (ce que fait ce paquet) est
 * exact, mais alors le typecheck signale deux écarts — justes : ce sont
 * exactement les deux points où le contrat du serveur est plus riche que
 * les types disponibles.
 *
 * **La solution.** Déclarer **localement** l'extension du contrat, ici, en
 * un seul endroit. Le typecheck reste aligné sur la version réellement
 * liée, et le code continue de scrupuleusement respecter le contrat que le
 * serveur applique.
 *
 * Ces deux éléments sont donc traités comme suit :
 *
 * - `onProviderStopped` : le serveur le fournit (mesuré dans
 *   `runtime-execution.ts:828`). On l'appelle — c'est le contrat —
 *   et sa présence est vérifiée par la recette d'annulation.
 * - `errorFamily: "configuration"` : le serveur l'accepte et n'en fait
 *   **aucun** traitement de reprise (`retries.ts` ne rejoue que
 *   `transient_upstream` et `provider_quota`). C'est donc le bon marqueur
 *   pour une erreur de configuration : un échec définitif, jamais rejoué.
 */
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from '@paperclipai/adapter-utils';
import type { AdapterExecutionErrorFamily } from '@paperclipai/adapter-utils/types';

/**
 * Familles d'erreur, union élargie à celle du serveur.
 *
 * La version liée ne connaît pas `"configuration"` ; le serveur, si. On
 * l'ajoute explicitement plutôt que de supprimer l'information.
 */
export type OmniRouteErrorFamily = AdapterExecutionErrorFamily | 'configuration';

/**
 * Contexte d'exécution, avec le hook que le serveur fournit et que les
 * types liés ne déclarent pas.
 */
export interface OmniRouteExecutionContext extends AdapterExecutionContext {
  /**
   * Appelé après l'arrêt **confirmé** de la dernière invocation
   * fournisseur. Le serveur s'en sert pour collecter les instructions
   * persistées (« instruction_collection »).
   */
  onProviderStopped?: () => Promise<void>;

  /**
   * Phases d'exécution. Le serveur les attend pour piloter l'UI ; un
   * adaptateur qui ne les signale pas fait tourner le run sans indication
   * de phase. L'adaptateur ouvre la portée `adapter_execution` autour de la
   * boucle modèle ↔ outils ; le hook renvoie la fonction de fermeture.
   */
  onExecutionPhase?: (phase: string) => (() => void) | void;

  /**
   * Points de contrôle d'usage en cours de run (hôte récent :
   * `adapter-utils/src/types.ts:275`, enregistrés par `usageRecorder.capture`
   * dans `heartbeat/runtime-execution.ts:620,818`). Le dernier reçu est
   * conservé si le run échoue ou si le processus meurt : sans eux, un run
   * coupé au tour 40 était compté 0 jeton.
   */
  onUsage?: (receipt: OmniRouteUsageCheckpoint) => Promise<void>;

  /**
   * Passation bornée fournie par l'hôte, « uniquement quand un essai
   * fournisseur démarre à neuf » (`types.ts`, `getFreshSessionHandoff`).
   */
  getFreshSessionHandoff?: () => Promise<string | null>;
}

/**
 * Reçu d'usage intermédiaire (`AdapterUsageCheckpoint` de l'hôte, absent des
 * types liés 2026.916.1). `attemptId` doit être un UUID (schéma zod du
 * serveur, `usage-receipts.ts:22`) ; un même `attemptId` remplace le reçu
 * précédent au lieu de s'y ajouter.
 */
export interface OmniRouteUsageCheckpoint {
  attemptId?: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number };
  usageBasis?: 'per_run' | 'session_cumulative' | null;
  provider?: string | null;
  model?: string | null;
  billingType?: 'api' | null;
  costUsd?: number | null;
  costStatus?: 'reported' | 'estimated' | 'unpriced';
  complete: boolean;
}

/**
 * Convertit le contexte public en contexte étendu.
 *
 * Un seul point de conversion dans tout l'adaptateur : c'est ici que l'on
 * déclare « le serveur fournit plus que les types ne le disent ».
 */
/**
 * Champs de grand livre que le serveur lit sur le résultat
 * (`services/heartbeat/run-completion.ts` : `adapterResult.costStatus`,
 * `adapterResult.pricingProvenance`) mais que la version liée des types
 * (2026.916.1) ne déclare pas encore. Mesuré dans le conteneur :
 * `adapter-utils/src/types.ts` les porte sur `AdapterExecutionResult`.
 */
export type OmniRouteExecutionRecovery =
  | { kind: 'bootstrap'; providerWorkStarted: false }
  | { kind: 'interrupted'; providerStopped: true; sessionPreserved: true; actionOutcomes: 'settled' };

/**
 * Preuve « interrompu proprement » (`legacy-execution-recovery.ts:36-40` de
 * l'hôte) : le fournisseur est arrêté, la session est conservée et chaque
 * action a son issue (un résultat par appel d'outil). Le serveur ne s'en sert
 * que pour un run `cancelled` dont l'annulation est `acknowledged` : il
 * n'exige alors pas de réconciliation des actions avant de reprendre.
 * À ne déclarer que si la session a réellement été sauvegardée.
 */
export const INTERRUPTED_RECOVERY = {
  kind: 'interrupted',
  providerStopped: true,
  sessionPreserved: true,
  actionOutcomes: 'settled',
} as const satisfies OmniRouteExecutionRecovery;

export interface OmniRouteCostReceipt {
  costStatus?: 'reported' | 'estimated' | 'unpriced';
  pricingProvenance?: {
    source: 'provider_reported' | 'provider_invoice' | 'operator' | 'rate_card' | 'unknown';
    evidence?: string;
  };
}

/** Résultat d'exécution tel que le serveur le lit réellement. */
export type OmniRouteExecutionResult = AdapterExecutionResult & OmniRouteCostReceipt;

export function asOmniRouteContext(ctx: AdapterExecutionContext): OmniRouteExecutionContext {
  return ctx as OmniRouteExecutionContext;
}

/**
 * Construit un résultat d'échec.
 *
 * `errorFamily` est typé par l'union du serveur ; la conversion en
 * `AdapterExecutionResult['errorFamily']` est faite **ici**, une fois, au
 * lieu d'être dispersée dans le code.
 */
export function buildFailureResult(
  result: Omit<AdapterExecutionResult, 'errorFamily'> & { errorFamily?: OmniRouteErrorFamily },
): AdapterExecutionResult {
  return {
    ...result,
    errorFamily:
      result.errorFamily === undefined
        ? null
        : (result.errorFamily as AdapterExecutionResult['errorFamily']),
  };
}

/** Extension serveur de ServerAdapterModule (2026.1023+). */
export interface OmniRouteServerAdapterModule extends ServerAdapterModule {
  supportsToolRefreshOnResume?: boolean;
}

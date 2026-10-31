/**
 * Classification des erreurs de la passerelle OmniRoute.
 *
 * OmniRoute est un agrégateur : une même requête peut échouer côté OmniRoute
 * lui-même, côté fournisseur amont (Anthropic, OpenAI, …), ou côté admission de
 * capacité. Ces cas n'ont pas du tout la même conduite à tenir :
 *
 * - **admission / 503 / 502 / 504** : transitoire. On réessaie avec un backoff
 *   et on renseigne `retryNotBefore` pour que Paperclip suspende proprement le
 *   run au lieu de le compter comme un échec définitif.
 * - **quota** : attendre la fenêtre de reset, pas réessayer en boucle serrée.
 * - **4xx de forme (400/422)** : notre requête est malformée — réessayer ne
 *   servirait à rien et masquerait un vrai bug d'adaptateur.
 *
 * Attention à la forme de `AdapterExecutionErrorFamily` : c'est une union
 * fermée de six membres, tous orientés « reprise ». Les échecs qui ne relèvent
 * pas d'une reprise (mauvaise clé, requête invalide) n'ont donc **pas** de
 * famille : on renvoie `family: null` et on s'appuie sur `errorCode` pour que
 * l'opérateur voie immédiatement de quoi il s'agit. Inventer une famille pour
 * les ranger serait un abus de type et ferait prendre à Paperclip une décision
 * de reprise sur la mauvaise base.
 *
 * Le type est importé du sous-chemin `/types` et non de la racine : le
 * `index.d.ts` publié ré-exporte une liste figée de types qui omet
 * `AdapterExecutionErrorFamily`, alors que le module `types` le déclare bien.
 * Le sous-chemin est exposé par la carte `exports` (`"./*": "./dist/*.d.ts"`),
 * donc l'import se résout chez l'hôte comme chez nous — et un `import type` ne
 * survit pas à la compilation, il n'y a donc rien à résoudre à l'exécution.
 */
import type { AdapterExecutionErrorFamily } from '@paperclipai/adapter-utils/types';

export interface GatewayErrorShape {
  status?: number;
  /** Code machine renvoyé par OmniRoute ou par le fournisseur amont. */
  code?: string;
  message?: string;
  /** Valeur de l'en-tête `Retry-After`, en secondes, si présente. */
  retryAfterSec?: number;
}

export interface ClassifiedGatewayError {
  /**
   * Famille Paperclip, ou `null` quand l'échec n'est pas une condition de
   * reprise (identifiants refusés, requête malformée).
   */
  family: AdapterExecutionErrorFamily | null;
  /** Code stable et lisible, journalisé dans `errorCode`. */
  errorCode: string;
  /** Vrai si relancer la même requête a une chance raisonnable d'aboutir. */
  retryable: boolean;
  /** Instant ISO à partir duquel réessayer, si la passerelle l'a indiqué. */
  retryNotBefore: string | null;
  /** Diagnostic court, sans secret, destiné au transcript. */
  summary: string;
}

/**
 * Motifs textuels des messages d'admission observés sur l'instance de l'agence
 * (`API Error: 503 Chat admission capacity is temporarily unavailable ...`).
 * OmniRoute ne renvoie pas toujours un code machine exploitable : le message
 * reste le signal le plus fiable.
 */
const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /admission capacity/i,
  /temporarily unavailable/i,
  /capacity is temporarily/i,
  /overloaded/i,
  /upstream (?:error|timeout)/i,
  /bad gateway/i,
  /service unavailable/i,
  /timed? ?out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i,
  /socket hang up/i,
  /connection (?:reset|closed)/i,
];

const QUOTA_MESSAGE_PATTERNS: readonly RegExp[] = [
  /quota/i,
  /rate limit/i,
  /too many requests/i,
  /insufficient (?:credit|balance|funds)/i,
  /billing/i,
  /usage limit/i,
  /credit balance is too low/i,
];

const CONTEXT_EXCEEDED_PATTERNS: readonly RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /input exceeds maximum/i,
  /prompt (?:is )?too long/i,
  /too many tokens in prompt/i,
];

const REFUSAL_MESSAGE_PATTERNS: readonly RegExp[] = [
  /refus(?:al|ed) to (?:generate|answer|respond)/i,
  /content policy/i,
  /safety (?:filter|system)/i,
  /blocked by (?:the )?(?:safety|content)/i,
];

const AUTH_MESSAGE_PATTERNS: readonly RegExp[] = [
  /authentication required/i,
  /invalid[_ ]api[_ ]key/i,
  /unauthorized/i,
  /no api key/i,
  /missing api key/i,
];

/** Codes machine qui, quelle que soit leur famille, justifient un nouvel essai. */
const TRANSIENT_CODES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'service_unavailable',
  'upstream_error',
  'admission_rejected',
]);

const QUOTA_CODES = new Set([
  'insufficient_quota',
  'quota_exceeded',
  'billing_hard_limit_reached',
  'credit_balance_too_low',
]);

/**
 * Traduit un échec de passerelle en famille d'erreur Paperclip.
 *
 * L'ordre des tests compte : un 429 portant « quota » doit être classé quota
 * (attendre la fenêtre) et non transitoire (réessayer tout de suite).
 */
export function classifyGatewayError(input: GatewayErrorShape): ClassifiedGatewayError {
  const status = input.status;
  const code = (input.code ?? '').toLowerCase();
  const message = input.message ?? '';
  const haystack = `${code} ${message}`;

  const retryNotBefore = computeRetryNotBefore(input.retryAfterSec);

  const classify = (
    family: AdapterExecutionErrorFamily | null,
    errorCode: string,
    retryable: boolean,
    summary: string,
  ): ClassifiedGatewayError => ({ family, errorCode, retryable, retryNotBefore, summary });

  if (code === 'context_length_exceeded' || matches(CONTEXT_EXCEEDED_PATTERNS, haystack)) {
    return classify(
      null,
      'omniroute_context_length_exceeded',
      false,
      'La requête dépasse la fenêtre de contexte maximale du modèle : compacter l’historique ou utiliser un modèle à plus large fenêtre.',
    );
  }

  if (QUOTA_CODES.has(code) || matches(QUOTA_MESSAGE_PATTERNS, haystack)) {
    return classify(
      'provider_quota',
      'omniroute_provider_quota',
      true,
      'Quota du fournisseur amont atteint : attendre la fenêtre de réinitialisation avant de relancer.',
    );
  }

  if (REFUSAL_MESSAGE_PATTERNS.some((re) => re.test(message))) {
    return classify(
      'model_refusal',
      'omniroute_model_refusal',
      false,
      'Le modèle amont a refusé de répondre à cette requête.',
    );
  }

  if (status === 401 || status === 403 || AUTH_MESSAGE_PATTERNS.some((re) => re.test(haystack))) {
    // Un 401 ne se répare pas en réessayant : la clé est absente, expirée ou
    // refusée. Pas de famille — c'est un défaut de configuration, pas une
    // condition de reprise.
    return classify(
      null,
      'omniroute_auth_rejected',
      false,
      'La passerelle refuse nos identifiants. Vérifier `apiKey` / OMNIROUTE_API_KEY — OmniRoute exige `Authorization: Bearer`, il rejette `x-api-key`.',
    );
  }

  if (status === 503 || status === 502 || status === 504 || TRANSIENT_CODES.has(code) || matches(TRANSIENT_MESSAGE_PATTERNS, haystack)) {
    return classify(
      'transient_upstream',
      'omniroute_transient_upstream',
      true,
      'Capacité d’admission de la passerelle momentanément indisponible : nouvelle tentative avec backoff.',
    );
  }

  if (status === 429) {
    return classify(
      'provider_quota',
      'omniroute_rate_limited',
      true,
      'Débit limité par la passerelle ou le fournisseur amont : ralentir puis réessayer.',
    );
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return classify(
      null,
      'omniroute_invalid_request',
      false,
      `Requête rejetée par la passerelle (HTTP ${status}). Corriger la configuration de l’adaptateur avant de relancer.`,
    );
  }

  return classify(
    'transient_upstream',
    'omniroute_unknown_upstream',
    true,
    'Échec de la passerelle OmniRoute sans cause identifiable : traité comme transitoire.',
  );
}

function matches(patterns: readonly RegExp[], haystack: string): boolean {
  return patterns.some((re) => re.test(haystack));
}

/**
 * Convertit `Retry-After` (secondes) en horodatage absolu. On plafonne à une
 * heure : au-delà, un run qui attend n'a plus de valeur, mieux vaut rendre la
 * main à Paperclip avec une erreur franche.
 */
export function computeRetryNotBefore(
  retryAfterSec: number | undefined,
  now: Date = new Date(),
): string | null {
  if (retryAfterSec === undefined || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
    return null;
  }
  const capped = Math.min(retryAfterSec, 3600);
  return new Date(now.getTime() + capped * 1000).toISOString();
}

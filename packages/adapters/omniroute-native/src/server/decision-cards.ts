/**
 * Cartes décisionnelles natives Paperclip (v1.2).
 *
 * Outils `paperclip_ask_user` et `paperclip_request_confirmation`.
 * Permettent à l'agent de soumettre une décision formelle au board plutôt
 * que de poser des questions en commentaire texte.
 *
 * Invariants stricts :
 * 1. Posture in_review atomique : chaque carte est immédiatement suivie d'un PATCH
 *    in_review sur le ticket. En cas d'échec du PATCH, l'interaction est annulée.
 * 2. continuationPolicy: 'wake_assignee' systématique.
 * 3. Garde-fou anti-cumul (recherche préalable d'interactions pending) et plafond
 *    strict d'une interaction par heartbeat run.
 * 4. Signal d'attente humaine (waitingForHuman: true) renvoyé sur le ToolResult pour
 *    clôturer proprement la boucle d'agent.
 */
import { createHash } from 'node:crypto';
import type { WorkspaceTool, ToolResult } from './tools.js';
import {
  type PaperclipToolsOptions,
  PaperclipRest,
  InputError,
  DeliverError,
  errorText,
  redactSecrets,
} from './paperclip-tools.js';

export const ASK_USER_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    issueId: {
      type: 'string',
      description: 'Identifiant du ticket (défaut : ticket courant du run).',
    },
    title: {
      type: 'string',
      description: 'Titre concis de la carte de décision (ex. "Choix de la base de données").',
    },
    questions: {
      type: 'array',
      description: 'Liste des questions posées à l’utilisateur (1 à 10 questions).',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Identifiant stable de la question (ex. "db_engine").',
          },
          prompt: {
            type: 'string',
            description: 'Texte complet de la question.',
          },
          selectionMode: {
            type: 'string',
            enum: ['single', 'multi'],
            description: 'Mode de sélection : single (choix unique) ou multi (choix multiple). Défaut : single.',
          },
          answerMode: {
            type: 'string',
            enum: ['single_select', 'multi_select', 'text'],
            description: 'Mode de réponse alternatif : choix unique, choix multiple, ou texte libre (défaut : single_select).',
          },
          required: {
            type: 'boolean',
            description: 'Réponse obligatoire ou facultative (défaut : true).',
          },
          options: {
            type: 'array',
            description: 'Choix proposés (obligatoire si non texte libre, min 2 options).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Valeur technique retournée.' },
                label: { type: 'string', description: 'Libellé affiché sur le bouton/case.' },
                description: { type: 'string', description: 'Explication complémentaire sous le libellé.' },
                freeText: { type: 'boolean', description: 'Si true, la sélection ouvre un champ texte libre.' },
              },
              required: ['id', 'label'],
            },
          },
          customAnswer: {
            type: 'boolean',
            description: 'Permettre à l’utilisateur de saisir une réponse libre personnalisée ("Autre").',
          },
          allowOther: {
            type: 'boolean',
            description: 'Permettre à l’utilisateur de saisir une réponse libre personnalisée ("Autre").',
          },
        },
        required: ['id', 'prompt'],
      },
      minItems: 1,
      maxItems: 10,
    },
    comment: {
      type: 'string',
      description: 'Commentaire markdown accompagnant le passage en in_review (défaut généré automatiquement).',
    },
    idempotencyKey: {
      type: 'string',
      description: 'Clé d’idempotence unique (optionnelle, calculée automatiquement si omise).',
    },
  },
  required: ['title', 'questions'],
} as const;

export const REQUEST_CONFIRMATION_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    issueId: {
      type: 'string',
      description: 'Identifiant du ticket (défaut : ticket courant du run).',
    },
    title: {
      type: 'string',
      description: 'Titre de la carte d’approbation (ex. "Approbation du plan de refonte").',
    },
    prompt: {
      type: 'string',
      description: 'Question binaire posée à l’opérateur (ex. "Validez-vous le plan d’action ?").',
    },
    targetKey: {
      type: 'string',
      description: 'Clé du document associé dans le ticket (défaut : "plan").',
    },
    targetRevisionId: {
      type: 'string',
      description: 'ID de révision exacte du document. Si omis, la dernière révision est lue automatiquement.',
    },
    acceptLabel: {
      type: 'string',
      description: 'Libellé du bouton positif (défaut : "Valider le plan").',
    },
    rejectLabel: {
      type: 'string',
      description: 'Libellé du bouton négatif (défaut : "Demander des modifications").',
    },
    rejectRequiresReason: {
      type: 'boolean',
      description: 'Si true, oblige l’opérateur à saisir un motif s’il refuse (défaut : true).',
    },
    detailsMarkdown: {
      type: 'string',
      description: 'Détails ou résumé du plan affiché sous la question.',
    },
    comment: {
      type: 'string',
      description: 'Commentaire accompagnant la mise en in_review.',
    },
    idempotencyKey: {
      type: 'string',
      description: 'Clé d’idempotence (optionnelle, calculée automatiquement).',
    },
  },
  required: ['title', 'prompt'],
} as const;

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function optString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InputError(`« ${key} » doit être une chaîne`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function reqString(input: Record<string, unknown>, key: string): string {
  const value = optString(input, key);
  if (value === undefined) throw new InputError(`« ${key} » est requis`);
  return value;
}

const enc = encodeURIComponent;

function describeError(toolName: string, error: unknown): string {
  if (error instanceof DeliverError) return error.message;
  if (error instanceof InputError) return `Arguments refusés pour ${toolName} : ${error.message}. Rien n’a été envoyé.`;
  return `Échec de ${toolName} : ${errorText(error)}`;
}

interface StorageQuestionOption {
  id: string;
  label: string;
  description?: string;
  freeText?: boolean;
}

interface StorageQuestion {
  id: string;
  prompt: string;
  selectionMode: 'single' | 'multi';
  required?: boolean;
  allowOther?: boolean;
  options: StorageQuestionOption[];
}

interface CanonicalQuestionOption {
  id: string;
  label: string;
  description?: string;
}

interface CanonicalQuestion {
  id: string;
  prompt: string;
  answerMode: 'single_select' | 'multi_select' | 'text';
  required: boolean;
  options?: CanonicalQuestionOption[];
  customAnswer?: {
    enabled: boolean;
    label?: string;
    placeholder?: string;
  };
}

/**
 * Construit les outils `paperclip_ask_user` et `paperclip_request_confirmation`.
 */
export function buildDecisionCardTools(
  options: PaperclipToolsOptions,
  apiInstance?: PaperclipRest,
): WorkspaceTool[] {
  const api = apiInstance ?? new PaperclipRest(options);
  const secrets = [options.apiKey, options.runtimeTools?.bearerToken ?? ''].filter((s) => s.length >= 6);
  const redact = (text: string): string => redactSecrets(text, secrets);

  const issueIdOf = (input: Record<string, unknown>): string => {
    const issueId = optString(input, 'issueId') ?? options.taskId ?? undefined;
    if (!issueId) throw new InputError('« issueId » est requis : aucun ticket courant dans ce run');
    return issueId;
  };

  let interactionCreatedInRun = false;

  const tool = (
    spec: WorkspaceTool['spec'],
    handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): WorkspaceTool => ({
    spec,
    async run(input: unknown): Promise<ToolResult> {
      try {
        const value = await handler(record(input));
        return {
          content: redact(JSON.stringify(value)),
          isError: false,
          waitingForHuman: true,
        };
      } catch (error) {
        return {
          content: redact(describeError(spec.name, error)),
          isError: true,
        };
      }
    },
  });

  return [
    tool(
      {
        name: 'paperclip_ask_user',
        description:
          'Pose une ou plusieurs questions structurées à l’utilisateur via une carte interactive Paperclip. Clôture le tour d’agent et passe le ticket en in_review.',
        input_schema: ASK_USER_TOOL_SCHEMA,
      },
      async (input) => {
        if (interactionCreatedInRun) {
          throw new InputError(
            'Une carte d’interaction a déjà été émise pendant ce run. Une seule interaction par heartbeat est autorisée.',
          );
        }

        const issueId = issueIdOf(input);
        const title = reqString(input, 'title');
        const rawQuestions = input['questions'];
        if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
          throw new InputError('« questions » doit être un tableau non vide (1 à 10 questions)');
        }
        if (rawQuestions.length > 10) {
          throw new InputError('« questions » ne peut pas dépasser 10 questions');
        }

        const questionIds = new Set<string>();
        const storageQuestions: StorageQuestion[] = [];
        const canonicalQuestions: CanonicalQuestion[] = [];

        for (const raw of rawQuestions) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new InputError('Chaque élément de « questions » doit être un objet JSON');
          }
          const q = raw as Record<string, unknown>;
          const qId = optString(q, 'id');
          if (!qId) throw new InputError('Chaque question doit avoir un « id » non vide');
          if (questionIds.has(qId)) {
            throw new InputError(`Identifiant de question dupliqué : « ${qId} »`);
          }
          questionIds.add(qId);

          const prompt = optString(q, 'prompt');
          if (!prompt) throw new InputError(`La question « ${qId} » doit avoir un « prompt » non vide`);

          const rawSelectionMode = optString(q, 'selectionMode');
          const rawAnswerMode = optString(q, 'answerMode');
          const isText = rawAnswerMode === 'text' || (!q['options'] && !rawSelectionMode);
          const isMulti = rawSelectionMode === 'multi' || rawAnswerMode === 'multi_select';
          const selectionMode: 'single' | 'multi' = isMulti ? 'multi' : 'single';
          const required = typeof q['required'] === 'boolean' ? q['required'] : true;

          if (isText) {
            const rawOptions = Array.isArray(q['options']) ? q['options'] : [];
            let freeTextOpt: StorageQuestionOption | null = null;
            if (rawOptions.length > 0 && typeof rawOptions[0] === 'object' && rawOptions[0]) {
              const optRec = rawOptions[0] as Record<string, unknown>;
              const optId = optString(optRec, 'id') || 'paperclip_text_answer';
              const optLabel = optString(optRec, 'label') || 'Réponse libre';
              const optDesc = optString(optRec, 'description');
              freeTextOpt = {
                id: optId,
                label: optLabel,
                ...(optDesc ? { description: optDesc } : {}),
                freeText: true,
              };
            } else {
              freeTextOpt = {
                id: 'paperclip_text_answer',
                label: 'Réponse libre',
                freeText: true,
              };
            }

            storageQuestions.push({
              id: qId,
              prompt,
              selectionMode: 'single',
              required,
              allowOther: true,
              options: [freeTextOpt],
            });

            canonicalQuestions.push({
              id: qId,
              prompt,
              answerMode: 'text',
              required,
            });
          } else {
            const rawOptions = q['options'];
            if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
              throw new InputError(
                `La question « ${qId} » doit comporter des options ou être en texte libre (answerMode: 'text').`,
              );
            }

            const optionIds = new Set<string>();
            const choices: CanonicalQuestionOption[] = [];
            let freeTextOption: StorageQuestionOption | null = null;

            for (const opt of rawOptions) {
              if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
                throw new InputError(`Options invalides pour la question « ${qId} »`);
              }
              const optRec = opt as Record<string, unknown>;
              const optId = optString(optRec, 'id');
              const optLabel = optString(optRec, 'label');
              if (!optId || !optLabel) {
                throw new InputError(`Chaque option de la question « ${qId} » doit comporter « id » et « label »`);
              }
              if (optionIds.has(optId)) {
                throw new InputError(`Identifiant d’option dupliqué « ${optId} » dans la question « ${qId} »`);
              }
              optionIds.add(optId);

              const optDesc = optString(optRec, 'description');
              const isFreeText = optRec['freeText'] === true;

              if (isFreeText) {
                if (freeTextOption) {
                  throw new InputError(`Une question ne peut comporter qu'une seule option freeText (« ${qId} »)`);
                }
                freeTextOption = {
                  id: optId,
                  label: optLabel,
                  ...(optDesc ? { description: optDesc } : {}),
                  freeText: true,
                };
              } else {
                choices.push({
                  id: optId,
                  label: optLabel,
                  ...(optDesc ? { description: optDesc } : {}),
                });
              }
            }

            // Si c'est un pur free-text sous forme d'option unique
            if (choices.length === 0 && freeTextOption) {
              storageQuestions.push({
                id: qId,
                prompt,
                selectionMode: 'single',
                required,
                allowOther: true,
                options: [freeTextOption],
              });
              canonicalQuestions.push({
                id: qId,
                prompt,
                answerMode: 'text',
                required,
              });
              continue;
            }

            // Question à choix : minimum 2 choix
            if (choices.length < 2) {
              throw new InputError(
                `La question « ${qId} » (${selectionMode}) doit proposer au moins 2 options.`,
              );
            }

            const hasCustomAnswer =
              q['customAnswer'] === true ||
              Boolean(q['allowOther']) ||
              (q['customAnswer'] &&
                typeof q['customAnswer'] === 'object' &&
                (q['customAnswer'] as Record<string, unknown>)['enabled'] !== false) ||
              freeTextOption !== null;

            if (hasCustomAnswer && !freeTextOption) {
              let label = 'Autre choix';
              let placeholder: string | undefined = 'Saisir un autre choix...';
              if (q['customAnswer'] && typeof q['customAnswer'] === 'object') {
                const ca = q['customAnswer'] as Record<string, unknown>;
                label = optString(ca, 'label') ?? 'Autre choix';
                placeholder = optString(ca, 'placeholder') ?? 'Saisir un autre choix...';
              }
              freeTextOption = {
                id: 'paperclip_custom_answer',
                label,
                ...(placeholder ? { description: placeholder } : {}),
                freeText: true,
              };
            }

            const allStorageOptions: StorageQuestionOption[] = freeTextOption
              ? [...choices, freeTextOption]
              : choices;

            storageQuestions.push({
              id: qId,
              prompt,
              selectionMode,
              required,
              allowOther: Boolean(hasCustomAnswer),
              options: allStorageOptions,
            });

            canonicalQuestions.push({
              id: qId,
              prompt,
              answerMode: isMulti ? 'multi_select' : 'single_select',
              required,
              options: choices,
              ...(hasCustomAnswer && freeTextOption
                ? { customAnswer: { enabled: true, label: freeTextOption.label } }
                : {}),
            });
          }
        }

        // Garde-fou anti-cumul : vérification préalable des interactions existantes
        const interactionsRes = await api.request('GET', `/issues/${enc(issueId)}/interactions`);
        const list = Array.isArray(interactionsRes.data)
          ? interactionsRes.data
          : Array.isArray((interactionsRes.data as { items?: unknown })?.items)
            ? ((interactionsRes.data as { items: unknown[] }).items)
            : [];
        const existingPending = list.find(
          (item: any) => item && item.kind === 'ask_user_questions' && item.status === 'pending',
        );
        if (existingPending) {
          throw new InputError(
            `Une interaction de type ask_user_questions est déjà en attente sur ce ticket (ID: ${existingPending.id}). Ne créez pas de doublon : attendez la réponse de l'utilisateur.`,
          );
        }

        // Clé d'idempotence
        let idempotencyKey = optString(input, 'idempotencyKey');
        if (!idempotencyKey) {
          const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 32);
          const qHash = createHash('sha256')
            .update(title + ':' + storageQuestions.map((q) => q.id).join(','))
            .digest('hex')
            .slice(0, 10);
          idempotencyKey = `questions:${issueId}:${slug || 'q'}:${qHash}:v1`;
        }

        const interactionPayload = {
          kind: 'ask_user_questions',
          idempotencyKey,
          title,
          resolverPolicy: 'human_only',
          continuationPolicy: 'wake_assignee',
          payload: {
            version: 1,
            title,
            questionSet: {
              schema: 'paperclip.question_set.v1',
              title,
              questions: canonicalQuestions,
            },
            questions: storageQuestions,
          },
        };

        const waitingComment = optString(input, 'comment') || `En attente de réponse sur la carte : "${title}".`;

        let interactionId: string | null = null;
        try {
          const createRes = await api.request('POST', `/issues/${enc(issueId)}/interactions`, {
            body: interactionPayload,
          });
          const createdData = createRes.data as { id?: string } | null;
          interactionId = createdData?.id ?? null;
          if (!interactionId) {
            throw new Error('Identifiant d’interaction manquant dans la réponse Paperclip');
          }

          await api.request('PATCH', `/issues/${enc(issueId)}`, {
            body: {
              status: 'in_review',
              comment: waitingComment,
            },
          });
          interactionCreatedInRun = true;
        } catch (error) {
          if (interactionId) {
            try {
              await api.request('POST', `/issues/${enc(issueId)}/interactions/${enc(interactionId)}/withdraw`, {
                body: { reason: 'Échec de synchronisation de la posture in_review' },
              });
            } catch {
              /* diagnostic silencieux */
            }
          }
          throw error;
        }

        return {
          ok: true,
          interactionId,
          status: 'pending',
          waitingForHuman: true,
          message:
            "Carte de questionnaire publiée sur le board. Ticket passé en 'in_review'. La boucle d'agent va s'arrêter jusqu'à la réponse d'Alexandre.",
        };
      },
    ),

    tool(
      {
        name: 'paperclip_request_confirmation',
        description:
          'Demande une validation formelle binaire (Oui / Non) d’un plan d’action ou document lié au ticket. Clôture le tour d’agent et passe le ticket en in_review.',
        input_schema: REQUEST_CONFIRMATION_TOOL_SCHEMA,
      },
      async (input) => {
        if (interactionCreatedInRun) {
          throw new InputError(
            'Une carte d’interaction a déjà été émise pendant ce run. Une seule interaction par heartbeat est autorisée.',
          );
        }

        const issueId = issueIdOf(input);
        const title = reqString(input, 'title');
        const prompt = reqString(input, 'prompt');
        const targetKey = optString(input, 'targetKey') ?? 'plan';

        let targetRevisionId = optString(input, 'targetRevisionId');
        if (!targetRevisionId) {
          const docRes = await api.request('GET', `/issues/${enc(issueId)}/documents/${enc(targetKey)}`, {
            allow404: true,
          });
          if (docRes.status === 404 || !docRes.data) {
            throw new InputError(
              `Le document '${targetKey}' n'existe pas sur le ticket. Rédigez le plan avec paperclip_write_document avant de demander confirmation.`,
            );
          }
          const docData = docRes.data as { latestRevisionId?: unknown } | null;
          const revId = typeof docData?.latestRevisionId === 'string' ? docData.latestRevisionId.trim() : null;
          if (!revId) {
            throw new InputError(`Le document '${targetKey}' n'a aucune révision disponible.`);
          }
          targetRevisionId = revId;
        }

        // Garde-fou anti-cumul
        const interactionsRes = await api.request('GET', `/issues/${enc(issueId)}/interactions`);
        const list = Array.isArray(interactionsRes.data)
          ? interactionsRes.data
          : Array.isArray((interactionsRes.data as { items?: unknown })?.items)
            ? ((interactionsRes.data as { items: unknown[] }).items)
            : [];
        const existingPending = list.find(
          (item: any) => item && item.kind === 'request_confirmation' && item.status === 'pending',
        );
        if (existingPending) {
          throw new InputError(
            `Une interaction de type request_confirmation est déjà en attente sur ce ticket (ID: ${existingPending.id}). Ne créez pas de doublon : attendez la réponse de l'utilisateur.`,
          );
        }

        let idempotencyKey = optString(input, 'idempotencyKey');
        if (!idempotencyKey) {
          idempotencyKey = `confirmation:${issueId}:${targetKey}:${targetRevisionId}`;
        }

        const acceptLabel = optString(input, 'acceptLabel') ?? 'Valider le plan';
        const rejectLabel = optString(input, 'rejectLabel') ?? 'Demander des modifications';
        const rejectRequiresReason =
          typeof input['rejectRequiresReason'] === 'boolean' ? input['rejectRequiresReason'] : true;
        const detailsMarkdown =
          optString(input, 'detailsMarkdown') ?? `Vérifiez le document **${targetKey}** avant validation.`;

        const interactionPayload = {
          kind: 'request_confirmation',
          idempotencyKey,
          title,
          continuationPolicy: 'wake_assignee',
          payload: {
            version: 1,
            prompt,
            acceptLabel,
            rejectLabel,
            rejectRequiresReason,
            rejectReasonLabel: 'Quelles modifications sont requises ?',
            detailsMarkdown,
            supersedeOnUserComment: true,
            target: {
              type: 'issue_document',
              issueId,
              key: targetKey,
              revisionId: targetRevisionId,
            },
          },
        };

        const waitingComment =
          optString(input, 'comment') || `Plan soumis à validation (${title}). Ticket en attente d'approbation.`;

        let interactionId: string | null = null;
        try {
          const createRes = await api.request('POST', `/issues/${enc(issueId)}/interactions`, {
            body: interactionPayload,
          });
          const createdData = createRes.data as { id?: string } | null;
          interactionId = createdData?.id ?? null;
          if (!interactionId) {
            throw new Error('Identifiant d’interaction manquant dans la réponse Paperclip');
          }

          await api.request('PATCH', `/issues/${enc(issueId)}`, {
            body: {
              status: 'in_review',
              comment: waitingComment,
            },
          });
          interactionCreatedInRun = true;
        } catch (error) {
          if (interactionId) {
            try {
              await api.request('POST', `/issues/${enc(issueId)}/interactions/${enc(interactionId)}/withdraw`, {
                body: { reason: 'Échec de synchronisation de la posture in_review' },
              });
            } catch {
              /* diagnostic silencieux */
            }
          }
          throw error;
        }

        return {
          ok: true,
          interactionId,
          status: 'pending',
          waitingForHuman: true,
          target: { key: targetKey, revisionId: targetRevisionId },
          message:
            "Demande de confirmation enregistrée et liée à la révision du plan. Ticket passé en 'in_review'.",
        };
      },
    ),
  ];
}

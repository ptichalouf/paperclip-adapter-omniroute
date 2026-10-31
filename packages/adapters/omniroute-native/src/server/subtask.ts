/**
 * Lot 20 (A) — outil `subtask` : le modèle principal confie une lecture, une
 * recherche ou une synthèse à un modèle rapide à gros quota (ex. combo
 * `AC-task`), qui rend un compte rendu compact.
 *
 * Pourquoi : les runs mesurés (ACC-2305) passent l'essentiel de leurs tours à
 * lire. Ces tours coûtent le contexte et le quota du modèle fort ; un modèle
 * rapide peut les faire et ne rendre que l'essentiel.
 *
 * Garde-fous :
 * - l'enfant n'a que des outils en LECTURE, choisis par nom dans la liste du
 *   parent (les outils ajoutés plus tard par d'autres lots sont pris s'ils
 *   portent un nom de lecture) ;
 * - pas d'outil `subtask` chez l'enfant (profondeur 1) ;
 * - bornes en tours (`maxTurns`) et en temps (min du délai restant du run et
 *   de `timeoutSec`), annulation du run propagée ;
 * - un échec de l'enfant devient une erreur d'outil, jamais une exception qui
 *   ferait tomber le run.
 */
import type { TranscriptEntry } from '@paperclipai/adapter-utils';

import { OmniRouteError, combineWithDeadline, remainingMs, withDeadline } from '../shared/client.js';
import type { ReasoningEffort } from '../shared/chat-completions.js';
import type { WorkspaceTool } from './tools.js';

export const SUBTASK_TOOL_NAME = 'subtask';

/** Outils de lecture autorisés chez l'enfant (noms exacts). */
export const SUBTASK_READ_ONLY_TOOL_NAMES: readonly string[] = [
  'read_file',
  'list_dir',
  'search',
  'grep',
  'glob',
  'read_skill',
  'read_instructions_file',
];

/** Outils Paperclip de lecture : `paperclip_get_*`, `paperclip_list_*`. */
const READ_ONLY_NAME_PATTERNS: readonly RegExp[] = [/^paperclip_(?:get|list)_[a-z0-9_]+$/];

/** Compte rendu rendu au parent, au-delà on tronque (et on le dit). */
export const SUBTASK_RESULT_MAX_CHARS = 12_000;

/** Sous-tâches lancées en même temps au plus, quand le modèle en demande plusieurs dans un tour. */
export const SUBTASK_MAX_PARALLEL = 4;

export function isSubtaskReadOnlyTool(name: string): boolean {
  return SUBTASK_READ_ONLY_TOOL_NAMES.includes(name) || READ_ONLY_NAME_PATTERNS.some((re) => re.test(name));
}

export interface SubtaskSettings {
  /** Modèle (combo) de l'enfant, ex. `AC-task`. */
  model: string;
  /** Tours modèle ↔ outils de l'enfant (le tour de synthèse finale s'y ajoute). */
  maxTurns: number;
  /** Délai propre d'une sous-tâche, borné par le délai restant du run. */
  timeoutSec: number;
}

/** Détail d'une sous-tâche, publié dans `resultJson.subtasks`. */
export interface SubtaskRecord {
  model: string;
  servedModel: string | null;
  turns: number;
  durationMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number | null;
  ok: boolean;
  error?: string;
}

/** Ce qu'une boucle enfant rend (sous-ensemble du résultat d'une tentative). */
export interface ChildLoopResult {
  finalText: string;
  completion: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  servedModel: string | null;
  costUsd: number | null;
  costTurnsMissing: number;
  error?: unknown;
}

/** Options de la boucle enfant (forme de `AgentLoopOptions`, sans dépendance circulaire). */
export interface ChildLoopOptions {
  model: string;
  system: string;
  initialUserMessage: string;
  history: [];
  tools: WorkspaceTool[];
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
  sessionId?: string;
  maxTurns: number;
  intraRunBudget?: number;
  fallbackModel: null;
  parallelToolCalls?: boolean;
  signal: AbortSignal;
  emit(entry: TranscriptEntry): Promise<void>;
  warn(message: string): Promise<void>;
}

export interface SubtaskToolDeps {
  settings: SubtaskSettings;
  /** Outils du parent : l'enfant en reçoit le sous-ensemble en lecture. */
  parentTools: WorkspaceTool[];
  parent: {
    maxTokens: number;
    reasoningEffort: ReasoningEffort;
    sessionId?: string;
    intraRunBudget?: number;
    parallelToolCalls?: boolean;
    signal?: AbortSignal;
    emit(entry: TranscriptEntry): Promise<void>;
    warn(message: string): Promise<void>;
  };
  /** Lance la boucle enfant (injectée par `agent-loop.ts`). Ne doit pas lever. */
  runChild(options: ChildLoopOptions): Promise<ChildLoopResult>;
  /** Reçoit le détail et l'usage de chaque sous-tâche, pour les compteurs du run. */
  onRecord(record: SubtaskRecord, usage: ChildLoopResult): void;
}

export const SUBTASK_SYSTEM_PROMPT = [
  'Tu es un sous-agent de lecture, appelé par un agent principal qui attend ton compte rendu.',
  'Fais uniquement la tâche demandée, avec les outils de lecture disponibles. Tu ne peux rien modifier ni exécuter.',
  'Sois rapide : va droit aux fichiers et aux passages utiles, ne relis pas ce que tu as déjà lu.',
  'Termine par un compte rendu factuel et compact, en français : ce que tu as trouvé, avec les chemins de fichiers,',
  'numéros de ligne et courts extraits comme preuves ; puis ce que tu n’as pas pu vérifier.',
  'Pas de plan, pas de proposition de suite, pas de décision à la place de l’agent principal.',
].join(' ');

export const SUBTASK_TOOL_DESCRIPTION = [
  'Confie une tâche de LECTURE à un modèle rapide (sous-agent) qui rend un compte rendu factuel et compact',
  '(chemins, numéros de ligne, extraits). À utiliser pour économiser ton contexte et tes tours : lire de longs',
  'fichiers ou plusieurs fichiers, chercher où quelque chose est défini ou utilisé, faire l’inventaire d’un dossier,',
  'résumer un document, un ticket ou des commentaires. Le sous-agent n’a que des outils de lecture.',
  'Ne pas l’utiliser pour écrire, modifier un fichier, exécuter une commande, ni pour la décision ou la réponse',
  'finale : c’est toi qui décides, vérifies et réponds. Donne une consigne précise et autonome (il ne voit pas ta',
  'conversation) ; mets dans `context` ce qu’il doit savoir. Plusieurs sous-tâches indépendantes demandées dans le',
  'même tour s’exécutent en parallèle.',
].join(' ');

/**
 * Construit l'outil `subtask`. L'enfant reçoit les outils de lecture du
 * parent, jamais `subtask` lui-même.
 */
export function buildSubtaskTool(deps: SubtaskToolDeps): WorkspaceTool {
  const childTools = deps.parentTools.filter(
    (tool) => tool.spec.name !== SUBTASK_TOOL_NAME && isSubtaskReadOnlyTool(tool.spec.name),
  );
  let counter = 0;

  return {
    spec: {
      name: SUBTASK_TOOL_NAME,
      description: SUBTASK_TOOL_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Consigne précise et autonome : quoi lire ou chercher, quoi rapporter.' },
          context: { type: 'string', description: 'Contexte utile (facultatif) : dépôt, chemins, ticket, ce qui est déjà su.' },
        },
        required: ['task'],
      },
    },
    async run(input: unknown) {
      counter += 1;
      const index = counter;
      const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const task = typeof record['task'] === 'string' ? record['task'].trim() : '';
      const context = typeof record['context'] === 'string' ? record['context'].trim() : '';
      if (task.length === 0) {
        return { content: 'Sous-tâche refusée : `task` est vide. Donne une consigne précise.', isError: true };
      }

      const { settings, parent } = deps;
      const parentSignal = parent.signal;
      if (parentSignal?.aborted) {
        return { content: 'Sous-tâche non lancée : le run a été annulé ou son délai est dépassé.', isError: true };
      }
      const remaining = parentSignal ? remainingMs(parentSignal) : null;
      const budgetMs = Math.max(1, Math.ceil(Math.min(settings.timeoutSec * 1000, remaining ?? Number.POSITIVE_INFINITY)));
      const deadline = withDeadline(budgetMs);
      const signal = parentSignal ? combineWithDeadline(parentSignal, deadline) : deadline;

      const label = `sous-tâche ${index}`;
      const started = Date.now();
      let result: ChildLoopResult;
      try {
        result = await deps.runChild({
          model: settings.model,
          system: SUBTASK_SYSTEM_PROMPT,
          initialUserMessage: buildSubtaskPrompt(task, context),
          history: [],
          tools: childTools,
          maxTokens: parent.maxTokens,
          // CHOIX: lecture et synthèse n'ont pas besoin d'un raisonnement long ;
          // la vitesse est le but de la sous-tâche.
          reasoningEffort: parent.reasoningEffort === 'none' ? 'none' : 'low',
          sessionId: parent.sessionId ? `${parent.sessionId}:subtask-${index}` : undefined,
          maxTurns: Math.max(1, settings.maxTurns),
          intraRunBudget: parent.intraRunBudget,
          fallbackModel: null,
          parallelToolCalls: parent.parallelToolCalls,
          signal,
          emit: (entry) => parent.emit(prefixEntry(entry, index)),
          warn: (message) => parent.warn(`[${label}] ${message}`),
        });
      } catch (error) {
        // `runChild` ne doit pas lever ; filet de sécurité quand même.
        result = emptyChildResult(error);
      }
      const durationMs = Date.now() - started;

      const ok = !result.error && result.completion === 'completed' && result.finalText.trim().length > 0;
      let failure: string | undefined;
      if (!ok) {
        if (parentSignal?.aborted) failure = 'le run a été annulé ou son délai est dépassé';
        else if (deadline.aborted) failure = `délai de la sous-tâche dépassé (${Math.round(budgetMs / 1000)} s)`;
        else if (result.error) failure = describeError(result.error);
        else failure = `pas de compte rendu final (${result.completion}) après ${result.turns} tour(s)`;
      }

      deps.onRecord(
        {
          model: settings.model,
          servedModel: result.servedModel,
          turns: result.turns,
          durationMs,
          inputTokens: result.inputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheWriteTokens: result.cacheWriteTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          ok,
          ...(failure ? { error: failure } : {}),
        },
        result,
      );

      if (!ok) {
        return {
          content: `Sous-tâche en échec sur « ${settings.model} » : ${failure}. Fais cette lecture toi-même ou relance une sous-tâche plus courte.`,
          isError: true,
        };
      }
      const served = result.servedModel ? `, servi par ${result.servedModel}` : '';
      return {
        content: `Compte rendu de la sous-tâche (modèle « ${settings.model} »${served}, ${result.turns} tour(s)) :\n\n${truncateReport(result.finalText.trim())}`,
        isError: false,
      };
    },
  };
}

export function buildSubtaskPrompt(task: string, context: string): string {
  return context.length > 0 ? `## Tâche\n\n${task}\n\n## Contexte\n\n${context}` : `## Tâche\n\n${task}`;
}

/** Tronque le compte rendu proprement, en le disant. */
export function truncateReport(text: string, max: number = SUBTASK_RESULT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  const kept = lastBreak > max * 0.8 ? cut.slice(0, lastBreak) : cut;
  return `${kept}\n\n[… compte rendu tronqué : ${kept.length} caractères gardés sur ${text.length}.]`;
}

/** Préfixe les entrées de transcript de l'enfant pour les distinguer du parent. */
function prefixEntry(entry: TranscriptEntry, index: number): TranscriptEntry {
  const tag = `sous-tâche ${index}`;
  switch (entry.kind) {
    case 'assistant':
    case 'thinking':
      return { ...entry, text: `[${tag}] ${entry.text}` };
    case 'tool_call':
      return { ...entry, name: `${tag} › ${entry.name}`, ...(entry.toolUseId ? { toolUseId: `sub${index}:${entry.toolUseId}` } : {}) };
    case 'tool_result':
      return { ...entry, toolUseId: `sub${index}:${entry.toolUseId}` };
    default:
      return entry;
  }
}

function describeError(error: unknown): string {
  if (error instanceof OmniRouteError) return `${error.classified.errorCode} — ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function emptyChildResult(error: unknown): ChildLoopResult {
  return {
    finalText: '', completion: 'error', turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, servedModel: null, costUsd: null, costTurnsMissing: 0, error,
  };
}

/** Limiteur de concurrence minimal pour les sous-tâches d'un même tour. */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1;
        task().then(resolve, reject).finally(release);
      };
      if (active < max) start();
      else queue.push(start);
    });
}

/**
 * Contexte d'exécution de test.
 *
 * Les tests de bout en bout ont tous besoin du même contexte : un agent
 * minimal, un signal d'annulation, les hooks du contrat. Le duplication
 * par test fait diverger les tests — celui qui oublie `onProviderStopped`
 * passe au vert alors qu'il prouve moins que les autres.
 */
import { vi } from 'vitest';

export interface TestContextOptions {
  /** Remplace la configuration de l'adaptateur. */
  config?: Record<string, unknown>;
  /** Remplace le contexte Paperclip (workspace, instructions…). */
  context?: Record<string, unknown>;
  /** Remplace le runtime (sessionParams…). */
  runtime?: Record<string, unknown>;
  /** Remplace le signal d'annulation. */
  signal?: AbortSignal;
  /** Journal des sorties du run (pour lire le transcript). */
  logs?: string[];
}

export interface TestContext {
  ctx: Record<string, unknown>;
  controller: AbortController;
  onCancellationReady: ReturnType<typeof vi.fn>;
  onProviderStopped: ReturnType<typeof vi.fn>;
  onDispatch: ReturnType<typeof vi.fn>;
}

/**
 * Construit un contexte d'exécution minimal mais fidèle au contrat.
 *
 * Tous les hooks du contrat sont présents et spies : un test peut donc
 * vérifier qu'ils ont été appelés, et non qu'ils n'ont pas planté.
 */
export function makeTestContext(options: TestContextOptions = {}): TestContext {
  const controller = new AbortController();
  const onCancellationReady = vi.fn(async () => {});
  const onProviderStopped = vi.fn(async () => {});
  const onDispatch = vi.fn();
  const logs = options.logs ?? [];

  const ctx = {
    runId: 'run-test',
    agent: {
      id: 'agent-1',
      companyId: 'company-1',
      name: 'Test',
      adapterType: 'omniroute_native',
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { apiKey: 'sk-test', model: 'auto/best-coding', ...(options.config ?? {}) },
    context: options.context ?? { paperclipWorkspace: { cwd: '/tmp' } },
    signal: options.signal ?? controller.signal,
    onLog: vi.fn(async (_stream: string, text: string) => {
      logs.push(text);
    }),
    onMeta: vi.fn(async () => {}),
    onCancellationReady,
    onProviderStopped,
    onDispatch,
    ...(options.runtime ? { runtime: options.runtime } : {}),
  };

  return { ctx, controller, onCancellationReady, onProviderStopped, onDispatch };
}

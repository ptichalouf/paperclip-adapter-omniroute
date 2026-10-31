import { describe, expect, it, vi } from 'vitest';

import { execute } from '../src/server/execute.js';
import { asOmniRouteContext } from '../src/server/contract.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';

/**
 * Le contrat d'exécution — l'écart entre les types liés et le contrat réel.
 *
 * L'instance lie `adapter-utils@2026.916.1`, dont les types ne déclarent
 * pas `ctx.onProviderStopped` ni `errorFamily: "configuration"`. Le
 * **serveur**, lui, fournit le hook et accepte la famille.
 *
 * Ces tests verrouillent le comportement qui compte :
 *
 * 1. `onProviderStopped` est appelé **après** un run réussi — c'est ce que
 *    le serveur attend pour collecter les instructions persistées ;
 * 2. il n'est **pas** appelé quand le fournisseur n'a jamais démarré ;
 * 3. une erreur de configuration est marquée `configuration`, que le
 *    serveur ne rejoue jamais (seuls `transient_upstream` et
 *    `provider_quota` le sont).
 */
describe('contrat d\'exécution — ce que le serveur fournit, que les types n\'ont pas', () => {
  it('appelle onProviderStopped après un run réussi', async () => {
    const gateway = await startFakeGateway();
    const { ctx, onProviderStopped } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
    });

    try {
      const result = await execute(ctx as never);

      expect(result.exitCode).toBe(0);
      // Le serveur s'en sert pour collecter les instructions persistées :
      // sans cet appel, les instructions de l'agent ne sont pas sauvées.
      expect(onProviderStopped).toHaveBeenCalledOnce();
    } finally {
      await gateway.close();
    }
  });

  it('n\'appelle PAS onProviderStopped quand le fournisseur n\'a jamais démarré', async () => {
    const { ctx, controller, onProviderStopped } = makeTestContext();
    controller.abort();

    const result = await execute(ctx as never);

    expect(result.errorCode).toBe('cancelled');
    expect(onProviderStopped).not.toHaveBeenCalled();
  });

  it('marque une erreur de configuration avec errorFamily configuration', async () => {
    const { ctx } = makeTestContext({
      config: { instructionsFilePath: '/chemin/inexistant/AGENTS.md' },
    });

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('omniroute_instructions_unreadable');
    // Le serveur ne rejoue que `transient_upstream` et `provider_quota` :
    // `configuration` garantit qu'un bundle illisible n'est pas rejoué en
    // boucle.
    expect(result.errorFamily).toBe('configuration');
  });

  it('expose le hook que les types liés ne déclarent pas', () => {
    // Le cast est le point unique de l'extension du contrat : sans lui, le
    // hook serait invisible au typecheck et pourrait disparaître en silence.
    const extended = asOmniRouteContext({
      onProviderStopped: vi.fn(async () => {}),
    } as never);
    expect(typeof extended.onProviderStopped).toBe('function');
  });
});

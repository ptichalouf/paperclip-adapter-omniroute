/**
 * Point d'entrée côté serveur : `createServerAdapter()` est le seul export que
 * le `plugin-loader` de Paperclip exige (il refuse le paquet sans lui).
 *
 * Particularité : OmniRoute est sans état côté fournisseur, il n'y a pas de
 * session de CLI à reprendre. La continuité entre deux runs est donc
 * **matérialisée par l'adaptateur** (historique rejoué, voir
 * `server/session.ts`), et non héritée d'un protocole de session.
 */
import type { AdapterModel } from '@paperclipai/adapter-utils';
import type { OmniRouteServerAdapterModule } from './contract.js';

import { agentConfigurationDoc, models as declaredModels, type } from '../index.js';
import { configSchema } from './config-schema.js';
import { execute } from './execute.js';
import { listModels as discoverModels, listModelsForSchema } from './models.js';
import { listOmniRouteSkills, syncOmniRouteSkills } from './skills.js';
import { testEnvironment } from './test.js';
import { NO_MODEL } from '../shared/config.js';

/** Menus de modèle facultatifs du formulaire (lot 21a) : « aucun » proposé en tête. */
const OPTIONAL_MODEL_FIELDS = new Set(['fallbackModel', 'subtaskModel', 'escalationModel', 'escalationModel2']);

export function createServerAdapter(): OmniRouteServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models: declaredModels as AdapterModel[],
    // Les deux sélecteurs consomment la découverte, pas les six valeurs de
    // secours. Le cache de models.ts évite un appel par champ/formulaire.
    listModels: () => discoverModels(),
    refreshModels: () => discoverModels({ refresh: true }),
    agentConfigurationDoc,
    // Lot 18a : appelé par Paperclip à chaque enregistrement d'agent et à
    // chaque démarrage de run — ne jamais attendre la passerelle plus de
    // SCHEMA_DISCOVERY_BUDGET_MS (catalogue en cache, sinon combos de secours).
    getConfigSchema: async () => {
      const choices = (await listModelsForSchema()).map(({ id, label }) => ({ value: id, label }));
      // Lot 21a — menus facultatifs : « aucun » en tête (le combobox Paperclip
      // ne sait pas revenir à vide).
      const none = { value: NO_MODEL, label: 'aucun — désactivé' };
      return {
        ...configSchema,
        fields: configSchema.fields.map((field) =>
          field.key === 'model'
            ? { ...field, options: choices.map((choice) => ({ ...choice })) }
            : OPTIONAL_MODEL_FIELDS.has(field.key)
              ? { ...field, options: [{ ...none }, ...choices.map((choice) => ({ ...choice }))] }
              : field,
        ),
      };
    },
    // Skills Paperclip : l'agent n'a pas de CLI pour les découvrir, l'adaptateur
    // les monte lui-même et les rend lisibles via l'outil `read_skill`.
    listSkills: listOmniRouteSkills,
    syncSkills: syncOmniRouteSkills,
    // Bundle d'instructions (AGENTS.md) : le serveur en dépose le chemin dans
    // `instructionsFilePath`, l'adaptateur le lit et l'injecte.
    supportsInstructionsBundle: true,
    instructionsPathKey: 'instructionsFilePath',
    // Les outils runtime Paperclip (connections_search / connection_request)
    // sont livrés à l'agent par variables d'environnement, comme pour
    // `claude_local` et `openclaw-gateway`.
    runtimeToolDelivery: 'environment',
    // L'agent peut recevoir le JWT de run et appeler l'API du board : c'est ce
    // qui lui permet de mettre à jour son ticket.
    supportsLocalAgentJwt: true,
    // Autorise le rafraîchissement des outils sans réinitialiser la session de l'agent.
    supportsToolRefreshOnResume: true,
  };
}

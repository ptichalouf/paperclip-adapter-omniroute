# Banc de mesure de l'adaptateur `omniroute_native`

Banc rejoué à chaque version sur une instance de test. Deux parties :

1. **Banc de tâches** (`taches/T*.json`, `lancer.py`) — 9 tâches réalistes, chacune avec un critère de
   réussite vérifié automatiquement (fichier du workspace, commentaire, document, sous-tâche, statut…).
   Même agent de test, même modèle (`AC-pro-coding`), même tâche : **seul l'adaptateur change**.
2. **Banc de cache** (`cache/`) — un préfixe stable d'environ 13 k tokens construit comme le prompt
   système de l'adaptateur, rejoué 3 fois par cas directement sur OmniRoute, pour voir ce qui fait
   servir le cache (combo, ordre du prompt, `X-Session-Id`/`user`, épinglage, format Chat Completions
   ou Anthropic `/v1/messages` avec `cache_control`).

Le code n'a besoin que de Python 3 (bibliothèque standard), de `ssh` vers l'hôte Paperclip et l'hôte
OmniRoute, et du jeton d'authentification (`~/.paperclip/token` ou variable `BANC_TOKEN_FILE`, jamais affiché).

## Tâches

| Id | Tâche | Critère vérifié |
|---|---|---|
| T01 | Question d’avis (organisation synthétique) | commentaire ≥ 800 caractères citant coordinateur et spécialistes ; ticket done/in_review |
| T02 | Lire TASK-1002 et le résumer | commentaire contenant « Prompt v2 » et « cache » ; done |
| T03 | Livrer document + commentaire + statut | document `plan` avec 3 étapes et « vérification » ; commentaire ; done |
| T04 | Créer puis modifier un fichier | `config.json` final = `{"version":2,"nom":"banc","etapes":["lire","ecrire"]}` |
| T05 | Recherche dans des fichiers | `resultat.txt` = les 6 fichiers contenant `ERREUR-7731` |
| T06 | Longue lecture (skill paperclip, 70 Ko) | `reponses.json` : endpoint release, `blockedByIssueIds`, `q`, `in_review` |
| T07 | Créer une sous-tâche | sous-tâche au bon titre, assignée à l'agent, identifiant cité en commentaire |
| T08 | Commande refusée puis contournement légitime | commit local présent, **aucun distant ajouté**, explication en commentaire |
| T09 | Reprise sur commentaire de suivi | 2 réveils, `etape1.txt` = un, `etape2.txt` = deux, done |

Chaque tâche n'écrit que sous `banc/<tag>/` dans le workspace de l'agent de test. Les tickets sont des
enfants de `parentIssueId` du `bench/config.json`, assignés à `agentId` de test seulement. Remplacer tous les UUID d’exemple de la configuration avant usage. T02 attend un ticket de test `TASK-1002` contenant les mots « Prompt v2 » et « cache » ; adapter cette référence à l’instance, sans utiliser de ticket client.

## Rejouer le banc à la prochaine version

```sh
cd <dépôt>                         # racine du dépôt paperclip-adapter-omniroute
E=./evidence/banc-$(date +%Y%m%d)
mkdir -p $E
# 0. sauvegarde exacte de l'agent de test (adapter_type, adapter_config, runtime_config, updated_at)
python3 bench/agent.py sauver --fichier $E/agent-test-avant.json
# 1. omniroute_native (configuration de l'agent telle quelle)
python3 bench/lancer.py run --adaptateur omniroute_native --sortie $E/runs-omniroute_native
# 2. claude_local, même modèle : bascule, un run court de contrôle, puis tout le banc
python3 bench/agent.py basculer --vers claude_local --fichier $E/agent-test-avant.json
python3 bench/lancer.py run --adaptateur claude_local --taches T04 --sortie $E/controle-claude_local
python3 bench/lancer.py run --adaptateur claude_local --sortie $E/runs-claude_local
# 3. restauration à l'identique (TOUJOURS, même en cas d'échec) et preuve
python3 bench/agent.py restaurer --fichier $E/agent-test-avant.json
python3 bench/agent.py diff      --fichier $E/agent-test-avant.json      # doit afficher « DIFF VIDE »
# 4. tableaux
mkdir -p $E/tous && cp $E/runs-*/T*.json $E/tous/ && python3 bench/lancer.py rapport --sortie $E/tous
# 5. banc de cache (≤ 90 appels, ~10 min)
python3 bench/cache/lancer_cache.py --sortie $E/cache
# tests hors ligne du banc
python3 -m unittest discover -s bench -p 'test_*.py'
```

Pour ne comparer qu'une version de l'adaptateur natif à la précédente, l'étape 1 suffit : comparer
`tableau.md` à celui de la mesure de base.

## Ce qui est mesuré par run

Réussite du critère (avec le détail de chaque vérification), statut du ou des runs, réponse finale
publiée (`finalResponse.disposition`), commentaires de l'agent, statut du ticket, tours, durée, tokens
(entrée non servie par le cache, lus en cache, écrits en cache, sortie), part de cache = lus / (entrée + lus),
coût et statut du coût, modèle(s) servi(s) (base Paperclip + journal d'usage OmniRoute sur la fenêtre du
run), nombre de `curl`, refus du garde-fou (`Refusé : sortie du workspace / publication distante / accès
refusé`), erreurs d'outil.

## Garde-fous du banc

- `banc/infra.py` refuse toute écriture API autre que : création de ticket, commentaire de suivi, PATCH de
  l'agent de test.
- `agent.py` refuse de basculer si la configuration de l'agent n'est ni la sauvegarde ni notre dernier
  PATCH (empreinte de `adapter_type` + `adapter_config` + `runtime_config`). `updated_at` ne sert pas de
  témoin : Paperclip le met à jour à chaque fin de run (il vaut `last_heartbeat_at`).
- `lancer.py` s'arrête (BLOQUANT) si cette empreinte change pendant le banc.
- Un run qui dépasse 20 minutes n'est plus attendu (`waveTimeoutSec`), le résultat est marqué ⏱.
- Le banc de cache copie son script dans `/tmp/banc-cache-*.mjs` du conteneur paperclip et le supprime
  à la fin (vérifié et affiché) ; la clé du conteneur n'est jamais affichée.

# Feuille de Route / Roadmap

Feuille de route publique du projet `paperclip-adapter-omniroute` (adaptateur natif OmniRoute pour Paperclip).

---

## Jalons et Versions

###  Version 1.0 — Moteur Natif et Parité Claude Code (Livré — 31/10/2026)
- [x] **Boucle native en processus** : exécution directe dans le serveur Paperclip, sans dépendre d'un CLI tiers.
- [x] **Streaming et surveillance** : SSE Chat Completions avec détection de flux figé et keepalives ignorés.
- [x] **Outils de workspace complets** : `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `list_dir`, `shell`.
- [x] **Garde-fous de sécurité stricts** : confinement au workspace (liens pendants refusés), masquage des secrets, blocage des publications distantes.
- [x] **Outils Paperclip directs** : consultation et mise à jour de tickets, commentaires, livraison, sous-tâches sans appels curl manuels.
- [x] **Sous-tâches légères (`subtask`)** : délégation de lecture/résumé à un modèle rapide (`AC-task` ou local) avec outils en lecture seule.
- [x] **Escalade sur échec objectif** : reprise automatique sur modèle supérieur (`escalationModel`) en cas d'absence de finale ou de boucle bloquée.
- [x] **Menus de sélection ergonomiques** : deux menus déroulants pour l'escalade, option « aucun — désactivé », options secondaires repliées.
- [x] **Optimisation du cache (>92 %)** : en-tête `sdk-cli`, marqueur `cache_control` sur le dernier message, verrou anti-compression.
- [x] **Démarrage instantané** : élimination du téléchargement de 9,3 Mo au lancement du run (temps de démarrage divisé par 4).
- [x] **Tarification exacte** : calcul automatique des coûts réels via le barème officiel OmniRoute (`rate_card`).

---

###  Version 1.1 — Connecteurs MCP et Outils d'Entreprise
- [ ] **Passerelle d'outils MCP (`ctx.runtimeMcp`)** : brancher les profils d'outils liés à l'agent (GitHub, Gitea, Cloudflare, bases de données, hubs MCP) directement dans l'adaptateur via la passerelle d'outils Paperclip (`search_tools` et `run_tool`).
- [ ] **Préservation du cache avec les outils virtuels** : ne pas charger 100 définitions d'outils dans le prompt, utiliser les outils virtuels à la demande pour garder le prompt court.

---

###  Version 1.2 — Interactions Décisionnelles et Cartes du Board
- [ ] **Outil typé `paperclip_ask_user`** : permettre à l'agent de poser un questionnaire ou des choix structurés affichés sous forme de carte interactive sur le tableau de bord Paperclip.
- [ ] **Outil typé `paperclip_request_confirmation`** : faire valider un plan d'action avant exécution, avec mise en attente propre de la tâche (`in_review`).

---

###  Version 1.3 — Optimisation Avancée du Prompt et Contexte Dynamique
- [ ] **Prompt système 100 % invariant** : sortir toutes les métadonnées dynamiques (date, id de run, passation de session) du message système pour garantir une réutilisation de cache de 100 % dès le premier tour.
- [ ] **Contexte dynamique d'après `/v1/models/{id}`** : adapter la fenêtre de mémoire de la session à la taille réelle du modèle (32k pour Qwen local, 200k pour Opus, 1M pour Gemini).

---

###  Version 1.4 — Sous-Tâches Locales et Intégration Upstream
- [ ] **Délégation automatique vers DGX Sparks** : routage par défaut des sous-tâches de lecture et de résumé vers les modèles locaux gratuits (`AC-local-fast`), à coût 0 $.
- [ ] **Intégration amont** : soumission d'une Pull Request officielle sur le dépôt principal [paperclipai/paperclip](https://github.com/paperclipai/paperclip).

---

## Comment contribuer
Les contributions humaines et assistées par des agents IA sont les bienvenues ! Consultez [AGENTS.md](./AGENTS.md) pour les consignes d'architecture et de tests, et [CONTRIBUTING.md](./CONTRIBUTING.md) pour le protocole de soumission de PR.

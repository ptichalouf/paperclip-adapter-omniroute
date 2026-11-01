# Processus d'export et synchronisation Gitea → GitHub

Ce document décrit le protocole d'exportation des modifications depuis le dépôt interne Gitea (`ac-dev-bot/ac-paperclip-adapters`) vers le dépôt public GitHub (`ptichalouf/paperclip-adapter-omniroute`).

---

## 1. Principes et Sécurité (Décision D284)

Le dépôt public GitHub est sous licence MIT et ouvert aux contributions. Aucun secret, identifiant interne ou donnée d'infrastructure privée ne doit être publié.

**Interdictions formelles :**
- Aucune adresse IP privée de réseau local (`192.168.*`, `10.*`).
- Aucun chemin de système de fichiers interne (`/opt/data`, `/mnt/*`).
- Aucun jeton d'instance Paperclip ni secret (`board-token`, clés API, mots de passe).
- Aucun nom de domaine d'infrastructure privée (`ptichalouf.xyz`).
- Aucun identifiant ou nom de client interne.

---

## 2. Étapes du processus d'export

### Étape 1 : Préparation et extraction de la branche
Extraire la branche de travail ou le commit depuis la source interne vers un répertoire de travail isolé.

### Étape 2 : Nettoyage automatique et assainissement
Appliquer les règles d'assainissement :
1. Remplacer toute IP LAN par `http://localhost:20128` ou `127.0.0.1`.
2. Remplacer les chemins internes `/opt/data/...` et `/mnt/...` par des chemins génériques (`~/.paperclip/token`, `/var/lib/paperclip`, etc.) ou des variables d'environnement (`PAPERCLIP_HOST_HOME`, `PAPERCLIP_BACKUP_ROOT`).
3. Remplacer les UUIDs réels de sociétés, projets, objectifs ou agents par des identifiants d'exemple synthétiques (`00000000-0000-0000-0000-000000000001`, `TASK-1001`).
4. Vérifier que la configuration d'exemple (`bench/config.json`) ne contient que des valeurs génériques.

### Étape 3 : Exécution du contrôle anti-fuite
Exécuter le script de validation anti-fuite :

```bash
bash scripts/check-anti-leak.sh
```

Le script contrôle l'absence des motifs sensibles (`192.168.`, `/opt/data`, `ptichalouf.xyz`, `board-token`, `/mnt/` hors fixtures autorisées). Il doit renvoyer un code de sortie 0.

### Étape 4 : Validation locale complète
Vérifier l'intégralité des tests avant tout envoi distant :

```bash
# Vérifications TypeScript et Node
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build
pnpm run test
pnpm --filter @agence/omniroute-native run verify

# Suites de banc et de déploiement hors ligne
python3 -m unittest discover -s bench -q
python3 -m unittest discover -s deploy/tests -q
```

### Étape 5 : Publication et revue
1. Pousser la branche de travail nettoyée sur le dépôt public GitHub.
2. Ouvrir une Pull Request avec la description détaillée et la preuve des tests.
3. Attendre la validation de la CI GitHub Actions (qui exécute automatiquement `scripts/check-anti-leak.sh` et les suites de tests).
4. Soumettre à la revue (`qa_reviewer`) avant toute fusion dans `main`.

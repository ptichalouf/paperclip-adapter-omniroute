# Guide de Contribution

Merci de contribuer au projet `paperclip-adapter-omniroute` !

Ce projet accueille chaleureusement les contributions des développeurs humains ainsi que des **assistants et agents IA de codage** (Claude Code, Cursor, Codex, OpenCode, Hermes, Aider).

---

## Règles d'or

1. **Règle Rouge → Vert (TDD)** : Tout ajout de fonctionnalité ou correction de bug doit être accompagné d'un test automatisé dans `test/` qui prouve le problème avant la correction et valide le comportement attendu après.
2. **Qualité stricte** :
   - `pnpm run typecheck` doit renvoyer 0 erreur TypeScript.
   - `pnpm run build` doit réussir.
   - `pnpm run test` doit passer à 100 %.
3. **Sécurité d'abord** :
   - Aucun secret, mot de passe, token ou clé d'API ne doit être stocké en clair ou transmis dans les journaux/transcripts.
   - Les outils de fichiers doivent respecter rigoureusement le confinement au workspace et refuser tout chemin traversant (`..`) ou lien symbolique vers l'extérieur.

---

## Protocole de Pull Request

1. Créez une branche nommée explicitement :
   - `feat/<nom-de-fonctionnalite>` pour un ajout.
   - `fix/<nom-du-bug>` pour un correctif.
2. Écrivez des messages de commit clairs au format Conventional Commits :
   - `feat(omniroute-native): ...`
   - `fix(omniroute-native): ...`
   - `test(omniroute-native): ...`
3. Ouvrez une Pull Request sur GitHub. La CI GitHub Actions valide automatiquement les types, la compilation et l'ensemble de la suite de tests.

Consultez [AGENTS.md](./AGENTS.md) pour les consignes techniques détaillées.

/**
 * Adaptateur Paperclip pour la passerelle OmniRoute.
 *
 * Ce paquet est un adaptateur *externe* : Paperclip le charge depuis le
 * `adapter-plugin-store` et l'exécute dans son propre processus. Aucune
 * modification du code source de Paperclip n'est nécessaire.
 *
 * Particularité par rapport à `claude_local` : il n'y a **aucun binaire**
 * derrière OmniRoute. La passerelle ne fournit que l'inférence, donc
 * l'adaptateur porte lui-même la boucle modèle ↔ outils
 * (voir `server/agent-loop.ts`) et l'outillage de workspace
 * (`server/tools.ts`). Sans cela il ne serait qu'un relais de chat.
 */
export const type = 'omniroute_native';

/**
 * Export **obligatoire** : le `plugin-loader` de Paperclip refuse le paquet
 * s'il ne trouve pas `createServerAdapter` à la racine de ses exports. Le
 * message d'erreur parle d'un « adaptateur invalide », pas d'un export
 * manquant — d'où ce commentaire.
 */
export { createServerAdapter } from './server/index.js';

export const label = 'OmniRoute natif (OpenAI Chat Completions)';

/**
 * Modèles déclarés, utilisés comme valeur initiale du sélecteur avant tout
 * appel réseau.
 *
 * Seuls des **combos** sont proposés : les `auto/*` d'OmniRoute (la passerelle
 * choisit elle-même le meilleur modèle pour la tâche) et nos combos
 * d'agence `AC-*`. Coder en dur un `claude/…` court-circuiterait la politique
 * de routage — le combo porte le fallback et les quotas, le modèle brut non.
 *
 * Ces identifiants sont **vérifiés présents** sur l'instance de l'agence. La
 * liste réelle (45 combos `auto/*` + 15 combos `AC-*`) arrive par `listModels`
 * et remplace celle-ci dès que la passerelle répond — voir `server/models.ts`.
 */
export const models = [
  { id: 'auto/best-coding', label: 'auto/best-coding' },
  { id: 'auto/best-reasoning', label: 'auto/best-reasoning' },
  { id: 'auto/best-chat', label: 'auto/best-chat' },
  { id: 'AC-main', label: 'AC-main — combo AC-Création' },
  { id: 'AC-pro-coding', label: 'AC-pro-coding — combo AC-Création' },
  { id: 'AC-task', label: 'AC-task — combo AC-Création' },
];

export const agentConfigurationDoc = `# omniroute

Utilisez cet adaptateur quand l'agent doit raisonner via la **passerelle
OmniRoute auto-hébergée** (Unraid) plutôt que via un CLI d'éditeur.

## Quand l'utiliser

- L'entreprise agrège déjà ses fournisseurs derrière OmniRoute et veut que les
  agents Paperclip passent par cette passerelle (observabilité, routage, coût).
- Vous voulez du **routage automatique** : un combo \`auto/*\` laisse la
  passerelle choisir le meilleur modèle disponible au moment de l'appel.
- Vous voulez un adaptateur qui **tourne dans le processus Paperclip** : pas de
  binaire à installer dans l'image, aucun accès à un CLI local.

## Quand ne pas l'utiliser

- Si l'agent doit utiliser les outils natifs d'un CLI d'éditeur (édition
  assistée, hooks du CLI, MCP du CLI) → préférez \`claude_local\`.
- Si la passerelle n'est pas joignable depuis le processus serveur Paperclip :
  cet adaptateur est un client HTTP, il n'a aucun mode dégradé hors-ligne.

## Configuration

- \`baseUrl\` — racine de la passerelle. Défaut :
  \`http://192.168.1.10:20128\` (instance de l'agence). Repli sur
  \`OMNIROUTE_BASE_URL\` puis \`ANTHROPIC_BASE_URL\`.
- \`apiKey\` — clé de la passerelle. Repli sur \`OMNIROUTE_API_KEY\` puis
  \`ANTHROPIC_API_KEY\`. **OmniRoute exige \`Authorization: Bearer\`** : il
  rejette \`x-api-key\` avec un 401, alors que c'est la convention Anthropic.
- \`model\` — identifiant **avec préfixe de fournisseur**
  (\`claude/claude-sonnet-5\`), ou un combo \`auto/*\`. Défaut :
  \`auto/best-coding\`.
- \`fallbackModel\` — modèle de repli si \`model\` est introuvable côté
  passerelle. Sans repli, un modèle inconnu fait échouer le run (explicite
  plutôt que silencieux).
- \`maxTokens\` — plafond de sortie par tour (défaut 8192).
- \`maxTurns\` — nombre maximal d'allers-retours modèle ↔ outils (défaut 0 =
  illimité, comme claude_local ; le run reste borné par \`timeoutSec\`).
- \`reasoningEffort\` — niveau \`reasoning_effort\` (none/low/medium/high, défaut high).
- \`cacheControlPoints\` — JSON \`cache_control_points\` OmniRoute/MiniMax (optionnel).
  Si un fournisseur amont le refuse, l'adaptateur réessaie une fois sans.
- \`timeoutSec\` — délai global du run (défaut 900).
- \`systemPrompt\` — remplace entièrement le prompt système.
- \`promptTemplate\` — remplace le template de prompt utilisateur.

### Sous-tâches (désactivées par défaut)

- \`subtaskModel\` — modèle rapide à gros quota (ex. \`AC-task\`). S'il est
  renseigné, l'agent reçoit l'outil \`subtask\` : il confie une lecture, une
  recherche ou un résumé à ce modèle, qui n'a que des outils de lecture
  (\`read_file\`, \`list_dir\`, \`search\`, \`grep\`, \`glob\`, \`read_skill\`,
  \`paperclip_get_*\`, \`paperclip_list_*\`) et rend un compte rendu compact.
  Pas de sous-tâche dans une sous-tâche. Tokens et coût ajoutés au run, détail
  dans \`resultJson.subtasks\`.
- \`subtaskMaxTurns\` — tours maximum par sous-tâche (défaut 12).
- \`subtaskTimeoutSec\` — délai d'une sous-tâche (défaut 300 s), jamais plus que
  le temps restant du run.

### Escalade (désactivée par défaut)

- \`escalationModel\` puis \`escalationModel2\` — modèles plus forts, dans
  l'ordre (ex. \`AC-code\` puis \`AC-pro-coding\`) ; \`aucun\` = désactivé.
  L'ancien \`escalationModels\` (texte à virgules) reste lu. Si une tentative échoue vraiment
  (pas de réponse finale même après le tour de synthèse, 3 erreurs d'outil
  identiques de suite, erreur du modèle non récupérable après le repli), la
  tâche est reprise avec tout l'historique sur le modèle suivant. Pas
  d'escalade si le run est annulé, s'il reste moins d'une minute, ou si la
  passerelle refuse la clé. Motif dans \`resultJson.escalations\`.
- \`maxEscalations\` — escalades maximum par run (défaut 2 ; 0 = jamais).
  Différent de \`fallbackModel\`, qui ne traite que l'indisponibilité d'un
  modèle pendant un appel.

## Outils exposés au modèle

\`read_file\`, \`write_file\`, \`list_dir\`, \`search\`, \`shell\`.

Tous sont confinés au répertoire de run, refusent les fichiers de secrets
(\`.env\`, clés privées, \`.ssh\`, \`.aws\`…) et **n'exécutent aucun
\`git push\`** : le workspace local est la source de vérité et aucun distant
n'est supposé exister.
`;

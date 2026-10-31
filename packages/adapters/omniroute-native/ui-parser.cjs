"use strict";
/**
 * Parser de transcript pour l'adaptateur OmniRoute.
 *
 * Paperclip extrait ce fichier du paquet et l'évalue dans un Web Worker
 * (`sandboxed-parser-worker.ts`) où `fetch`, `XMLHttpRequest`, `WebSocket`,
 * `importScripts` et consorts sont neutralisés, puis l'appelle via
 * `new Function(...)`. D'où les contraintes de forme, toutes vérifiées contre
 * la source du worker :
 *
 * 1. **Aucun import, aucun require, aucun global.** Le module est évalué avec
 *    `exports` / `module` / `self` / `globalThis` en paramètres ; une
 *    dépendance à `@paperclipai/adapter-utils` ferait échouer le chargement
 *    (le paquet n'est pas résolvable depuis le worker). Tout le contrat est
 *    donc ré-implémenté ici, en ES2020 vanilla, sans type.
 * 2. **`module.exports`** (et non `export`) : le worker lit les exports sur
 *    l'objet `module` qu'il injecte. Un fichier `.cjs` est la forme attendue.
 * 3. **Jamais d'exception.** Une ligne non reconnue est renvoyée telle quelle
 *    en `stdout` ; une ligne JSON malformée ne doit pas casser le flux du
 *    transcript. Un parser qui lève vide l'onglet de sortie du run.
 *
 * Ce que ce parser reçoit : l'adaptateur journalise sur stdout une
 * `TranscriptEntry` sérialisée par ligne (`JSON.stringify(entry)`), et sur
 * stderr des diagnostics préfixés `[omniroute]`. Les entrées JSON sont
 * renvoyées telles quelles après validation du `kind` ; les diagnostics
 * deviennent des entrées `stderr` ; tout le reste retombe en `stdout`.
 */
var ENTRY_KINDS = {
  assistant: true,
  thinking: true,
  user: true,
  tool_call: true,
  tool_result: true,
  init: true,
  result: true,
  stderr: true,
  system: true,
  stdout: true,
  diff: true,
  provider_activity: true,
  workspace_change: true,
  workspace_file_reference: true,
  runtime_request: true,
  run_result: true,
  run_terminal: true,
};
var DIAGNOSTIC_PREFIX = "[omniroute]";
function stripAnsi(text) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}
/**
 * Une entrée n'est acceptée que si son `kind` est connu et si elle est
 * correctement estampillée. Le `ts` de l'adaptateur est conservé : il marque
 * l'instant où le modèle a produit le message, pas celui où Paperclip a lu la
 * ligne — la différence compte pour ordonner un flux en streaming.
 */
function acceptEntry(value, fallbackTs) {
  var record = asRecord(value);
  if (!record) return null;
  var kind = record.kind;
  if (typeof kind !== "string" || !ENTRY_KINDS[kind]) return null;
  if (typeof record.ts === "string" && record.ts.length > 0) return record;
  record.ts = fallbackTs;
  return record;
}
function parseStdoutLine(line, ts) {
  var stripped = stripAnsi(typeof line === "string" ? line : "");
  var trimmed = stripped.trim();
  if (trimmed.length === 0) return [];
  // 1. Entrée structurée émise par l'adaptateur.
  if (trimmed.charAt(0) === "{") {
    var parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      parsed = null;
    }
    var entry = parsed === null ? null : acceptEntry(parsed, ts);
    if (entry) return [entry];
  }
  // 2. Diagnostic `[omniroute] …`. Il arrive sur stderr mais peut aussi
  //    transiter par stdout selon le collecteur : on classe sur le préfixe,
  //    pas sur le canal. Le préfixe est retiré pour ne pas le répéter dans
  //    chaque ligne affichée à l'opérateur.
  if (trimmed.indexOf(DIAGNOSTIC_PREFIX) === 0) {
    return [{
      kind: "stderr",
      ts: ts,
      text: trimmed.slice(DIAGNOSTIC_PREFIX.length).trim(),
    }];
  }
  // 3. Repli : on ne perd jamais une ligne. Une sortie d'outil, une bannière,
  //    un avertissement de la passerelle restent visibles.
  return [{ kind: "stdout", ts: ts, text: stripped }];
}
/**
 * Parser avec état. L'adaptateur n'a pas besoin de mémoire entre deux lignes —
 * chaque entrée est autoportante — mais le worker comme le registry appellent
 * cette fabrique en priorité quand elle existe. On la fournit donc, et on
 * partage volontairement une seule instance de l'état vide entre les appels.
 */
function createStdoutParser() {
  return {
    parseLine: function (line, ts) {
      return parseStdoutLine(line, ts);
    },
  };
}
module.exports = { parseStdoutLine: parseStdoutLine, createStdoutParser: createStdoutParser };

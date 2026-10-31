/**
 * Sonde du VRAI chargeur Paperclip (lot 14) — exécutée DANS le conteneur `paperclip`.
 *
 * Elle importe le code compilé du serveur (`/app/server/dist/adapters/registry.js`
 * et `plugin-loader.js`), exactement comme au démarrage du serveur :
 * `registry.ts` lance `buildExternalAdapters()` à l'import, qui lit
 * `$PAPERCLIP_HOME/adapter-plugins.json` puis importe chaque paquet.
 * La sonde ne touche à rien d'autre : le registre lu est celui du
 * PAPERCLIP_HOME passé en variable (un dossier sous /tmp pour l'essai à blanc).
 *
 * Lancement (depuis /app, mêmes options que le serveur) :
 *   env PAPERCLIP_HOME=/tmp/x/home PROBE_TYPE=omniroute_native \
 *     node --import ./server/node_modules/tsx/dist/loader.mjs /tmp/x/real-loader-probe.mjs
 *
 * Variables :
 *   PROBE_TYPE          type attendu (défaut omniroute_native)
 *   PROBE_EXPECT_DIR    dossier (chemin réel) d'où les modules de l'adaptateur doivent venir
 *   PROBE_FORBID        sous-chaîne interdite dans les chemins résolus (ex. agency-starter)
 *   PROBE_EXPECT_FALLBACK=1  le scénario attend un repli sur `process` (démonstration du risque)
 *   PROBE_CATALOGUE=1   appelle listModels() (GET /v1/models d'OmniRoute, lecture seule)
 *   PROBE_RELOAD_TO     dossier de version : bascule `current` vers lui puis appelle
 *                       reloadExternalAdapter() (même fonction que POST /api/adapters/:type/reload)
 *   PROBE_ALLOW_REAL_HOME=1  autorise un PAPERCLIP_HOME hors /tmp (lecture seule ; jamais
 *                       avec PROBE_RELOAD_TO)
 *
 * Sortie : une ligne `PROBE_RESULT {json}` ; code 0 si toutes les attentes tiennent.
 */
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const type = process.env.PROBE_TYPE || 'omniroute_native';
const home = path.resolve(process.env.PAPERCLIP_HOME || '');
const expectDir = process.env.PROBE_EXPECT_DIR ? fs.realpathSync(process.env.PROBE_EXPECT_DIR) : null;
const forbid = process.env.PROBE_FORBID || null;
const expectFallback = process.env.PROBE_EXPECT_FALLBACK === '1';
const reloadTo = process.env.PROBE_RELOAD_TO || null;

const errors = [];
const result = { type, paperclipHome: home, node: process.version };

if (!process.env.PAPERCLIP_HOME) errors.push('PAPERCLIP_HOME non défini');
const underTmp = home.startsWith('/tmp/');
if (!underTmp && process.env.PROBE_ALLOW_REAL_HOME !== '1') {
  errors.push(`PAPERCLIP_HOME hors /tmp refusé (${home})`);
}
if (reloadTo && !underTmp) errors.push('PROBE_RELOAD_TO interdit hors /tmp');
if (errors.length) {
  console.log(`PROBE_RESULT ${JSON.stringify({ ...result, ok: false, errors })}`);
  process.exit(2);
}

// Relevé de chaque module `file:` résolu (chaîné avant les hooks de tsx).
const resolved = [];
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    if (r?.url?.startsWith('file:')) resolved.push(fileURLToPath(r.url.split('?')[0].split('#')[0]));
    return r;
  },
});
const adapterFiles = (from = 0) => [...new Set(resolved.slice(from))].filter((p) => !p.startsWith('/app/'));

const registry = await import('/app/server/dist/adapters/registry.js');
await registry.waitForExternalAdapters();
const store = JSON.parse(fs.readFileSync(path.join(home, 'adapter-plugins.json'), 'utf8'));
const record = store.find((r) => r.type === type) ?? null;
const active = registry.findActiveServerAdapter(type);
const effective = registry.getServerAdapter(type);
const files = adapterFiles();

result.registryLocalPath = record?.localPath ?? null;
result.registryLocalPathExists = record?.localPath ? fs.existsSync(record.localPath) : null;
result.registryLocalPathReal = record?.localPath && fs.existsSync(record.localPath)
  ? fs.realpathSync(record.localPath) : null;
result.loaded = Boolean(active);
result.effectiveAdapterType = effective?.type ?? null;
result.adapterModuleFiles = files.length;
result.adapterModuleRoots = [...new Set(files.map((f) => f.split('/node_modules/')[0].split('/dist/')[0]))];
result.forbiddenHits = forbid ? files.filter((f) => f.includes(forbid)).length : null;
result.outsideExpectDir = expectDir ? files.filter((f) => !f.startsWith(expectDir + path.sep)).length : null;

if (expectFallback) {
  if (result.loaded || result.effectiveAdapterType !== 'process') {
    errors.push('repli sur `process` attendu mais non observé');
  }
} else {
  if (!result.loaded) errors.push(`${type} non chargé par buildExternalAdapters()`);
  if (result.effectiveAdapterType !== type) {
    errors.push(`getServerAdapter("${type}") renvoie "${result.effectiveAdapterType}"`);
  }
  if (!files.length) errors.push('aucun module de l\'adaptateur relevé');
  if (result.forbiddenHits) errors.push(`${result.forbiddenHits} modules résolus contiennent "${forbid}"`);
  if (result.outsideExpectDir) errors.push(`${result.outsideExpectDir} modules hors de ${expectDir}`);
}

if (!expectFallback && process.env.PROBE_CATALOGUE === '1' && active) {
  const t0 = Date.now();
  try {
    const models = await active.listModels();
    const ids = models.map((m) => m.id);
    result.catalogue = {
      count: ids.length,
      ms: Date.now() - t0,
      hasAcMain: ids.includes('AC-main'),
      autoCombos: ids.filter((id) => id.startsWith('auto/')).length,
      sample: ids.slice(0, 3),
    };
    if (!ids.length) errors.push('catalogue vide');
  } catch (err) {
    errors.push(`listModels() a échoué : ${err?.message ?? err}`);
  }
}

if (reloadTo && !expectFallback) {
  const loader = await import('/app/server/dist/adapters/plugin-loader.js');
  const current = record.localPath;
  const tmpLink = `${current}.tmp-${process.pid}`;
  fs.symlinkSync(path.relative(path.dirname(current), reloadTo), tmpLink);
  fs.renameSync(tmpLink, current); // bascule atomique du lien `current`
  const mark = resolved.length;
  const mod = await loader.reloadExternalAdapter(type);
  registry.unregisterServerAdapter(type);
  registry.registerServerAdapter(mod);
  const after = adapterFiles(mark);
  const target = fs.realpathSync(reloadTo);
  result.reload = {
    to: target,
    type: mod?.type ?? null,
    entryFrom: after.filter((f) => f.endsWith('/dist/index.js')),
    filesUnderTarget: after.filter((f) => f.startsWith(target + path.sep)).length,
    effectiveAfter: registry.getServerAdapter(type)?.type ?? null,
  };
  if (mod?.type !== type) errors.push('reloadExternalAdapter() n\'a pas rendu le bon type');
  if (!result.reload.entryFrom.some((f) => f.startsWith(target + path.sep))) {
    errors.push('le rechargement n\'a pas importé la nouvelle version');
  }
}

result.ok = errors.length === 0;
result.errors = errors;
console.log(`PROBE_RESULT ${JSON.stringify(result)}`);
process.exit(result.ok ? 0 : 1);

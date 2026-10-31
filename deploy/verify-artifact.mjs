#!/usr/bin/env node
/**
 * Porte de qualité de l'artefact autonome `omniroute-native` (lot 14).
 *
 * Usage : node deploy/verify-artifact.mjs [--lock pnpm-lock.yaml | --no-lock] <dossier-du-paquet>
 *
 * Refuse (code ≠ 0) un paquet qui ne se suffit pas à lui-même :
 *   1. un lien symbolique qui sort du dossier du paquet (cas de l'installation
 *      d'origine : `node_modules/@paperclipai/adapter-utils` → node_modules du
 *      dépôt agency-starter) ;
 *   2. un module résolu HORS du dossier du paquet au chargement (Node remonte
 *      les node_modules parents : une dépendance manquante serait masquée par
 *      un node_modules voisin, puis disparaîtrait avec lui) ;
 *   3. les étapes du plugin-loader de Paperclip (plugin-loader.ts :
 *      resolvePackageEntryPoint, import ESM, validateAdapterModule, contrat
 *      `paperclip.adapterUiParser` majeur 1, parseur dans le paquet) ;
 *   4. avec `--lock` : une dépendance de production dont la version installée
 *      n'est pas celle du pnpm-lock.yaml du dépôt.
 *
 * Le traçage (2) utilise `module.registerHooks` (Node ≥ 22.15) : chaque URL
 * `file:` résolue pendant l'import est relevée, puis comparée au chemin réel
 * du paquet.
 */
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXPECTED_TYPE = 'omniroute_native';
const SUPPORTED_PARSER_CONTRACT = '1';

const argv = process.argv.slice(2);
let lockFile = null;
let noLock = false;
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--lock') lockFile = argv[++i];
  else if (argv[i] === '--no-lock') noLock = true;
  else positional.push(argv[i]);
}
if (positional.length !== 1 || (!lockFile && !noLock)) {
  console.error('usage: verify-artifact.mjs (--lock <pnpm-lock.yaml> | --no-lock) <dossier-du-paquet>');
  process.exit(64);
}

const errors = [];
const fail = (msg) => { errors.push(msg); console.log(`  ÉCHEC ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

const packageDir = path.resolve(positional[0]);
if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
  console.error(`package.json absent dans ${packageDir}`);
  process.exit(2);
}
const realRoot = fs.realpathSync(packageDir);
const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);

// ── 1. Liens symboliques ────────────────────────────────────────────────────
let files = 0;
let links = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      links += 1;
      const target = fs.readlinkSync(full);
      let resolved;
      try { resolved = fs.realpathSync(full); } catch { resolved = path.resolve(dir, target); }
      if (path.isAbsolute(target) || !inside(resolved)) {
        fail(`lien qui sort du paquet : ${path.relative(packageDir, full)} -> ${target}`);
      }
    } else if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile()) {
      files += 1;
    }
  }
}
walk(packageDir);
if (!errors.length) ok(`${files} fichiers, ${links} liens symboliques, tous internes au paquet`);

// ── 4. Versions des dépendances de production contre le lockfile ─────────────
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const deps = {};
if (lockFile) {
  const lock = fs.readFileSync(lockFile, 'utf8');
  const nm = path.join(packageDir, 'node_modules');
  const tops = [];
  if (fs.existsSync(nm)) {
    for (const name of fs.readdirSync(nm)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        for (const sub of fs.readdirSync(path.join(nm, name))) tops.push(`${name}/${sub}`);
      } else tops.push(name);
    }
  }
  for (const name of tops) {
    const v = JSON.parse(fs.readFileSync(path.join(nm, name, 'package.json'), 'utf8')).version;
    deps[name] = v;
    const keys = [`\n  ${name}@${v}:`, `\n  '${name}@${v}':`];
    if (!keys.some((k) => lock.includes(k))) fail(`${name}@${v} absent de ${lockFile}`);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!deps[name]) fail(`dépendance de production non embarquée : ${name}`);
  }
  if (!errors.length) ok(`dépendances embarquées conformes au lockfile : ${Object.entries(deps).map(([n, v]) => `${n}@${v}`).join(', ')}`);
}

// ── 3. Étapes du plugin-loader + 2. traçage des résolutions ──────────────────
const resolved = new Set();
if (typeof module.registerHooks !== 'function') {
  fail(`module.registerHooks indisponible (Node ${process.version}) : traçage impossible`);
} else {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const r = nextResolve(specifier, context);
      if (r?.url?.startsWith('file:')) resolved.add(r.url.split('?')[0].split('#')[0]);
      return r;
    },
  });
}

let adapterType = null;
if (!pkg.exports || typeof pkg.exports !== 'object' || !pkg.exports['.']) {
  fail('pas d\'export "." dans package.json');
} else {
  const exp = pkg.exports['.'];
  const entryPoint = typeof exp === 'string' ? exp : (exp.import ?? exp.default ?? 'index.js');
  const modulePath = path.resolve(packageDir, entryPoint);
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    if (typeof mod.createServerAdapter !== 'function') {
      fail('createServerAdapter() non exporté : le plugin-loader rejette le paquet');
    } else {
      const adapter = mod.createServerAdapter();
      adapterType = adapter?.type ?? null;
      if (adapterType !== EXPECTED_TYPE) fail(`type "${adapterType}" au lieu de "${EXPECTED_TYPE}"`);
      else ok(`createServerAdapter().type === "${EXPECTED_TYPE}"`);
    }
  } catch (err) {
    fail(`import de ${entryPoint} impossible : ${err?.message ?? err}`);
  }
}

const outside = [...resolved].map((u) => fileURLToPath(u)).filter((p) => !inside(p));
if (outside.length) {
  for (const p of outside.slice(0, 10)) fail(`module résolu hors du paquet : ${p}`);
} else if (resolved.size) {
  ok(`${resolved.size} modules résolus au chargement, tous dans le paquet`);
}

const parserExp = pkg.exports?.['./ui-parser'];
const contract = pkg.paperclip?.adapterUiParser;
if (!parserExp) fail('pas d\'export "./ui-parser"');
else if (!contract || contract.split('.')[0] !== SUPPORTED_PARSER_CONTRACT) {
  fail(`paperclip.adapterUiParser="${contract}" (majeur ${SUPPORTED_PARSER_CONTRACT} attendu)`);
} else {
  const file = typeof parserExp === 'string' ? parserExp : (parserExp.import ?? parserExp.default);
  const p = path.resolve(packageDir, file);
  if (!p.startsWith(packageDir + path.sep) || !fs.existsSync(p)) fail(`parseur UI introuvable ou hors paquet : ${file}`);
  else ok(`parseur UI ${file} (contrat ${contract})`);
}

const summary = {
  ok: errors.length === 0,
  packageDir,
  type: adapterType,
  files,
  symlinks: links,
  resolvedModules: resolved.size,
  outsideModules: outside.length,
  dependencies: deps,
  errors,
};
console.log(`VERIFY_RESULT ${JSON.stringify(summary)}`);
process.exit(errors.length ? 1 : 0);

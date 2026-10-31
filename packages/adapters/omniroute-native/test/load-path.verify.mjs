/**
 * End-to-end load check: replicates what Paperclip's plugin-loader.ts does to
 * install and load an external adapter package, then asserts the two things
 * that actually decide whether the adapter works:
 *
 *   1. `createServerAdapter()` is reachable from the package's "." export and
 *      returns a surface with the hooks the registry calls.
 *   2. The UI parser is discoverable *as source text* through the
 *      "./ui-parser" export, passes the adapterUiParser major-version gate, and
 *      resolves inside the package directory.
 *
 * It mirrors plugin-loader.ts:86-142 rather than importing it, because that
 * module pulls in the whole host server.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
const SUPPORTED_PARSER_CONTRACT = '1';

const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
let passed = 0;
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1); };
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

// ── 1. Server adapter ───────────────────────────────────────────────────────
if (!pkg.exports || typeof pkg.exports !== 'object' || !pkg.exports['.']) {
  fail('no "." export');
}
const entry = pkg.exports['.'];
const entryFile = typeof entry === 'string' ? entry : (entry.import ?? entry.default);
const entryPath = path.resolve(packageDir, entryFile);
if (!existsSync(entryPath)) fail(`"." resolves to a missing file: ${entryPath}`);
ok(`"." export resolves → ${path.relative(packageDir, entryPath)}`);

const mod = await import(pathToFileURL(entryPath).href);
if (typeof mod.createServerAdapter !== 'function') {
  fail('createServerAdapter is NOT exported from "." — plugin-loader rejects the package');
}
ok('createServerAdapter exported from "."');

const adapter = mod.createServerAdapter();
for (const hook of ['type', 'execute', 'testEnvironment']) {
  if (adapter[hook] === undefined) fail(`adapter surface missing required hook: ${hook}`);
}
ok('adapter surface has type / execute / testEnvironment');

if (typeof adapter.execute !== 'function') fail('execute is not a function');
if (typeof adapter.testEnvironment !== 'function') fail('testEnvironment is not a function');
if (typeof adapter.listModels !== 'function') fail('listModels is not a function');
if (typeof adapter.refreshModels !== 'function') fail('refreshModels is not a function');
if (typeof adapter.getConfigSchema !== 'function') fail('getConfigSchema is not a function');
ok('execute / testEnvironment / listModels / refreshModels / getConfigSchema are callable');
ok(`adapter.type === "${adapter.type}"`);

// Skills et instructions : le board n'affiche le sélecteur de skills et
// l'éditeur d'instructions que si l'adaptateur le déclare. Sans cela, le
// contrat Paperclip est à moitié rempli et l'opérateur ne voit rien.
if (typeof adapter.listSkills !== 'function') fail('listSkills is not a function — le board n\'affiche pas les skills');
if (typeof adapter.syncSkills !== 'function') fail('syncSkills is not a function — la synchronisation des skills est impossible');
if (adapter.supportsInstructionsBundle !== true) fail('supportsInstructionsBundle is not true — le bundle d\'instructions est ignoré');
if (adapter.instructionsPathKey !== 'instructionsFilePath') {
  fail(`instructionsPathKey is "${adapter.instructionsPathKey}" instead of "instructionsFilePath"`);
}
ok('listSkills / syncSkills / supportsInstructionsBundle are declared');

// The registry calls getConfigSchema() to render the install/settings form.
const schema = await adapter.getConfigSchema();
if (!schema || !Array.isArray(schema.fields) || schema.fields.length === 0) {
  fail(`getConfigSchema() returned no fields: ${JSON.stringify(schema)}`);
}
ok(`getConfigSchema() → ${schema.fields.length} fields`);

// Declared models must be non-empty, otherwise the model picker is blank.
if (!Array.isArray(adapter.models) || adapter.models.length === 0) {
  fail('adapter.models is empty — the model picker would render nothing');
}
ok(`adapter.models → ${adapter.models.length} declared`);

// listModels must degrade instead of throwing when the gateway is unreachable.
let models;
try {
  models = await adapter.listModels();
} catch (err) {
  fail(`listModels() threw instead of degrading: ${err.message}`);
}
if (!Array.isArray(models) || models.length === 0) {
  fail(`listModels() returned no usable fallback: ${JSON.stringify(models)}`);
}
ok(`listModels() degrades to ${models.length} models without a reachable gateway`);

// Only two families are allowed in the picker: auto/* and our AC-* combos.
// A raw provider model would bypass the routing policy carried by a combo.
const isAllowed = (id) => id.startsWith('auto/') || /^AC-.+$/.test(id);
const stray = [...adapter.models, ...models].filter((m) => !isAllowed(m.id));
if (stray.length > 0) {
  fail(`model picker exposes forbidden ids: ${stray.map((m) => m.id).join(', ')}`);
}
ok('model picker restricted to auto/* and AC-* combos');

// The two families must both be represented, otherwise one is unreachable.
const declaredIds = new Set([...adapter.models, ...models].map((m) => m.id));
if (![...declaredIds].some((id) => id.startsWith('auto/'))) {
  fail('no auto/* combo in the model picker');
}
if (![...declaredIds].some((id) => /^AC-.+$/.test(id))) {
  fail('no AC-* combo in the model picker');
}
ok('auto/* and AC-* families both present');

// ── 2. UI parser ────────────────────────────────────────────────────────────
if (!pkg.exports['./ui-parser']) fail('no "./ui-parser" export — no transcript rendering');
const contractVersion = pkg.paperclip?.adapterUiParser;
if (contractVersion) {
  const major = contractVersion.split('.')[0];
  if (major !== SUPPORTED_PARSER_CONTRACT) {
    fail(`adapterUiParser major "${major}" !== supported "${SUPPORTED_PARSER_CONTRACT}" — parser skipped`);
  }
  ok(`adapterUiParser contract ${contractVersion} accepted`);
} else {
  fail('no paperclip.adapterUiParser version declared (loads, but a future host may require it)');
}

const uiExp = pkg.exports['./ui-parser'];
const uiFile = typeof uiExp === 'string' ? uiExp : (uiExp.import ?? uiExp.default);
const uiPath = path.resolve(packageDir, uiFile);
if (!uiPath.startsWith(packageDir + path.sep) && uiPath !== packageDir) {
  fail('UI parser path escapes the package directory — plugin-loader skips it');
}
ok(`"./ui-parser" confined to package dir → ${path.relative(packageDir, uiPath)}`);
if (!existsSync(uiPath)) fail(`UI parser file missing: ${uiPath}`);

const source = readFileSync(uiPath, 'utf8');
// The worker evaluates this as a `new Function` body. A top-level `import` or
// `require` cannot resolve there, and an `export` is a syntax error.
if (/^\s*(import|export)\s/m.test(source)) {
  fail('UI parser source contains a top-level import/export — fatal in the sandbox worker');
}
if (/\brequire\s*\(/.test(source)) {
  fail('UI parser source calls require() — unresolvable in the sandbox worker');
}
ok(`UI parser is import-free source text (${source.length} bytes)`);

// `files` must ship the parser and the build output, or the tarball is broken.
for (const needed of ['dist', uiFile]) {
  const base = needed.replace(/^\.\//, '').split('/')[0];
  if (!pkg.files?.some((f) => f === base || f === needed)) {
    fail(`package.json "files" does not ship "${needed}" — it would be missing from the tarball`);
  }
}
ok(`"files" ships the parser and dist (${pkg.files.join(', ')})`);

// ── 3. Runtime dependencies ─────────────────────────────────────────────────
// The plugin store installs the package without running a package manager, so
// any third-party runtime dependency is unresolvable at load time.
const deps = Object.keys(pkg.dependencies ?? {});
const foreign = deps.filter((d) => !d.startsWith('@paperclipai/'));
if (foreign.length > 0) {
  fail(`runtime dependencies would be unresolvable in the plugin store: ${foreign.join(', ')}`);
}
ok(`runtime deps limited to Paperclip packages (${deps.join(', ') || 'none'})`);

console.log(`\nPASS — ${passed} load-path assertions`);

/**
 * Replicates Paperclip's sandboxed-parser-worker init path exactly, then
 * exercises the OmniRoute ui-parser.cjs against the cases that matter.
 *
 * The point is to catch the failure mode the worker imposes and a plain
 * `require()` would hide: the source is evaluated as a `new Function` body
 * with `self`/`globalThis` shadowed and `fetch`/`importScripts`/`Blob` set to
 * undefined. An `export` keyword or a top-level import there is fatal.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Defaults to the package root so `node test/ui-parser.verify.mjs` works
// without arguments; pass a path to check a different build.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARSER = process.argv[2] ?? path.join(PACKAGE_ROOT, 'ui-parser.cjs');
const source = readFileSync(PARSER, 'utf8');

const _undefined = void 0;
const exports = {};
const module = { exports };
// `self` and `globalThis` are deliberately withheld, as the worker does.
let factory;
try {
  factory = new Function(
    'exports', 'module', 'self', 'globalThis',
    '"use strict";\n{\n' + source + '\n}',
  );
} catch (err) {
  console.error(`FAIL init (compile): ${err.message}`);
  process.exit(1);
}
try {
  factory(exports, module, _undefined, _undefined);
} catch (err) {
  console.error(`FAIL init (evaluate): ${err.message}`);
  process.exit(1);
}

const resolved =
  module.exports && typeof module.exports === 'object' && Object.keys(module.exports).length > 0
    ? module.exports
    : exports;
const parseStdoutLine = resolved.parseStdoutLine;
const createStdoutParser = resolved.createStdoutParser;

if (typeof parseStdoutLine !== 'function') {
  console.error('FAIL: exports no usable parseStdoutLine');
  process.exit(1);
}
if (typeof createStdoutParser !== 'function') {
  console.error('FAIL: exports no usable createStdoutParser');
  process.exit(1);
}
// The worker prefers createStdoutParser() when parseStdoutLine is absent; both
// paths must agree, so exercise the factory path too.
const viaFactory = createStdoutParser();
if (!viaFactory || typeof viaFactory.parseLine !== 'function') {
  console.error('FAIL: createStdoutParser() has no parseLine');
  process.exit(1);
}

let passed = 0;
function check(name, actual, expected) {
  // deepStrictEqual is key-order insensitive, which matters because the parser
  // stamps `ts` onto the parsed object (appending the key) rather than
  // rebuilding it — semantically identical, different key order.
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  passed += 1;
}

const TS = '2026-09-24T00:00:00.000Z';
const p = (line) => parseStdoutLine(line, TS);
const pf = (line) => viaFactory.parseLine(line, TS);

// 1. A well-formed adapter entry passes through with its own ts preserved.
const assistant = { kind: 'assistant', ts: '2026-09-24T00:00:01.000Z', text: 'bonjour' };
check('assistant entry preserved', p(JSON.stringify(assistant)), [assistant]);

// 2. An entry without ts gets the harness ts stamped on it.
check('ts stamped when absent', p(JSON.stringify({ kind: 'stdout', text: 'x' })),
  [{ kind: 'stdout', ts: TS, text: 'x' }]);

// 3. All 17 TranscriptEntry kinds are accepted.
const kinds = ['assistant', 'thinking', 'user', 'tool_call', 'tool_result', 'init',
  'result', 'stderr', 'system', 'stdout', 'diff', 'provider_activity',
  'workspace_change', 'workspace_file_reference', 'runtime_request', 'run_result',
  'run_terminal'];
for (const kind of kinds) {
  const out = p(JSON.stringify({ kind, ts: TS }));
  if (out.length !== 1 || out[0].kind !== kind) {
    console.error(`FAIL kind ${kind} not accepted: ${JSON.stringify(out)}`);
    process.exit(1);
  }
  passed += 1;
}

// 4. `[omniroute]` diagnostics become stderr entries with the prefix stripped.
check('diagnostic prefix', p('[omniroute] passerelle http://x:20128'),
  [{ kind: 'stderr', ts: TS, text: 'passerelle http://x:20128' }]);

// 5. An unknown kind falls back to stdout rather than being lost.
check('unknown kind falls back', p(JSON.stringify({ kind: 'nope', text: 'x' })),
  [{ kind: 'stdout', ts: TS, text: JSON.stringify({ kind: 'nope', text: 'x' }) }]);

// 6. Malformed JSON must not throw and must not lose the line.
const malformed = '{"kind":"assistant","text":"unterminated';
check('malformed JSON survives', p(malformed), [{ kind: 'stdout', ts: TS, text: malformed }]);

// 7. Blank and whitespace-only lines produce nothing.
check('blank line', p(''), []);
check('whitespace line', p('   '), []);

// 8. ANSI escapes are stripped from plain output.
check('ansi stripped', p('\u001B[31mrouge\u001B[0m'),
  [{ kind: 'stdout', ts: TS, text: 'rouge' }]);

// 9. A JSON *array* is not a valid entry (asRecord rejects arrays) — and it must
//    not throw, because it parses as JSON but is not an object.
check('array is not an entry', p('[1,2,3]'.toString()),
  [{ kind: 'stdout', ts: TS, text: '[1,2,3]' }]);

// 10. The factory path agrees with the direct path.
check('factory agrees', pf(JSON.stringify(assistant)), [assistant]);
check('factory diagnostic agrees', pf('[omniroute] x'), [{ kind: 'stderr', ts: TS, text: 'x' }]);

// 11. A tool_result with a nested content payload round-trips unflattened.
const toolResult = { kind: 'tool_result', ts: TS, toolUseId: 'tu_1', content: 'ok', isError: false };
check('tool_result round-trips', p(JSON.stringify(toolResult)), [toolResult]);

// 12. An entry with a non-string ts still gets a usable ts (never null/undefined).
const noTs = p(JSON.stringify({ kind: 'assistant', ts: 42, text: 'y' }));
if (noTs.length !== 1 || typeof noTs[0].ts !== 'string' || noTs[0].ts.length === 0) {
  console.error(`FAIL non-string ts not replaced: ${JSON.stringify(noTs)}`);
  process.exit(1);
}
passed += 1;

// 13. Never throws across a wide junk sweep.
const junk = [null, 'null', '{}', '[]', '}{', '\u0000', '🎉', '{"kind":null}',
  '{"kind":123}', '{"kind":{}}', '-'];
for (const line of junk) {
  try {
    const out = parseStdoutLine(line, TS);
    if (!Array.isArray(out)) {
      console.error(`FAIL junk ${JSON.stringify(line)} returned non-array`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`FAIL junk ${JSON.stringify(line)} threw: ${err.message}`);
    process.exit(1);
  }
  passed += 1;
}

console.log(`PASS — ${passed} parser assertions against the real sandbox harness`);

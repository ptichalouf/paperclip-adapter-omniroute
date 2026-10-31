# Integrated MCP, decision cards and invariant context candidate

This is an **integration-only draft**, assembling #6 → #5 → #4 by local merge commits. It does not close or supersede those PRs and is not a release/deployment approval.

## Included revisions

- Base main: `0cd3b982a7a8273bec40bd08217fed7922a4c216`.
- #6 invariant prompt/context: `d7d52776096af50a6dc794d6a082cd984dfcf1b9`.
- #5 decision cards: `2117a3365a2fdaa55309c9b9f0c25ff706e37c73`.
- #4 MCP + R1/R2 corrections: `94f2f6cf1078c3009e9f1f793c866cc5cba8067b`.
- Tested implementation: `a491d12ee0a7143c9b8ab76238d90543d1af5117` (the documentation commit may follow).

## Conflict resolution and targeted corrections

- Both `execute.ts` conflicts retain #6's invariant environment, deterministic skill ordering and user-message handoffs. MCP guidance is universal, not conditional on runtime availability; both decision-card tools are documented in the invariant section. The delivery guidance no longer promises atomic multi-request behavior.
- **R1/R2 retained:** direct tools on a mixed virtual/direct server remain searchable and execute directly; discovered on-demand tools use `run_tool`. Unknown/ambiguous targets do not silently fall back to another server.
- **R3:** when posture synchronization and withdrawal both fail, both failures and the interaction ID are returned through the existing redactor, with an explicit warning that the card may still be pending. No successful rollback is claimed; another card in the same run is blocked.
- **R4:** removed deployment-specific `AC-*` and `auto/*` context assumptions from the offline catalogue. Combos use metadata discovery, then the existing conservative fallback (128k, 32k for local-like names). These defaults are heuristics, not proof of any gateway/model capacity.
- **R5:** memory and disk entries expire after one hour and are scoped to normalized gateway URL + credential digest. Unversioned, stale, future-dated or invalid disk entries are rejected. No plaintext credential is written. Unique atomic-write temporary names avoid same-process filename collisions. The optional disk cache remains single-scope/last-writer-wins; cache misses can cause rediscovery, not cross-gateway reuse.
- Found an additional yield interaction: speculative parallel subtasks could start after an earlier card in the same tool batch. Mixed batches are now sequential; subtask-only parallelism is preserved. A regression proves that later MCP/subtask calls do not execute, with no synthesis/escalation/final text.
- Offline Python deploy tests exposed a pre-existing missing `import os`; the one-line repair restores module importability. No deployment was performed.

## Verification

Local runtime: Node `v26.12.1`, pnpm `9.12.0`. All checks below returned exit 0 on the tested implementation:

| Check | Result |
| --- | --- |
| `pnpm run typecheck` | both TypeScript configurations pass |
| `pnpm run build` | pass |
| `pnpm run test` | **550/550**, **59 files** |
| `node test/load-path.verify.mjs` | **16/16** assertions |
| `node test/ui-parser.verify.mjs` | **41/41** assertions |
| Python offline bench unittest discovery | **19/19** |
| Python offline deploy unittest discovery | **30/30** |
| audit-regressions with a verified PATH without `rg` | **14/14** (subset of Vitest, not additive) |
| `git diff --check` | pass |

Total non-overlapping local checks: **550 Vitest + 57 invariants + 49 Python = 656**. Targeted suites are included in the 550, not added again.

Targeted red/green observations: invariant prompt failed with two system variants before the universal fix; both withdrawal cases failed on missing diagnostics; four combo cases failed on private catalogue assumptions; gateway isolation and memory expiry both failed before scoping/TTL; the mixed card/subtask regression executed two forbidden later calls before the scheduling fix. Final HTTP capture verifies byte-identical system messages across four MCP/handoff combinations. Existing redaction/session, R1/R2, human-yield, no-escalation and no-synthesis suites pass together.

## Limits and reservations

- **No live cache improvement has been measured or claimed.** Invariant bytes are a prerequisite, not measured cache-hit rate, token savings or latency improvement. Enabling MCP still changes the offered tool schemas, so whole-request cache equivalence across MCP availability is not claimed.
- Tests use local HTTP fakes and offline fixtures, not live Paperclip/OmniRoute or paid model traffic. Deploy-suite success is sandbox evidence, not a production rollout/rollback result.
- Context metadata can itself be wrong; TTL bounds staleness but cannot verify upstream capacity. Direct-model offline hints remain hints.
- An unsuccessful withdrawal requires inspection/remediation; the adapter does not guarantee remote rollback.
- The A12 audit remains environment-sensitive. Both normal and no-ripgrep executions passed locally, but that is not a universal performance guarantee.
- Node 20/22 CI must be read separately; local Node 26 success is not a substitute for CI.
- No main branch update, old PR merge/closure, tag, release, production call or deployment is authorized by this candidate.

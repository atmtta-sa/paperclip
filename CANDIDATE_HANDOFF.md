# Managed execution-control candidate

## Scope and status

Local candidate checkpoint on `feat/provider-free-context-regression`.
The Git commit containing this file identifies the Paperclip candidate revision.
Hermes companion revision: `8d102fdd7e865347e3077062ca5efbe6370d0105`.
Hermes worktree: `/home/yoga/.hermes/worktrees/hermes-effective-request-renderer`.
This is source/test evidence, not deployment, historical reconciliation, or provider-canary acceptance.

## Latest local checkpoint — bounded retry and generic continuation admission

Local-only bounded correction is complete. `automatic-successor-settlement.ts` checks the
exact durable issue reservation separately from retry policy. Bounded retry scheduling rereads
the predecessor and reservation within the existing successor transaction. A durable validated
conversation-continuation contract is accepted only as narrow continuation authority; it does
not replace settlement, issue identity, retry bounds, sealing, or duplicate prevention.
Missing or unresolved accounting cannot be replaced by optimistic result JSON.

The corrected fixtures keep consumed settlement and continuation permission distinct. Unsupported
`workspace_validation_failed` and accepted-interaction cases remain fail-closed: a
`providerWorkStarted: false` projection is not a zero-use attestation, so they create no successor,
no retry wakeup, and no workspace quarantine mutation. No usage or attestation was fabricated.

Verification on this checkpoint:
- Exact correction matrix: 3 files passed, 95 tests passed, 0 failed.
- Retained log: `/tmp/bounded-correction-final-95.log`.
- Server TypeScript (`tsc --noEmit`): passed, exit 0. The local Node 22 versus required Node 24
  engine warning remains environmental and did not fail the command.
- `git diff --check`: passed, exit 0.
- No provider or network calls were made.

The bounded settlement/retry correction remains a separate 95-test checkpoint. Final dispatch
settlement/authorization recheck, stale-successor rejection before reservation/adapter launch,
and uncertain-launch replay suppression are now closed by the launch-fencing checkpoint below.
Missing-comment and other successor-creation paths, integrated smoke, provider canary, deployment,
and broader release validation remain separate. No provider call, production-state mutation, commit,
push, merge, or deployment occurred. Branch `feat/provider-free-context-regression` remains dirty
with the broader managed-execution candidate. No Naz testing requested yet.

## Latest local checkpoint — automatic-successor launch fencing

Automatic successors now preserve exact predecessor lineage into both native and legacy budget
admission. The reservation transaction locks and rereads the successor, predecessor, issue identity,
ownership, durable accounting settlement, and affirmative retry/continuation authority before any
reservation or provider-circuit mutation. Denial leaves reservation and circuit state unchanged.

A newly admitted automatic successor receives durable `launch_authorized` state in the same
transaction as its reservation. Final dispatch uses the existing issue-then-run lock order and
atomically consumes only `launch_authorized` as `launching`. Automatic-successor adapter invocation
starts only after that transaction commits; ordinary non-successor dispatch preserves its existing
locked synchronous handoff. Competing controllers, reconstructed controllers, or reservation
replays cannot relaunch a `launching` run. Supersession/cancellation winning first cancels dispatch
without consuming launch authorization or calling the adapter. This establishes at most one
Paperclip launch admission; it does not claim exactly-once external/provider execution.

Self-review found and corrected three blocking issues: pre-commit automatic adapter invocation,
unsafe aggregate durable-evidence values/empty or duplicate provider request identities, and durable
call evidence attributed to a different predecessor run. Each correction was reproduced RED before
the narrow production fix and rerun GREEN. This was implementing-assistant self-review, not an
independent reviewer verdict.

Provider-free verification on this checkpoint:
- Integrated launch/settlement matrix: 6 files passed, 156 tests passed, 0 failed.
- Retained log: `/tmp/successor-launch-fencing-review-final.log`.
- Full Hermes adapter suite: 13 files passed, 162 tests passed, 0 failed.
- Retained adapter log: `/tmp/hermes-adapter-review-final.log`.
- Tests prove no reservation on settlement/authority denial, no circuit mutation, one durable
  reservation on replay denial, no forbidden transition to `launching`, zero adapter calls on
  supersession or uncertain replay, commit-before-launch for automatic successors, safe aggregate
  evidence, and exact predecessor run attribution.
- Server and Hermes adapter TypeScript checks passed. Targeted ESLint did not run because this
  checkout resolved ESLint 6 without a discoverable configuration; no lint PASS is claimed.
- `git diff --check` is rerun as the final gate after this handoff update.
- No schema migration, provider/network call, commit, push, merge, deployment, or release occurred.

The server matrix still emits pre-existing recovery-event duplicate-sequence warnings from
`settleUnrecoverableExecutions`; assertions remain green, but those warnings are not certified by
this slice and should be handled separately. Provider canary and corrected integrated smoke remain
separately authorized boundaries.

## Earlier local checkpoint — positive pre-transport evidence

Consultation step 2 is implemented at component level, not integrated runtime closure.
Hermes schema 34 adds durable run-start and sealed `managed_progress_policy_invalid`
attestations. An existing attempted/completed call prevents zero attestation; sealing
fences later transport and survives restart/repetition. Historical runs receive no
invented attestations. The real progress-preflight path creates/seals this evidence.
The read-only adapter validates exact run attribution and rejects unfinished or
contradictory evidence; `execute.ts` carries it separately from usage and billing.
Paperclip's dedicated acceptance helper feeds the existing settlement owner only for
Hermes, exact completed evidence and no contradictory usage/cause. Valid evidence
permits `released_zero_usage`; absent/wrong-run/conflicting evidence stays uncertain.
No external billing or provider usage is fabricated and production billing rules are unchanged.

Current verification:
- Hermes focused contracts/progress/attribution/recovery/attestation: 52 passed on final formatted tree.
- Full adapter: 159 passed; adapter TypeScript passed.
- New settlement helper: 16 passed; production billing evidence: 9 passed; reservations: 16 passed (41 combined).
- New cause/settlement heartbeat selection: 5 passed, 44 skipped; each new settlement case proves one adapter invocation, one run and one wake.
- Full heartbeat owning file: 48 passed, 1 failed in previously recorded `reopens a nonproductive half-open probe without counting a provider failure` (`provider_circuit_open`). NOT a green full-file gate; left unchanged outside this correction.
- Server TypeScript and both diff checks passed. Targeted Python Ruff lint/format passed.
- Radon unavailable in the worktree environment; new complexity verification NOT executed.
- Real Python SessionDB schema-34 store -> Node adapter reader passed with matching run/attestation IDs; isolated store retained at `/tmp/managed-pretransport-bridge-i_ya65eg`. This is a storage bridge, not a Hermes subprocess/Paperclip integrated canary.

Tests used disposable SQLite/PostgreSQL storage and mocked adapter lifecycle execution.
No provider invocation, shared-runtime mutation, historical recovery, deployment, commit,
push or merge occurred. Branch remains `feat/provider-free-context-regression`, dirty
with related continuation work. Atomic eligible-settlement/independent-retry successor
gating, restart/repetition/concurrent scheduling proof, dispatch recheck and integrated
five-record/matrix acceptance remain OPEN. No Naz testing requested.

## Included implementation

- Adapter admission/result normalization preserves the two modern budget meanings; missing, unknown, or contradictory sources fail closed as `adapter_result_inconsistent`.
- Historical compatibility interprets recorded facts without rewriting run history; ambiguous legacy history remains `legacy_budget_terminal_unclassified`.
- Retry suppression reuses the existing classifier, preserves all three interpretations in the returned result and event, and explains each category consistently.
- Opt-in managed progress-policy transport, structured `no_progress` result, and non-retryable disposition.
- Provider-specific usage takes precedence over legacy context/session counters.
- Reservation settlement states, explicit overrun, identical-replay idempotency, contradictory-replay rejection, and narrowly guarded uncertain-to-authoritative recovery.
- Migration `0287_damp_vin_gonzales.sql` and generated metadata are included in source. No live migration was executed during checkpointing.

## Verification

Latest adapter suite: 57 passed; adapter TypeScript typecheck passed.
Complete reservation suite: 16 passed.
Focused lifecycle/reconciliation selection across two files: 12 passed, 47 skipped.
Selection: `historical budget terminals|execution-input exhaustion|no-progress|historical PHA-7|authoritative telemetry|preserves budget retry-suppression semantics`.
Server typecheck/build and `git diff --check`: passed.
Retry-suppression regression was RED (3 expected failures), then GREEN (3 passed). Each case proves correct derived classification, category-consistent event/reason, no successor run/wake, no adapter invocation, and unchanged persisted errorCode/resultJson/budget_failure_reason in disposable PostgreSQL.
Static added-line scan found no matches for checked secret literals, shell execution, unsafe deserialization, or dynamic SQL patterns; not an independent security-review certification. No delegation or provider-backed reviewer was used.

## Explicit caveats / deferred work

- Earlier full heartbeat file had a failure in `reopens a nonproductive half-open probe without counting a provider failure`; the isolated attempt also encountered `provider_circuit_open`. This checkpoint does not establish the clean-baseline cause or close that failure.
- Focused lifecycle output includes runtime-tool-delivery warnings and `continuation_source_context_missing` from another selected fixture; green assertions do not certify those warning paths. The three dedicated semantic regressions pass without invoking the adapter.
- Typecheck/build emits pnpm/Rust warnings; exit status was zero.
- No complete project-wide CI/full-suite claim is made.
- Hermes expanded storage matrix timed out; details and reported Radon complexity are in its companion handoff.

## Historical reconciliation and live boundary

Inspected historical Hermes database `/home/yoga/.hermes/profiles/paperclipphase8canary/state.db` lacks `provider_call_usage`; absence is not zero usage.
Do not rely on the earlier chat assertion of recovered transport IDs without re-reading and validating the exact source artifact. Do not fabricate an identifier or backfill a ledger to manufacture evidence.
The service correction is local source only. A supported operator mutation path and exact authoritative evidence must be established before named reconciliation is authorized.
No push, merge, restart/deployment, live migration, live reservation mutation, wake, provider call, or COM-269 activity is included.
Next boundary: separately authorize paused disposable-runtime rollout and verify exact committed revisions/schema, then separately authorize named historical reconciliation and exactly one bounded implementation canary if all applicable preconditions are met.
If another demonstrated issue can invalidate safety or interpretation of the next measurement, request bounded consultation before expanding implementation; otherwise defer it.

## Uncommitted bounded-contract correction checkpoint

Branch: `feat/provider-free-context-regression`; related source/tests remain dirty.
This checkpoint is component GREEN, not end-to-end canary closure or deployment approval.

- Extracted production managed-budget evidence verification and added an explicit in-process test-only dependency, refused outside `NODE_ENV=test`. Production synthetic-charge rejection remains intact.
- Added read-only Hermes SQLite recovery from the validated profile and exact execution-run ID. Adapter usage and persisted evidence retain confirmed tokens when terminal output is absent; contradictory totals are flagged, uncertain transport remains incomplete, and ledger monetary amounts are not certified as external billing.
- Production settlement retains uncertainty for incomplete/contradictory durable evidence. A mocked-adapter lifecycle test proves isolated synthetic settlement and zero successors; this is not the real adapter/subprocess canary.
- Companion Hermes work adds run-attributed receipts, transactional managed call sequencing, run-scoped totals, migration leaving historical attribution unknown, and contradictory replay rejection. Latest companion focused contracts: 26 passed; the broader Hermes matrix has not been rerun after attribution edits.
- Current Paperclip evidence: full adapter suite 153 passed; adapter TypeScript check passed; server evidence tests 9 passed; focused heartbeat group 12 passed / 32 skipped; `git diff --check` passed. Existing runtime-tool-delivery, experimental SQLite, and pnpm warnings remain. Server typecheck also passed with a 3 GB Node heap cap; no full server-suite/build claim is made.
- Remaining: integrate real loopback adapter/Hermes execution with central settlement; complete cost/context denial, failure/restart, unknown transport and repeated-terminalization rows; prove transport/ledger/terminal/settlement/successor agreement. Empty ledger evidence does not prove zero transport.
- No new commit, push, merge, deployment, historical recovery, existing-runtime wake or real-provider call is authorized or performed by this checkpoint.

## Integrated smoke attempt — open gate

One explicitly approved synthetic wake was exercised through real heartbeat, real Hermes adapter/subprocess, and disposable PostgreSQL. Attempt failed before transport: `managed_progress_baseline_unavailable`; fixture observed zero POSTs. The reservation remained `retained_missing_telemetry` / `uncertain_requires_reconciliation`, with one failed run plus one unexecuted `scheduled_retry` successor and two wakes. This is a failure, not consultation closure. Evidence: `/home/yoga/.hermes/canaries/provider-free-live-runtime/integrated-smoke-ujtla7d9/proof.json` and `execution.json`.

Harness defect: working-directory dotenv/config discovery selected the old phase8 canary agent-home directory instead of the committed fixture workspace. The resulting synthetic-agent directory at `.../phase8-context-canary/workspaces/ab2f235a-df19-406a-9571-534ddbc47f21` is empty and has not been removed; no shared database wake was invoked. Do not claim complete filesystem isolation for this attempt. Embedded helper creates database `paperclip` inside a uniquely named test cluster, not a uniquely named SQL database; scope reporting must distinguish these.

Harness now explicitly pins PAPERCLIP_HOME/PAPERCLIP_CONFIG, disables working-directory dotenv and schedulers, links a primary committed project workspace, and checks cwd containment before invoking Hermes. These edits have only passed server tsc and diff checks, not a second runtime attempt. Added opt-in `server/src/__tests__/managed-contract-smoke.test.ts` and external `integrated_smoke.py`.

Measured retry gap remains: conversation-continuation policy bypasses legacy reconciliation protection while reservation accounting is uncertain. Add a focused provider-free regression and enforce authoritative reservation settlement at retry admission; do not redesign adjacent exception handling or pretend missing usage is zero. No second smoke/provider attempt authorized or executed. No deployment, commit, push, or merge.

## Consultation follow-up — terminal-cause separation

Bounded correction remains the verdict. The retained artifact shows reservation `fa06b7d8-796d-4b8a-ba4d-5d80d41dd50f` becoming uncertain before successor `a2d032da-0666-4437-8879-2fa244c1bea4` was created for predecessor `5b28b8d3-d93b-4759-bdff-e4089e79d616`. No successor dispatch is proven.

Source inventory includes bounded scheduling, missing-comment successor creation, wake-created continuations, scheduled promotion, queued claims and executeRun. Existing retry insertion has locking/deduplication; strengthen that transaction rather than adding a parallel scheduler. Full mediation and concurrency review remain pending before a scheduling fix.

First ordered correction implemented in heartbeat.ts: preserve adapter execution error/cause while recording uncertain accounting separately as resultJson.budgetSettlement, including accountingErrorCode=telemetry_missing. Recognize the supplied Hermes managed_progress_policy_invalid terminal reason when adapter errorCode is absent; this is expressly not positive zero-transport evidence. Missing actual usage remains null, and the reservation remains uncertain. No historical rows are rewritten.

TDD evidence: two new cases failed first because telemetry_missing overwrote the original cause/message, then passed. Focused group: 14 passed / 32 skipped. Owning heartbeat file: 46 passed. Evidence boundary: 9 passed. Reservations: 16 passed. Server direct tsc and git diff --check passed. Runs used mocked adapters and disposable PostgreSQL with cwd dotenv disabled and explicit isolated config/home overrides; no Hermes/provider invocation or second integrated smoke occurred. Runtime-tool, pnpm and experimental SQLite warnings remain. The historically failing circuit probe passed in this full-file run; no unrelated circuit repair or root-cause resolution is claimed.

Files touched for this step: server/src/services/heartbeat.ts, server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts and this handoff. Branch feat/provider-free-context-regression remains dirty and relevant. No commit/push/merge/deployment authorized or performed.

Next ordered work: positive durable run-scoped pre-transport attestation; atomic settlement plus independent retry-disposition enforcement for successor creation; dispatch recheck rejecting stale successors before any new reservation/adapter launch. Then separately approve and rerun the corrected smoke. Consultation closure and the remaining provider-free matrix are still open.

## Local operator recovery follow-up (source checkpoint, not deployed)

Base candidate: `98b20ac0a819305496de478459053ad0850ab268`; branch remains `feat/provider-free-context-regression`.

Added `POST /api/companies/:companyId/budgets/autonomous-reservations/:runId/recover` through a separate route module mounted by costRoutes. It requires Board plus company write access, strict bounded telemetry, usage/billing SHA-256 evidence identifiers, billing basis, and explicit operator attestation. Subscription-included incremental cost must be zero. Hashes identify the reviewed evidence; the route does not retrieve or independently verify source artifacts or subscription billing statements. No credentials or raw provider content belong in its payload.

Only terminal runs and uncertain reservations may recover; already reconciled reservations use existing identical-replay/conflict rules. Company/run/agent/issue/provider/model boundaries are checked before settlement. Existing reconciliation semantics remain unchanged. Settlement and durable audit are atomic; activity publication happens after commit. No historical run fields, pauses, agent states, wakes, or retries are changed.

Files: `server/src/routes/autonomous-budget-recovery.ts`, its two-line mount in `server/src/routes/costs.ts`, `server/src/__tests__/autonomous-budget-recovery-route.test.ts`, and this handoff.

Evidence: initial 18 HTTP cases failed with expected 404 before implementation. Final combined recovery/reservation/cost-route invocation passed all 57 tests (three files) using disposable PostgreSQL. Additional cases prove missing/foreign-run non-disclosure and rollback on a forced real database audit failure. Server `pnpm typecheck`, direct `pnpm exec tsc --noEmit`, and `git diff --check` passed. Existing pnpm, experimental SQLite, and Rust build warnings remain; no full-suite/independent-review claim.

Pre-commit source review was performed by the implementing assistant, without delegation or provider-backed review; it is not independent certification. The commit containing this follow-up identifies its source checkpoint. No deployment, live recovery, provider call, wake, retry, push, or merge is included. Historical billing/source artifacts still need an operator-reviewed evidence bundle and exact named authorization before invocation. Next: obtain separate paused-runtime rollout and named historical-recovery authorization. Provider canary approval remains separate.

## Local checkpoint — provider-neutral settlement contract v3

Branch `fix/provider-neutral-settlement-v3` now supports authoritative contract-v3
`subscription_included` settlement when runtime is unavailable by route. The accepted shape requires
`providerRuntimeMs: null`, `runtimeBasis: null`, and
`runtimeApplicability: "unavailable_by_route"`; mixed measured/unavailable call evidence fails closed.
Contract-v3 metered evidence remains strict for measured provider runtime, provider-authoritative cost,
charge applicability, USD monetary consistency, and `provider_reported_tokens_v1`. Contract v1/v2
behavior remains strict and backward compatible.

Subscription reservations may persist null monetary fields without fabricating per-request cost.
Metered reservations require non-null monetary values at both schema and migration boundaries.
Heartbeat settlement uses the persisted admitted billing mode, provider, and model. Reservation replay
fails before adapter dispatch when billing policy, route-policy binding, provider, or model drifts.
Automatic-successor settlement preserves the same evidence and binding constraints.

Final provider-free verification after the last edit:
- Affected server matrix: 5 files, 133 tests passed, 0 failed.
- Hermes adapter canonical suite: 13 files, 190 tests passed, 0 failed; adapter typecheck passed.
- Canonical server typecheck, runner protocol/capability/semantic/traceability/build gates: passed.
- DB typecheck, build, migration numbering, and migration safety checks: passed.
- Provider/model routing-drift regressions: 2 passed and prove no second adapter invocation.
- `git diff --check`: passed; normal and EOL-ignored diff stats agree.
- Independent composite review concluded with `NARROW_VERDICT: PASS` for the final routing-binding
  remediation; earlier reviewed adapter evidence, settlement, and migration/schema areas had no
  remaining concrete blocker.

Environment caveat: this host has Node 22.22.2 while the monorepo declares Node >=24.11.0.
Canonical package tests/typechecks passed with engine warnings. The top-level `hermes verify --json`
bootstrap is not claimed green because it requires the newer Node runtime and previously interrupted
workspace dependency links; those links were restored from the unchanged lockfile.

This checkpoint used disposable/local fixtures only. No provider invocation, external mutation, live
migration, scheduler change, wake, deployment, push, or merge occurred. Continuity UAT should begin
from the committed revision containing this section, first with provider-free replay/settlement fixtures
and then, only under a separately named approval, with a disposable live-provider canary. Production
rollout and historical reconciliation remain separate authorization boundaries.

## Online continuity canary — PASS

A disposable post-commit real-provider continuity canary passed through actual Paperclip orchestration
and Hermes commit `83963838b5` using `openai-codex` / `gpt-5.6-sol`. One manual initial wake produced
exactly two successful logical runs and one automatic successor. Run
`44db8f04-972b-4e1f-adfb-f1c8b6710847` completed `alpha`; run
`a20183ec-c0c1-4399-a73e-5e22f672dcd0` completed `beta`. Each run made three confirmed provider
requests, within the approved maximum of four per run. Both contract-v3 reservations reconciled with
`subscription_included`, null per-request monetary cost, and
`runtimeApplicability: "unavailable_by_route"`. Session continuity persisted; there were no retries,
extra descendants, duplicate run markers, or orphan canary processes.

The final adapter compatibility correction requires the real Hermes row-level non-monetary authority
tuple (`subscription_included`, `subscription_route_policy`, and exact
`<policyId>:<policyVersion>:<policyDigest>`) while keeping monetary fields null and rejecting policy
reference drift. Verification after that correction: focused reader 32/32, full Hermes adapter
191/191 plus typecheck, actual captured writer-database read complete with two confirmed responses,
provider-free two-run continuity 1/1, focused Paperclip reconciliation 107/107, and independent
`NARROW_VERDICT: PASS`.

Durable proof:
`/home/yoga/.hermes/canaries/provider-neutral-settlement-v3-live-20261010-1/proof.json`.
Output digests:
- alpha: `dc2c84eddfeb275e1b29e28e49f3b9455531869abf9189d227b9ef7989f02950`
- beta: `93861dbc1638a10f4756f3c8cb13178244585560c0bd470b8f7351cc53042de6`

No deployment, push, merge, shared migration, shared scheduler mutation, historical reconciliation, or
production/customer-data mutation occurred. The Paperclip reader correction and regression are committed
at `6166c7461`; the matching Hermes runtime/evidence changes and regressions are committed at
`83963838b5`. Both commits remain local pending separate push/merge authorization.

# Managed execution-control candidate

## Scope and status

Local candidate checkpoint on `feat/provider-free-context-regression`.
The Git commit containing this file identifies the Paperclip candidate revision.
Hermes companion revision: `8d102fdd7e865347e3077062ca5efbe6370d0105`.
Hermes worktree: `/home/yoga/.hermes/worktrees/hermes-effective-request-renderer`.
This is source/test evidence, not deployment, historical reconciliation, or provider-canary acceptance.

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

## Local operator recovery follow-up (source checkpoint)

Base candidate: `98b20ac0a819305496de478459053ad0850ab268`; branch remains `feat/provider-free-context-regression`.

Added `POST /api/companies/:companyId/budgets/autonomous-reservations/:runId/recover` through a separate route module mounted by costRoutes. It requires Board plus company write access, strict bounded telemetry, usage/billing SHA-256 evidence identifiers, billing basis, and explicit operator attestation. Subscription-included incremental cost must be zero. Hashes identify the reviewed evidence; the route does not retrieve or independently verify source artifacts or subscription billing statements. No credentials or raw provider content belong in its payload.

Only terminal runs and uncertain reservations may recover; already reconciled reservations use existing identical-replay/conflict rules. Company/run/agent/issue/provider/model boundaries are checked before settlement. Existing reconciliation semantics remain unchanged. Settlement and durable audit are atomic; activity publication happens after commit. No historical run fields, pauses, agent states, wakes, or retries are changed.

Files: `server/src/routes/autonomous-budget-recovery.ts`, its two-line mount in `server/src/routes/costs.ts`, `server/src/__tests__/autonomous-budget-recovery-route.test.ts`, and this handoff.

Evidence: initial 18 HTTP cases failed with expected 404 before implementation. Final combined recovery/reservation/cost-route invocation passed all 57 tests (three files) using disposable PostgreSQL. Additional cases prove missing/foreign-run non-disclosure and rollback on a forced real database audit failure. Server `pnpm typecheck`, direct `pnpm exec tsc --noEmit`, and `git diff --check` passed. Existing pnpm, experimental SQLite, and Rust build warnings remain; no full-suite/independent-review claim.

Pre-commit source review was performed by the implementing assistant, without delegation or provider-backed review; it is not independent certification. The commit containing this follow-up identifies its source checkpoint. No deployment, live recovery, provider call, wake, retry, push, or merge is included. Historical billing/source artifacts still need an operator-reviewed evidence bundle and exact named authorization before invocation. Next: obtain separate paused-runtime rollout and named historical-recovery authorization. Provider canary approval remains separate.

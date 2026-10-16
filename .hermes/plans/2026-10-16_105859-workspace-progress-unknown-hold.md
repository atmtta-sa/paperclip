# Workspace Progress Unknown Hold Implementation Plan

> **For Hermes:** Implement this plan task-by-task with TDD. Do not resume COM-289 or invoke a provider until every provider-free gate and independent review passes.

**Goal:** Prevent incomplete workspace measurement from being misclassified as `no_progress`, while preserving bounded execution, conservative budget accounting, and pre-materialization successor denial.

**Architecture:** Keep the correction at the existing evidence-to-continuity seam. `workspace-material-progress.ts` remains the trusted bounded collector; `issue-continuity-state.ts` receives a tri-state workspace assessment instead of a boolean; `heartbeat.ts` persists a distinct `progress_unknown` outcome and denies automatic continuation under the existing locked successor-intent transaction. No new progress framework, automatic provider retry, budget increase, or historical rewrite is introduced.

**Tech stack:** TypeScript, Vitest, Drizzle/PostgreSQL integration fixtures, Git worktree snapshots.

---

## Scope lock

In scope:

1. Exclude common untracked dependency/build/cache trees from bounded snapshots even when a repository has not yet added matching `.gitignore` entries.
2. Persist bounded, non-content snapshot diagnostics sufficient to explain resource-limit failures.
3. Carry `confirmed_changed`, `confirmed_unchanged`, or `unknown` into terminal continuity classification.
4. Preserve the no-progress streak on `unknown` and block automatic successor materialization with a distinct reason and durable task hold.
5. Prove classifier-to-intent agreement, restart/replay idempotency, and zero provider/wake/run side effects.

Explicitly out of scope:

- changing the 4-request run allowance, 3-attempt generation allowance, 12-request root allowance, or 12-run issue/assignee ceiling;
- releasing uncertain reservations or changing usage reconciliation;
- one-time RED/GREEN/build receipt authority;
- generalized acceptance-criterion tracking;
- redesigning execution-continuation/checkpoint schemas;
- automatic provider-backed retries for measurement repair;
- historical row rewrites;
- COM-289 resume, COM-290 handoff, push, merge, or public deployment.

Checkpoint work remains deferred unless a separate trace proves that the successor lacked durable evidence already present in `executionContinuation`, `continuationSummary`, or its task-state capsule. COM-289 proves repetition occurred, not that missing prompt context caused it.

## Confirmed source path

- Baseline capture: `server/src/services/heartbeat.ts:24671-24686`
- Terminal capture/receipt: `server/src/services/heartbeat.ts:25590-25655`
- Boolean evidence collapse: `server/src/services/heartbeat.ts:25618-25622`, then `25782-25787`
- Terminal classifier adapter: `server/src/services/heartbeat.ts:12747-12815`, `12915-12969`
- Classifier: `server/src/services/issue-continuity-state.ts:116-200`
- Automatic-successor denial transaction: `server/src/services/heartbeat.ts:13600-13624`
- Snapshot collector: `server/src/services/workspace-material-progress.ts:46-114`
- Durable run outcome type: `packages/db/src/schema/heartbeat_runs.ts:93-101`

The defect is explicit: any workspace result other than verified changed becomes `verifiedWorkspaceProgress = false`; a successful run with unchanged issue fingerprint then falls through to `no_progress` and increments the streak.

---

### Task 1: Bound untracked snapshot traversal and expose safe diagnostics

**Objective:** Prevent `node_modules`, `.venv`, `dist`, caches, and similar untracked generated trees from exhausting the snapshot before task files are measured, and explain any remaining limit failure without persisting file contents.

**Files:**

- Modify: `server/src/services/workspace-material-progress.ts`
- Modify tests: `server/src/services/workspace-material-progress.test.ts`

**Design:**

Extend `WorkspaceMaterialSnapshot` so `unknown` may carry a bounded diagnostics object:

```ts
type WorkspaceSnapshotDiagnostics = {
  phase: "git_diff" | "untracked_list" | "untracked_content" | "git_command";
  maxFiles: number;
  maxBytes: number;
  filesObserved?: number;
  bytesObserved?: number;
  excludedPathCount?: number;
  topPathPrefixes?: string[]; // bounded count, names only
};
```

Use Git pathspec exclusions on the untracked-file command so exclusion happens before output reaches `maxBuffer`. Keep `--exclude-standard`; additionally exclude only established generated/dependency/cache directories, such as:

```ts
const UNTRACKED_GENERATED_PATHS = [
  "**/node_modules/**",
  "**/.venv/**",
  "**/venv/**",
  "**/dist/**",
  "**/build/**",
  "**/.cache/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
];
```

Do not exclude tracked paths from `git diff HEAD`; tracked generated content remains part of repository state. Keep the existing workspace-bound path resolution and symlink non-traversal behavior.

**TDD steps:**

1. Add a RED test with more than `maxFiles` under untracked `node_modules/` plus one untracked `src/new.ts`; expect a verified snapshot and digest change for `src/new.ts`.
2. Add a RED test with relevant untracked files exceeding `maxFiles`; expect `unknown/resource_limit` with bounded diagnostics and no file content.
3. Add a RED byte-limit test; expect `phase=untracked_content`, observed/max bytes, and no digest.
4. Add symlink/path-boundary coverage proving the collector hashes the symlink target text without traversing outside the worktree.
5. Implement the minimal pathspec exclusions and diagnostics.
6. Run:

```bash
pnpm --filter @paperclipai/server exec vitest run src/services/workspace-material-progress.test.ts
```

Expected: all collector tests pass.

**Do not:** add a second post-run-only Git evidence system. The existing before/after collector is already the correct authority once it is bounded correctly.

---

### Task 2: Replace boolean progress with a tri-state terminal assessment

**Objective:** Make incomplete measurement neither progress nor no progress.

**Files:**

- Modify: `server/src/services/issue-continuity-state.ts`
- Modify: `server/src/services/issue-continuity-state.test.ts`
- Modify type only: `packages/db/src/schema/heartbeat_runs.ts`

**Design:**

Add:

```ts
export type WorkspaceProgressAssessment =
  | "confirmed_changed"
  | "confirmed_unchanged"
  | "unknown";
```

Replace `verifiedWorkspaceProgress?: boolean` with `workspaceProgressAssessment?: WorkspaceProgressAssessment`.

Add `"progress_unknown"` to `IssueContinuityWorkOutcome` and the Drizzle text-column TypeScript union. No database migration is required because `work_outcome` is already text.

Classifier precedence:

1. Existing forced outcomes retain current semantics.
2. Cancelled/non-succeeded behavior remains unchanged.
3. Supported issue completion/task-state transition keeps existing precedence.
4. `confirmed_changed`, with required provider/visible-response evidence, returns `productive` and resets the streak.
5. `unknown` returns:

```ts
{
  workOutcome: "progress_unknown",
  noProgressStreak: previousNoProgressStreak,
  circuitState: "open",
  openedNow: true, // only when the prior circuit was not already open
}
```

6. `confirmed_unchanged` follows existing no-progress behavior.

Preserve a prior streak across `progress_unknown` when the issue fingerprint is unchanged, so a future provider-free evidence repair does not erase historical no-progress evidence. An authorized human resume may reset the streak only when a new provider-backed run is actually authorized, as today.

**TDD steps:**

1. Add a RED table test for changed, unchanged, and unknown.
2. Assert unknown preserves streak values `0`, `1`, and `2` exactly.
3. Assert unknown opens/holds the circuit without returning `no_progress`.
4. Assert human resume does not convert unknown evidence into progress.
5. Assert existing confirmed unchanged behavior still opens on the third real no-progress result.
6. Implement the minimal type and classifier changes.
7. Run:

```bash
pnpm --filter @paperclipai/server exec vitest run src/services/issue-continuity-state.test.ts
```

Expected: all continuity-state tests pass.

---

### Task 3: Propagate tri-state evidence through heartbeat finalization

**Objective:** Persist an honest terminal receipt and classify it without collapsing unknown to false.

**Files:**

- Modify: `server/src/services/heartbeat.ts`
- Extend tests: `server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts`

**Design:**

Extract a small pure helper near the collector or terminal classification boundary:

```ts
function workspaceProgressAssessment(
  before: WorkspaceMaterialSnapshot,
  after: WorkspaceMaterialSnapshot,
  replayed: boolean,
): WorkspaceProgressAssessment
```

Mapping:

- either snapshot unknown → `unknown`;
- equal verified digests → `confirmed_unchanged`;
- changed but replayed terminal digest → `confirmed_unchanged` for successor authority;
- distinct non-replayed verified digests → `confirmed_changed`.

Keep the existing persisted `workspaceMaterialProgress` receipt, but ensure:

- `status="unknown"` never persists `changed=false` as if unchanged were proven; use `changed=null` or omit it;
- diagnostics are copied only from the trusted server snapshot result;
- before/after digests remain null when unavailable;
- `isVerifiedWorkspaceMaterialProgressReceipt()` continues accepting only exact server-sourced changed evidence.

Change these function parameters from boolean to tri-state:

- `issueContinuityTerminalPatch()`
- `setRunStatusIfRunning()` terminal evidence
- `setRunStatusFromLive()` terminal evidence
- the final call at `heartbeat.ts:25782-25787`

Update previous-streak lookup to accept a prior `progress_unknown` row while preserving its stored streak when `stateFingerprintAfter` still matches.

**TDD steps:**

1. Add a RED heartbeat fixture where baseline capture is unknown and terminal capture is verified; assert persisted `workOutcome=progress_unknown`, unchanged streak, and distinct receipt reason.
2. Add the inverse terminal-unknown case.
3. Add duplicate terminalization/restart replay; assert the same terminal outcome and no double streak mutation.
4. Retain existing changed-digest and replayed-digest tests.
5. Implement the minimal propagation changes.
6. Run:

```bash
pnpm --filter @paperclipai/server exec vitest run \
  src/services/workspace-material-progress.test.ts \
  src/services/issue-continuity-state.test.ts \
  src/__tests__/heartbeat-issue-rewake-throttle.test.ts
```

Expected: all selected tests pass with no provider call.

---

### Task 4: Deny unknown-progress continuation before materialization

**Objective:** Convert `progress_unknown` into one durable, distinct, Board-action-required hold with zero successor side effects.

**Files:**

- Modify: `server/src/services/heartbeat.ts` in the locked automatic-successor intent transaction around `13600-13624`
- Modify tests: `server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts`
- Review existing intent semantics: `server/src/services/productive-continuation.ts`

**Design:**

Add a branch before the existing no-progress and settlement/materialization branches:

```ts
if (current.workOutcome === "progress_unknown") {
  status = "denied";
  denialReason = "needs_human_progress_measurement_unknown";
  reason = "progress_measurement_unknown";
  // Atomically set issues.autonomousExecutionPaused = true.
}
```

Use the same canonical predecessor-scoped intent, locking, replay ordering, and task-hold pattern already proven for budget exhaustion. Do not create a wake, run, reservation, circuit permit, or adapter call. Replay of the terminal intent must be a no-op and must not create a second denial or mutate the issue again.

This is a Board hold, not a new provider attempt. A future provider-free measurement-repair worker is deferred; no automatic retry is introduced here.

**TDD steps:**

1. RED integration: unknown progress plus `continue_same_issue` produces exactly one denied intent.
2. Assert exact denial reason and predecessor binding.
3. Assert `successor_run_id=null`.
4. Assert issue `autonomousExecutionPaused=true` in the same committed result.
5. Assert zero successor wakes, runs, reservations, circuit permits, and adapter calls.
6. Replay terminalization and recovery; assert no second intent and no state drift.
7. Race two successor producers; assert one denied intent and zero materializations.
8. Confirm ordinary third `no_progress` still uses `needs_human_no_material_progress`.
9. Confirm generation exhaustion still uses its existing precise budget reason and wins according to current deterministic precedence where applicable.

Run:

```bash
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-issue-rewake-throttle.test.ts \
  src/__tests__/heartbeat-terminal-disposition.test.ts
```

Expected: all selected tests pass; provider adapter invocation count remains zero for unknown-progress denial.

---

### Task 5: Close the provider-free agreement gate

**Objective:** Prove the bounded correction across collector, classifier, terminal persistence, intent admission, replay, and concurrency without widening scope.

**Files:** No new production files unless a failing test identifies a necessary narrow seam.

**Required matrix:**

- normal tracked delta → productive;
- relevant untracked addition → productive;
- untracked `node_modules`, `.venv`, `dist`, and caches do not consume the snapshot limit;
- relevant untracked count/bytes exceed limit → progress unknown;
- baseline unknown and terminal verified → progress unknown;
- baseline verified and terminal unknown → progress unknown;
- unknown preserves exact streak and does not reset it;
- unknown creates one denied intent and durable task hold;
- identical replay/restart creates no new intent or streak mutation;
- confirmed unchanged still follows existing cooldown/circuit behavior;
- session rollover remains provider-error/usage-accounting behavior, not progress evidence;
- forged agent-authored progress receipt remains rejected;
- competing producers create at most one denied intent;
- zero provider calls, successor wakes, successor runs, and reservations on the unknown hold;
- root/provider-attempt exhaustion still yields zero fourth-run materialization.

**Commands:**

```bash
pnpm --filter @paperclipai/server exec vitest run \
  src/services/workspace-material-progress.test.ts \
  src/services/issue-continuity-state.test.ts \
  src/services/logical-execution.test.ts \
  src/__tests__/heartbeat-issue-rewake-throttle.test.ts \
  src/__tests__/heartbeat-terminal-disposition.test.ts \
  src/__tests__/autonomous-budget-reconciliation-evidence.test.ts

pnpm --filter @paperclipai/server typecheck
git diff --check
```

Record exact selected file/test counts. The known Node 22 versus required Node 24 warning must be reported but is not itself a pass/fail substitution.

**Review gate:** Request independent review limited to:

- unknown never becoming no-progress;
- streak preservation;
- exact canonical-intent replay ordering;
- atomic task hold;
- zero successor/provider side effects;
- no weakening of reservation accounting or exhaustion precedence.

Fix only blockers capable of invalidating these properties; defer unrelated findings.

**Commit boundary:** After tests and independent review pass, create one focused local commit. Do not push, merge, restart, migrate, or run a provider without separate authorization.

---

## Deferred follow-up gates

### One-time acceptance verification

Defer trusted RED→GREEN/build receipt authority. It requires a separate receipt schema, command identity, input/workspace digest binding, replay prevention, and trust-boundary review. It is not necessary to stop unknown from becoming no-progress.

### Continuation checkpoint changes

Before changing `execution-continuation.ts`, compare the exact predecessor and successor contexts from a provider-free fixture. Admit a checkpoint change only if the successor lacks a required structured fact. If the fact was present but ignored by the agent, prompt/checkpoint expansion is not justified by this incident.

### Provider-free measurement repair

A future operator/server-owned repair may recapture evidence without provider dispatch under the same execution-workspace identity. It must not reset provider attempts, request allowance, reservation accounting, or activation ceiling. For this correction, the safe behavior is a durable Board hold.

### Finalization without provider execution

A supported Board/control-plane operation may eventually publish already-verified evidence and transition an issue to done without another provider call. This needs separate authorization and audit design; do not fold it into progress classification.

---

## Live acceptance boundary

After local commit, runtime restart, health/readiness, and containment are separately authorized and verified, request authorization for exactly one COM-289 canary.

Pass criteria for the COM-289 correction:

1. isolated workspace identity is read back before launch;
2. baseline and terminal measurement are complete, or measurement unknown creates a distinct hold without another provider-backed run;
3. no completed test/build work is repeated because of a false `no_progress` classification;
4. every provider dispatch is reconciled;
5. COM-289 completes within existing limits or stops for a genuine, precisely classified reason;
6. no unrelated agent/task executes;
7. no duplicate wake/run/intent occurs;
8. company and agent return to paused containment.

Automatic COM-290 launch is a separate dependency-handoff gate. Its result must not be used to reinterpret whether the COM-289 progress correction passed.

## Stop rule

A new discovery blocks this correction only if it can invalidate workspace-progress attribution, safe successor admission, reservation interpretation, or the single COM-289 canary. Everything else is documented as deferred hardening.

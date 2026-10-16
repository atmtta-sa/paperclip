# Durable Finalization Checkpoint Implementation Plan

> **For Hermes:** Implement task-by-task with TDD and independent review before commit.

**Goal:** Prevent a completed issue from spending repeated provider runs on rediscovery and verification after session rollover.

**Architecture:** Extend the existing run-disposition contract with a bounded, model-declared completion checkpoint. Persist it in the already-durable run result and successor context, then make the next continuation finalization-first when the checkpoint has no remaining acceptance items. The server must never infer completion from prose or tests; the agent must still emit a validated terminal disposition. A repeated `continue_same_issue` from finalization-only context is denied and held instead of receiving another full continuation.

**Tech stack:** TypeScript, FastAPI-adjacent Paperclip server services, Hermes adapter, Drizzle/PostgreSQL, Vitest.

---

## Scope lock

In scope:
- durable bounded completion checkpoint in the existing disposition/result/context JSON;
- checkpoint preservation across automatic successor and session rollover;
- one finalization-first continuation when declared remaining work is empty;
- fail-closed denial if finalization-only execution again requests ordinary continuation;
- provider-free integration tests proving bounded behavior.

Out of scope:
- raising or resetting the 4-request/run or 12-request/generation limits;
- automatically marking an issue done from prose, test names, or workspace state;
- generalized acceptance frameworks, new queues, leases, or checkpoint tables;
- changing workspace progress classification;
- editing historical runs, intents, reservations, or wakes;
- provider-backed testing, restart, deployment, push, or merge without separate authorization.

## Contract

A `continue_same_issue` disposition may carry:

```ts
completionCheckpoint: {
  version: 1;
  completedItems: string[];          // bounded, informational
  remainingAcceptanceItems: string[]; // bounded; authoritative only for routing
  verificationSummary: string | null; // bounded, informational
}
```

Rules:
1. Identity remains runtime-bound; model-supplied company/issue/run/workspace identity is discarded.
2. The checkpoint is not proof that work is complete and cannot directly mutate issue status.
3. `remainingAcceptanceItems.length > 0` preserves ordinary continuation.
4. `remainingAcceptanceItems.length === 0` creates a successor with `finalizationOnly: true` and the checkpoint in trusted context.
5. A finalization-only run may emit `complete`, `blocked`, `needs_human`, `in_review`, or `cancelled`.
6. A finalization-only run emitting `continue_same_issue`, missing disposition, or malformed disposition receives one denied intent with `finalization_required`; it creates no further run, wake, reservation, or provider call and atomically pauses autonomous issue execution.
7. Existing confirmed-progress, confirmed-no-progress, and `progress_unknown` behavior remains unchanged.

---

### Task 1: Add RED disposition checkpoint transport tests

**Objective:** Define the bounded wire contract without changing runtime behavior.

**Files:**
- Modify: `packages/adapters/hermes/src/server/run-disposition.test.ts`
- Modify: `packages/adapters/hermes/src/server/execute.onspawn.test.ts`
- Modify: `packages/adapters/hermes/src/server/prompt-rendering.test.ts`

**Steps:**
1. Add a failing test accepting a valid bounded checkpoint on `continue_same_issue` and binding it to the current run/workspace.
2. Add table-driven rejection tests for wrong version, non-arrays, empty/oversized items, too many items, and oversized verification text.
3. Add a failing execution test proving the normalized checkpoint reaches `resultJson.runDisposition`.
4. Add a prompt test proving finalization-only context instructs the agent to avoid rediscovery/tool repetition and emit a terminal disposition.
5. Run:
   `pnpm --filter @paperclipai/adapter-hermes exec vitest run src/server/run-disposition.test.ts src/server/execute.onspawn.test.ts src/server/prompt-rendering.test.ts`
6. Confirm RED failures are specifically missing checkpoint/finalization behavior.

### Task 2: Implement bounded adapter transport

**Objective:** Parse, normalize, persist, and prompt the checkpoint with no new persistence table.

**Files:**
- Modify: `packages/adapters/hermes/src/server/run-disposition.ts`
- Modify: `packages/adapters/hermes/src/server/execute.ts`

**Steps:**
1. Add strict limits for item count and text length.
2. Extend only the `continue_same_issue` normalized disposition with `completionCheckpoint`.
3. Preserve runtime-bound identity and reject malformed checkpoints fail-closed.
4. Extend `PAPERCLIP_RUN_DISPOSITION_INSTRUCTION`:
   - `complete` when acceptance is satisfied;
   - use `continue_same_issue` only with concrete remaining acceptance items;
   - in finalization-only context, do not repeat discovery or tests.
5. Inject the prior checkpoint/finalization-only flag from trusted execution context into the rendered prompt.
6. Rerun Task 1 tests; require GREEN.

### Task 3: Add RED server continuation/finalization tests

**Objective:** Prove checkpoint routing and zero-side-effect denial before changing heartbeat logic.

**Files:**
- Modify: `server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts`
- Modify: `server/src/__tests__/heartbeat-terminal-disposition.test.ts` only if terminal completion coverage needs the new context shape.

**Provider-free scenarios:**
1. Productive run + checkpoint with remaining items → ordinary successor; checkpoint preserved.
2. Productive run + checkpoint with no remaining items → exactly one successor carrying `finalizationOnly: true`.
3. Session rollover before finalization → replacement run retains the same checkpoint and finalization-only authority.
4. Finalization-only run emits `complete` → issue becomes `done` atomically and normal dependent wake behavior remains intact.
5. Finalization-only run emits `continue_same_issue` → one denied intent, reason `finalization_required`, issue held, zero successor run/wake/reservation/adapter call.
6. Finalization-only run has missing/malformed disposition → same fail-closed result.
7. `progress_unknown` still wins and retains `workspace_progress_measurement_unknown` semantics.

For each zero-side-effect case, assert exact counts for intents, wakes, runs, reservations, and adapter calls before and after restart/recovery.

Run the named tests and confirm RED only at the missing finalization-checkpoint behavior.

### Task 4: Implement minimal heartbeat routing and guard

**Objective:** Carry the checkpoint and stop repeated full continuations after completion is declared.

**Files:**
- Modify: `server/src/services/productive-continuation.ts`
- Modify: `server/src/services/heartbeat.ts`

**Functions/concepts:**
- Extend `ProductiveRunDisposition` parsing with the normalized checkpoint.
- In `handleProductiveRunContinuation(...)`, place the checkpoint in the claimed intent and successor context.
- Derive `finalizationOnly` solely from a valid checkpoint with zero remaining items.
- Before ordinary continuation materialization, detect finalization-only replay/continuation requests.
- Under the existing company/issue/run/intent locks, create the denied intent and issue hold atomically.
- Suppress liveness continuation, successful-run handoff, missing-comment recovery, goal rollover, and deferred promotion for the denied finalization-only outcome.
- Reuse existing intent uniqueness and wake admission; add no new scheduler.

Rerun Task 3 tests; require GREEN.

### Task 5: Provider-free integrated rollover proof

**Objective:** Reproduce the COM-290 failure shape and prove one finalization response closes it.

**Files:**
- Prefer extending: `server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts`
- Add no new production file unless the existing test file becomes unmaintainable.

**Fixture sequence:**
1. Run A records verified workspace change and a checkpoint with no remaining acceptance items.
2. Force the existing `session_rollover_required` path.
3. Run B receives the checkpoint and `finalizationOnly: true`.
4. Stub adapter returns terminal `complete` in its first response.
5. Assert:
   - issue status `done`;
   - exactly one post-rollover provider invocation;
   - no repeated test/discovery successor;
   - no no-progress increment from the finalization run;
   - dependent wake behavior is unchanged and deduplicated;
   - no fourth run or extra reservation.
6. Add the negative twin where Run B emits `continue_same_issue`; assert `finalization_required` hold and zero descendants.

### Task 6: Closure gates

Run, in order:

1. Adapter focused tests from Task 1.
2. Server focused tests from Task 3.
3. Existing continuity matrix:
   `pnpm --filter @paperclipai/server exec vitest run --silent=passed-only src/services/workspace-material-progress.test.ts src/services/issue-continuity-state.test.ts src/__tests__/heartbeat-issue-rewake-throttle.test.ts src/__tests__/heartbeat-terminal-disposition.test.ts`
4. Adapter TypeScript check and server `pnpm run typecheck`.
5. `git diff --check`.
6. Independent review focused on:
   - no automatic completion from untrusted prose/checkpoint;
   - checkpoint survival across rollover;
   - atomic denial/hold;
   - zero successor side effects;
   - unchanged budgets and `progress_unknown` behavior.
7. Commit only after all gates pass.
8. Stop before restart or provider-backed canary and request separate authorization.

## Acceptance criteria

- A completed implementation with zero remaining declared acceptance items is not sent through ordinary discovery/verification continuation.
- After session rollover, the checkpoint remains available and the next run is finalization-first.
- A correct finalization response closes the issue in one provider response and allows normal dependent progression.
- A non-terminal finalization response cannot consume another full continuation generation.
- No budget limits are increased or reset.
- Existing `progress_unknown`, no-progress, logical-generation, and pre-materialization denial tests remain green.

## Risk controls

- Treat checkpoint content as routing context, not completion proof.
- Keep terminal issue mutation behind the existing validated terminal-disposition service.
- Bound all model-authored arrays/text and reject malformed envelopes.
- Use existing transaction locks and predecessor-intent uniqueness; do not add a second continuation mechanism.
- Do not let finalization-only suppress genuine `blocked`, `needs_human`, `in_review`, or `cancelled` outcomes.

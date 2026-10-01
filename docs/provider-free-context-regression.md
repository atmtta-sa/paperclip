# Provider-free context regression matrix

This matrix is the Phase 7 gate for the Paperclip → Hermes context-containment architecture. It exercises existing assembly, adapter, execution, result-storage, profile, memory, skill, checkpoint, and rollover seams. It must run with no provider transport, Paperclip wake, deployment, or production mutation.

All fixture values are deterministic and synthetic. Credential fields use `[REDACTED]`. The observed byte sizes reproduce measurements without retaining provider data.

## Matrix

| ID | Deterministic fixture | Required invariant | Owning regression |
|---|---|---|---|
| PF-01 | COM-269-like objective repeated by issue, plan, comment, and continuation sources | One structurally keyed objective is rendered; provenance is merged | `packages/adapter-utils/src/paperclip-hermes-context.test.ts` |
| PF-02 | Complete assembled request with system prompt, user input, tools, and transport kwargs | Exact final physical request is captured and transport is skipped | Hermes `tests/agent/test_effective_request_capture.py` |
| PF-03 | Managed isolated profile with memory disabled and profile-only skills | Managed memory policy is enforced; default/shared profile and skill targets are rejected | `packages/adapters/hermes/src/index.test.ts`; Hermes `tests/agent/test_managed_memory_policy.py` |
| PF-04 | Oversized `AGENTS.md`-equivalent system content | Fully assembled request is rejected at the final boundary before SDK transport | Hermes `tests/agent/test_final_request_budget_gate.py` |
| PF-05 | Oversized tool-schema registry | Tool-schema bytes are measured and rejected before SDK transport | Hermes `tests/agent/test_final_request_budget_gate.py` |
| PF-06 | One tool result containing exactly 873,450 UTF-8 bytes | Model re-entry receives at most 50,000 bytes plus a bounded spill marker | Hermes `tests/tools/test_managed_tool_result_containment.py` |
| PF-07 | Broad 2,000-entry search enumeration | Enumeration output is contained before model re-entry and counts against turn/session ledgers | Hermes `tests/tools/test_managed_tool_result_containment.py` |
| PF-08 | Equal-rank conflicting values under one semantic key | Canonicalization fails closed with the conflicting key and source IDs | `packages/adapter-utils/src/paperclip-hermes-context.test.ts` |
| PF-09 | Failed rollover replay with different volatile run, receipt, and workspace identifiers | Normalized durable state is identical and another rollover is rejected | `server/src/services/execution-continuation.test.ts` |
| PF-10 | Fake-provider tool loop that changes a tracked file and runs a passing test | Non-empty patch, passing command evidence, clear blockers, and exact next action form a valid checkpoint | Hermes `tests/run_agent/test_provider_free_implementation_checkpoint.py`; `server/src/services/execution-checkpoint.test.ts` |
| PF-11 | Concurrent/duplicate session-rollover scheduling attempts | Exactly one fresh rollover is permitted; missing or unchanged checkpoints suppress another run | `server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts`; `server/src/__tests__/heartbeat-retry-scheduling.test.ts` |

Workspace precedence and checkpoint transport are additionally pinned by `packages/adapters/hermes/src/server/execute.onspawn.test.ts`: the issue-scoped `paperclipWorkspace.cwd` becomes both the child working directory and `HERMES_EXECUTION_CHECKPOINT_CWD`.

## Provider-free gate commands

Run from the Hermes worktree:

```text
.venv/bin/pytest -q \
  tests/agent/test_effective_request_capture.py \
  tests/agent/test_final_request_budget_gate.py \
  tests/agent/test_managed_memory_policy.py \
  tests/tools/test_managed_tool_result_containment.py \
  tests/cli/test_execution_checkpoint.py \
  tests/cli/test_single_query_session_finalize.py \
  tests/run_agent/test_provider_free_implementation_checkpoint.py
```

Run from the Paperclip worktree:

```text
(cd packages/adapters/hermes && pnpm test)

pnpm exec vitest run \
  packages/adapter-utils/src/paperclip-hermes-context.test.ts \
  server/src/services/execution-checkpoint.test.ts \
  server/src/services/execution-continuation.test.ts

pnpm exec vitest run \
  server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts \
  server/src/__tests__/heartbeat-retry-scheduling.test.ts \
  -t "does not schedule a rollover without a durable execution checkpoint|starts one fresh rollover session and rejects the unchanged capsule before another run|does not misclassify a pre-provider session rollover as missing telemetry|bounds session rollover to one full-jitter continuation"
```

The focused heartbeat command deliberately excludes unrelated provider-circuit tests whose shared circuit state can make a whole-file run nondeterministic. This does not reduce rollover coverage: every Phase 7 heartbeat invariant is named explicitly.

A pass requires all four commands to exit zero. Any provider SDK/HTTP call, wake, deployment, or production write invalidates the run rather than counting as evidence.

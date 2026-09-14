---
title: Command Center Team and Adapters
summary: Governed five-agent Paperclip configuration and Phase 5 verification contract
---

# Command Center Team and Adapters

## Authority and activation boundary

Paperclip is the sole authority for agents, hierarchy, issues, runs, approvals, logs, costs, schedules, budgets, and operational state. Agent Office reads that state and does not mutate it.

All five agents must be created with the heartbeat scheduler disabled and then paused before the scheduler can be enabled. They remain paused until a separately approved canary. Creating the records does not authorize a heartbeat, task assignment, provider call, repository write, deployment, or migration.

OpenClaw is disabled. Use it only after a separate decision identifies a concrete gateway, messaging, remote-access, or OpenClaw-native requirement.

## Five-agent organization

| Name | Paperclip role | Reports to | Adapter | Scope |
|---|---|---|---|---|
| Team Lead | `cto` | none | `hermes_local` | Coordination and review; no automatic merge, deploy, migration, or provider-configuration authority |
| ORP Developer | `engineer` | Team Lead | `hermes_local` | ORP checkout only |
| Whattsi Developer | `engineer` | Team Lead | `hermes_local` | Whattsi checkout only |
| Codex Agent | `engineer` | Team Lead | `codex_local` | Project-neutral software engineering in one explicitly assigned mode and approved workspace |
| Hermes Agent | `engineer` | Team Lead | `hermes_local` | Explicitly assigned coding or review work in a disposable or approved workspace |

`manager` is not a valid Paperclip role. `cto` is the valid supervisory role for Team Lead; the visible title remains “Team Lead / Supervisor.”

## Workspace boundaries

The project checkouts are separate authorities and must never share a working directory:

- ORP last-known checkout: `/mnt/c/orchestration-platform`
- Whattsi last-known primary checkout: `/mnt/c/Users/Yoga/IdeaProjects/Whattsi`
- Paperclip product checkout: `/home/yoga/workspace/paperclip-command-center`
- Commander rollback checkout: `/home/yoga/workspace/commander`

The `/mnt/c` mount must be live and each repository path, branch, clean/dirty state, remote, and instruction source must be freshly verified before storing an ORP or Whattsi `cwd`. Last-known paths are not sufficient evidence for activation.

Commander is rollback only. No Phase 5 agent may use Commander as the ORP or Whattsi workspace.

## Repository laws and instructions

Each developer receives an agent-owned Paperclip instructions bundle that points to the verified project instructions. Do not copy mutable project laws into a second authoritative store.

Before activation, verify and record for each project:

1. canonical checkout and Git remote;
2. approved base branch and worktree policy;
3. repository `AGENTS.md` and project handoff/current-context files;
4. allowed test commands and disposable service/database rules;
5. prohibited live-data, deployment, migration, push, merge, and credential actions;
6. explicit escalation conditions.

Team Lead may coordinate and review both project streams but must not use one project checkout to execute work for the other.

## Adapter configuration

### Hermes local

Use `hermes_local` for Team Lead, ORP Developer, Whattsi Developer, and Hermes Agent.

Baseline adapter configuration:

```json
{
  "provider": "auto",
  "persistSession": true,
  "worktreeMode": true,
  "checkpoints": true,
  "quiet": true,
  "timeoutSec": 300,
  "graceSec": 10,
  "maxTurnsPerRun": 20,
  "toolsets": "terminal,file"
}
```

Set `cwd` only after the target repository and laws are freshly verified. Leave `model` unset so Hermes uses its reviewed local profile. Do not store API keys in `adapterConfig`, prompts, instructions, or Git; use Paperclip secret references or the local Hermes profile.

The current host has Hermes Agent v0.21.1 installed and an authenticated provider profile. This proves local CLI availability only; it does not authorize a model call.

### Hermes gateway

`hermes_gateway` is optional and currently not ready on this host: the Hermes user service is active, but no API listener is present on the default `127.0.0.1:8642` endpoint. Do not configure a gateway agent until its authenticated health endpoint passes from the Paperclip runtime.

A gateway key is distinct from a Paperclip API key. Never place either value in this repository.

### Codex local

Use `codex_local` for Codex Agent.

Baseline adapter configuration:

```json
{
  "engine": "acp",
  "mode": "persistent",
  "nonInteractivePermissions": "deny",
  "warmHandleIdleMs": 0,
  "dangerouslyBypassApprovalsAndSandbox": false,
  "workspaceStrategy": {
    "type": "git_worktree"
  }
}
```

The current host has Codex CLI 0.151.0 and a local ChatGPT login. This proves credential presence and CLI availability only; it does not authorize a provider request. ACP is fail-closed: do not silently fall back to CLI if ACP startup fails.

## Safe creation sequence

Use a uniquely named disposable Paperclip runtime with its own database and `HEARTBEAT_SCHEDULER_ENABLED=false`.

The repository-owned helper is `scripts/command-center/bootstrap-phase5-team.mjs`. It is dry-run by default and accepts only five distinct workspaces beneath `PAPERCLIP_PHASE5_DISPOSABLE_ROOT`. Set the five `PAPERCLIP_PHASE5_*_CWD` variables to harmless disposable Git repositories, then run it without `--apply` to inspect the plan. Applying additionally requires all of:

- the `--apply` argument;
- `PAPERCLIP_PHASE5_APPLY=1`;
- `HEARTBEAT_SCHEDULER_ENABLED=false`;
- a credential-free loopback Paperclip API URL and optional board API key in process environment only.

The helper never prints the API key. It reuses only an exact synthetic company/name set, fails on unexpected or mismatched agents, creates Team Lead first, pauses every created agent before continuing, and reads back the final agent list and org tree.

1. Create a synthetic company with no production data and no live repository binding.
2. Create Team Lead first with a harmless disposable Git repository as `cwd`.
3. Create the four reports with `reportsTo` set to Team Lead’s Paperclip agent ID.
4. Pause each created agent before any scheduler-enabled restart.
5. Read back `GET /api/companies/{companyId}/agents` and `GET /api/companies/{companyId}/org`.
6. Assert exactly five stable IDs, the hierarchy above, the intended adapter types, zero spend, and paused status.
7. Verify Agent Office shows the same five Paperclip IDs and names while remaining read-only.

If any create or pause operation fails, keep the scheduler disabled, record created IDs, and reconcile only those synthetic records. Do not retry blindly.

## Team Lead governance

`scripts/command-center/team-lead/AGENTS.md` is the standing Team Lead contract. The five-agent bootstrap sets it as Team Lead's `instructionsFilePath`; worker agents do not inherit it.

Each imported project must have a parent issue with a task watchdog assigned to Team Lead using `buildProjectWatchdogRequest` from `scripts/command-center/team-lead-governance.mjs`. On each stopped subtree, Team Lead must honor valid waits, return incomplete slices or failed evidence to the same developer, and release the next task only after deterministic acceptance gates pass.

At project completion, the developer supplies the test URL, prerequisites, numbered test steps, expected results, and limitations. Team Lead independently verifies that handoff, then waits for Naz's explicit `testing_successful` approval before releasing another project.

Protected-repository binding, provider calls or spend, push/merge/deploy, and production activation fail closed without an exact bounded approval for the requested action and scope.

## ORP Developer persona

`scripts/command-center/orp-developer/AGENTS.md` is the standing ORP Developer contract. The bootstrap assigns it only to ORP Developer together with the core Paperclip skill; other workers do not inherit ORP-specific laws.

The contract requires task-scoped checkout, same-heartbeat execution, ORP architecture and localization boundaries, test-first evidence, disposable PostgreSQL safety, and explicit Team Lead reporting. Installing this persona does not authorize binding or accessing the real ORP checkout, activating the agent, making provider calls, or mutating project data; each requires its own approved task and boundary.

## Whattsi Developer persona

`scripts/command-center/whattsi-developer/AGENTS.md` is the standing Whattsi Developer contract. The bootstrap assigns it only to Whattsi Developer together with the core Paperclip skill; other workers do not inherit Whattsi-specific laws.

The contract requires task-scoped checkout, same-heartbeat execution, FastAPI/PostgreSQL responsibility boundaries, tenant and principal isolation, test-first evidence, isolated disposable database safety, bilingual and RTL behavior, and explicit public-launch evidence states. Installing this persona does not authorize binding or accessing the real Whattsi checkout, activating the agent, sending Meta WhatsApp messages, changing Cloudflare or payment-provider configuration, or mutating project data; each requires its own approved task and boundary.

## Codex Software Engineer persona

`scripts/command-center/codex-agent/AGENTS.md` is the standing project-neutral Codex contract. The bootstrap assigns it only to Codex Agent. Its primary mode is selected per task: implementation, independent review, diagnosis, verification, or behavior-preserving refactoring.

Project developers remain the default implementers and accountable owners of ORP and Whattsi tasks. Codex has no standing project ownership and does not run automatically for commits, completions, routine changes, or idle capacity. Team Lead may create one bounded Codex task only when high-risk work, difficult diagnosis, conflicting evidence, repeated failed corrections, or explicitly approved specialist/overflow implementation justifies the additional provider run.

Every Codex assignment names the exact repository, approved worktree, branch or diff, acceptance criteria, mutation permission, evidence requirements, primary mode, and stop condition. Codex cannot accept its own implementation, take over another developer's issue, or exercise commit, push, merge, deploy, provider, spending, production, or live-data authority without the corresponding separate approval.

### Synthetic watchdog checkpoint — 2026-09-14

A loopback-only disposable preview with scheduler and telemetry disabled verified the control-plane lifecycle and one provider-backed Team Lead continuation:

- watched issue `COM-1` was assigned to ORP Developer and intentionally left incomplete;
- Paperclip created reusable watchdog review `COM-2` with origin `task_watchdog`, assigned to canonical Team Lead (`cto`);
- Team Lead honored a manual pause, requested Board confirmation, then resumed only after that confirmation was accepted;
- the authenticated continuation posted exact correction criteria to `COM-1`, restored the same developer's execution path, and closed `COM-2`;
- the developer wake reached its configured provider and failed safely on insufficient provider balance; Paperclip surfaced `COM-1` as blocked rather than claiming completion;
- the bounded supervisor passed all seven assertions: one Team Lead run, successful exit, authenticated comment, same-developer wake, watchdog closure, both agents paused, and no live runs;
- protected repositories remained unchanged and the Team Lead incurred no recorded control-plane spend.

## Non-spending readiness gate

Before a provider-backed canary:

- Hermes CLI version check passes.
- Hermes adapter unit tests, typecheck, and build pass.
- Codex CLI version and local login-status checks pass.
- Codex ACP configuration/engine unit tests, typecheck, and build pass.
- Paperclip frozen install, workspace typecheck, and Agent Office tests pass.
- `OpenClaw` is absent from all five agent configurations.
- ORP and Whattsi working directories are mounted and freshly verified.
- All five Paperclip agents are paused and the disposable scheduler is disabled.

## Provider-backed synthetic canary

A canary requires explicit approval because it starts workers and may spend provider credits. Run it only in disposable Git repositories containing no product code or credentials.

For one Hermes run and one Codex run:

1. assign one harmless task that writes a fixed text file in its disposable repository;
2. resume only the selected agent and invoke one heartbeat;
3. verify Paperclip issue ID, agent ID, run ID, logs, result, terminal state, and cost metadata;
4. verify Agent Office attributes the same active run and returns the agent to idle afterward;
5. pause the agent again before moving to the next adapter;
6. prove ORP, Whattsi, Commander, and the Paperclip source checkout are unchanged;
7. remove the disposable runtime, database, repositories, and descendant processes.

A successful local CLI probe is not a substitute for this Paperclip-attributed canary.

## Phase 5 acceptance record

### Scheduler-disabled runtime checkpoint — 2026-09-13

A uniquely isolated loopback runtime was exercised and removed:

- runtime API `127.0.0.1:3120`; embedded PostgreSQL `127.0.0.1:54330`;
- heartbeat scheduler and telemetry disabled;
- five disposable Git repositories, with no product checkout binding;
- exact five-agent hierarchy created and read back with stable IDs;
- all agents manually paused with heartbeat disabled, zero budget, zero spend, and no last heartbeat;
- zero issues and zero heartbeat runs;
- source checkout, Commander, and all five disposable repositories remained unchanged;
- Agent Office was not installed in this fresh instance, so Office reconciliation remains unproven at this checkpoint;
- runtime directory removed, both listeners absent, and no matching descendant process remained.

Safe artifacts are outside Git at `.hermes/artifacts/paperclip-agent-office/phase5-paused-team-runtime.log` and `.hermes/artifacts/paperclip-agent-office/phase5-paused-team-bootstrap.json`. The disposable database and repositories were intentionally removed.

### Agent Office reconciliation checkpoint — 2026-09-13

A second scheduler-disabled disposable runtime reconciled Agent Office against live Paperclip records:

- the runtime served branch commit `d6c87fa6c` in `local_trusted` and `private` mode;
- Agent Office `0.1.0` installed from the repository package and reported `ready`;
- its page and sidebar contributions resolved through installed plugin UUID `ba877993-3ba5-42c9-82d5-705c64417093`;
- the plugin projected the exact IDs of the five paused Paperclip agents, all as `idle`;
- API readback remained at zero issues, zero live runs, zero heartbeat runs, and zero spend;
- the bundle, Agent Office MIT notice, and required GLTF texture routes returned HTTP `200`;
- desktop browser verification showed one upstream renderer canvas, all five roles, no JavaScript errors, and no horizontal overflow;
- fresh `390×844` mobile verification showed the 3D office and all five readable status cards with no overlap or horizontal overflow;
- no agent was resumed and no worker, heartbeat, provider, or model was invoked;
- the runtime directory, embedded database, and five repositories were removed; ports `3120` and `54330` are free and no matching process remains.

Evidence is outside Git at `.hermes/artifacts/paperclip-agent-office/phase5-office-reconciliation-runtime.log`, `.hermes/artifacts/paperclip-agent-office/phase5-office-reconciliation-bootstrap.json`, and `.hermes/artifacts/paperclip-agent-office/phase5-office-mobile-390x844.png`.

### Provider canary checkpoint — 2026-09-13

A third scheduler-disabled disposable runtime exercised the native provider adapters without binding any protected repository:

- ORP, Whattsi, Commander, and Paperclip source were clean before and after the canaries;
- the native `codex_local` ACP canary succeeded in run `935538ef-000e-4336-9b43-5bff23030c62`, with exit code `0` and exact fixed-file output in its isolated issue worktree;
- Codex reported subscription-included usage of 536 input, 68 output, and 40,064 cached-input tokens, with no metered cost recorded;
- an earlier Codex setup attempt failed before provider invocation because its synthetic issue lacked a project workspace; adding a disposable Paperclip project with a primary workspace corrected the fixture without weakening the canary;
- the native `hermes_local` canary reached Hermes, but the configured automatic model selected DeepSeek and failed with HTTP `402 Insufficient Balance`;
- one separately approved retry persisted `provider: openai-codex` only on the disposable Hermes record, but Hermes still selected the configured DeepSeek model and returned the same `402`; no Hermes output, usage, or cost was recorded;
- all five agents were paused after execution, the successful Codex issue was reconciled to `done`, and the Hermes issue was left `blocked` with the provider-boundary reason;
- the disposable runtime, embedded database, worktrees, and repositories were removed; ports `3120` and `54330` are free and no matching process remains.

Safe artifacts remain outside Git at `.hermes/artifacts/paperclip-agent-office/phase5-provider-canaries-runtime.log`, `.hermes/artifacts/paperclip-agent-office/phase5-provider-canaries-final.json`, `.hermes/artifacts/paperclip-agent-office/phase5-codex-canary-retry-run.json`, and `.hermes/artifacts/paperclip-agent-office/phase5-hermes-openai-codex-canary-run.json`. No credentials are retained in this document.

### Hermes provider-routing acceptance — 2026-09-13

A focused RED/GREEN adapter fix removed the conflicting `-m auto` argument whenever an explicit Hermes provider is selected. A fresh scheduler-disabled disposable runtime then closed the Hermes acceptance row:

- native `hermes_local` run `7fdb58df-725f-4ff6-94a1-6a80d0230c82` used `openai-codex`, succeeded with exit code `0`, and reported exact byte verification for `HERMES_CANARY.txt` containing `HERMES_PHASE5_CANARY_OK` plus one newline;
- Hermes removed its isolated worktree after completion, so the temporary output file was intentionally not retained;
- Paperclip recorded no Hermes usage or cost for this run;
- because the local runtime lacked an agent JWT, Hermes could not update the issue directly and Paperclip queued automation run `99ed8796-d015-4778-9eb2-5fee3718d164`; it was cancelled by pausing the agent and recorded no usage or cost;
- the board reconciled the synthetic issue to `done`, and final API readback showed exactly five paused agents with zero recorded spend;
- ORP, Whattsi, Commander, and Paperclip source remained unchanged by runtime execution;
- the runtime, embedded database, worktrees, and five disposable repositories were removed, with ports `3120`, `54329`, and `54330` free and no matching process remaining.

Safe final evidence is outside Git at `.hermes/artifacts/paperclip-agent-office/phase5-hermes-fixed-canary-runtime.log`, `.hermes/artifacts/paperclip-agent-office/phase5-hermes-fixed-canary-bootstrap.json`, `.hermes/artifacts/paperclip-agent-office/phase5-hermes-fixed-canary-run.json`, `.hermes/artifacts/paperclip-agent-office/phase5-hermes-fixed-canary-events.json`, and `.hermes/artifacts/paperclip-agent-office/phase5-hermes-fixed-canary-final.json`.

### Phase 6 non-spending approval projection — 2026-09-13

A private scheduler-disabled disposable runtime proved the genuine Paperclip approval-to-Office waiting boundary without invoking a provider:

- Paperclip served the Phase 6 branch on loopback with an isolated embedded PostgreSQL database and telemetry disabled;
- Agent Office installed from the local package with its original read-only capabilities unchanged;
- exactly five disposable Git repositories backed five paused agents, with no protected checkout bound to a worker;
- synthetic company `31e55034-03db-4743-b034-313baaf3b61a`, project `2fc603cf-ac41-415b-abb7-d0757cdb0b9e`, issue `33f3e478-9ea2-431b-a853-bea14843ea02`, Hermes agent `e8b80813-47c7-4ce9-8830-2be7f7caffe7`, and pending approval `add1f365-fb71-41d6-966a-7b538bc574ab` reconciled through Paperclip APIs;
- Agent Office rendered one Three.js canvas and all five cards; Hermes visibly showed `waiting` and the exact synthetic task title while the other four agents remained `idle`;
- browser inspection found no JavaScript errors or horizontal overflow;
- API readback showed five paused agents, one linked pending approval, zero heartbeat runs, zero live runs, and zero recorded spend;
- ORP, Whattsi, and Commander remained clean at their recorded baseline commits;
- all agents were paused again before shutdown, and the runtime, database, worktrees, and repositories were removed; ports `3120`, `54329`, and `54330` are free with no matching descendant process.

Safe evidence remains outside Git at `.hermes/artifacts/paperclip-agent-office/phase6-nonspending-runtime.log`, `.hermes/artifacts/paperclip-agent-office/phase6-nonspending-bootstrap.json`, `.hermes/artifacts/paperclip-agent-office/phase6-nonspending-fixture.json`, and `.hermes/artifacts/paperclip-agent-office/phase6-nonspending-final.json`.

### Phase 6 provider-backed lifecycle reconciliation — 2026-09-13/14

Separately approved, sequential native-adapter runs completed the disposable provider-backed boundary:

- Hermes issue `12e4155d-c617-40b0-b089-1442feac05d5` ran through `hermes_local` with the agent-scoped `openai-codex` provider as run `ce07ed6a-a985-4184-b53c-3139fe5cddb0`; it succeeded with exit code `0` and created only `HERMES_PHASE6_E2E.txt`;
- the Hermes output was independently verified from commit `edd08f93cf692d04d693b03bb1f0ca146421a1cf` as exactly 21 bytes (`HERMES_PHASE6_E2E_OK\n`), SHA-256 `34524916db69e664f6aef97893d7c55b55104aaa70b9dcc585f20ce349a54528`;
- Paperclip generated one automatic Hermes successful-run handoff, `03ee673d-1468-43b7-aa41-e78afd34f24e`; the agent was paused and the follow-up was cancelled before usage or cost was recorded;
- the disposable runtime did not inject an agent JWT, so Hermes' authenticated issue update returned `401`; the board explicitly reconciled the issue and this is not represented as an agent-attributed control-plane update;
- the first Codex attempt, run `b0b896dc-e1dd-4c9a-af0b-7cfd48e79281`, failed before provider execution because its isolated managed Codex home had no authentication; it produced no output, usage, or cost and consumed that approved attempt;
- a separate non-provider preflight proved the supported remedy: start Paperclip with the authenticated host `CODEX_HOME`, configure the synthetic agent's managed home, and let startup reconciliation create a temporary symlink to the host `auth.json`; the symlink target retained mode `0600`, no credential value was printed or persisted in Git, all agents stayed paused, and no provider ran;
- after fresh approval, replacement Codex run `cf75acbd-c04b-4831-b589-3d9b1f0a20c4` succeeded with exit code `0` and independently verified `CODEX_PHASE6_E2E.txt` as exactly 20 bytes (`CODEX_PHASE6_E2E_OK\n`), SHA-256 `2cd7e1cc4e4f00d446a94f22db06229b6510ef016eec613bfecd4718583ec5da`;
- the replacement Codex run was the only run in its fresh company, reached issue status `done`, and recorded 1,198 input, 49 output, and 32,000 cached-input tokens as `subscription_included` / `unpriced`, with Paperclip spend remaining zero;
- every runtime ended with all five agents paused; the isolated databases, managed credential symlinks, repositories, and worktrees were removed; ports `3120`, `54329`, and `54330` were free and no matching descendant remained;
- ORP, Whattsi, Commander, and the Paperclip source checkout retained their recorded commits and clean working trees.

Safe evidence remains outside Git under `.hermes/artifacts/paperclip-agent-office/phase6-provider-*.json`, `.hermes/artifacts/paperclip-agent-office/phase6-provider-runtime.log`, `.hermes/artifacts/paperclip-agent-office/phase6-codex-auth-preflight-*.json`, and `.hermes/artifacts/paperclip-agent-office/phase6-codex-replacement-*.json`/`.log`. No credential content is retained in these artifacts.

Record these results without secrets:

| Evidence | Required result |
|---|---|
| Five-agent API readback | Exact names, stable IDs, valid hierarchy, paused status |
| Adapter environment checks | Hermes local and Codex local ready |
| Hermes synthetic run | One successful attributable run |
| Codex synthetic run | One successful attributable run through ACP |
| Office reconciliation | Same issue, agent, and run IDs as Paperclip |
| Cost/audit readback | Run-linked metadata present; no unexplained spend |
| Repository proof | ORP, Whattsi, Commander, and Paperclip source unchanged |
| Cleanup proof | No disposable listener, process, database, or repository remains |

Phase 5 is complete only when every row is backed by fresh execution evidence. Until then, keep every agent paused and describe the phase as configuration/readiness work, not operational activation.

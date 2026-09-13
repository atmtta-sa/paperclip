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
| Codex Agent | `engineer` | Team Lead | `codex_local` | Explicitly assigned coding or review work in a disposable or approved workspace |
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

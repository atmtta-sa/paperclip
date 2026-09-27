/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { buildPrompt, execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("injects the reserved autonomous budget envelope into Hermes", async () => {
    const { ctx } = makeCtx();
    const envelope = {
      requestCount: 8,
      inputTokens: 64_000,
      outputTokens: 8_000,
      runtimeMs: 300_000,
      costMicrousd: 250_000,
    };
    (ctx as Record<string, unknown>).autonomousBudgetEnvelope = envelope;

    await execute(ctx as any);

    const mocked = vi.mocked(serverUtils.runChildProcess);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const args = lastCall[2] as string[];
    const opts = lastCall[3] as { env: Record<string, string> };
    expect(opts.env.HERMES_AUTONOMOUS_BUDGET_JSON).toBe(JSON.stringify(envelope));
    expect(opts.env.HERMES_RUN_RESULT_FILE).toContain("test-run-1");
    expect(args).toContain("-Q");
  });

  it("renders a bounded fresh rollover prompt without old wake or handoff bodies", async () => {
    const { ctx } = makeCtx();
    const historic = "HISTORICAL_TRANSCRIPT_MARKER ".repeat(10_000);
    (ctx as any).context = {
      issueId: "issue-1",
      wakeReason: "session_rollover_required",
      taskBody: historic,
      paperclipTaskMarkdown: historic,
      paperclipSessionHandoffMarkdown: historic,
      paperclipWake: { reason: "session_rollover_required", issue: { description: historic } },
      executionContinuation: {
        coverage: { kind: "bounded_task_capsule" },
        taskStateCapsule: {
          version: 1,
          hash: "capsule-hash",
          issueId: "issue-1",
          objective: "Finish the verified task",
          nextAction: "Read the current issue and perform one authorized next action; stop if blocked.",
          completedWork: null,
          completedActionRefs: [],
          blockers: [],
          artifactRefs: [],
          stateFingerprint: "state-one",
        },
      },
    };
    const prompt = buildPrompt(ctx as any, {}, { resumedSession: false });
    expect(prompt).toContain("capsule-hash");
    expect(prompt).toContain("issue-1");
    expect(prompt).not.toContain("HISTORICAL_TRANSCRIPT_MARKER");
    expect(prompt.length).toBeLessThan(20_000);
    const lengths: number[] = [];
    for (let cycle = 0; cycle < 10; cycle += 1) {
      (ctx as any).context.taskBody = historic + String(cycle);
      (ctx as any).context.executionContinuation.taskStateCapsule.hash = `capsule-hash-${cycle}`;
      (ctx as any).context.executionContinuation.taskStateCapsule.stateFingerprint = `state-${cycle}`;
      const nextPrompt = buildPrompt(ctx as any, {}, { resumedSession: false });
      expect(nextPrompt).not.toContain("HISTORICAL_TRANSCRIPT_MARKER");
      expect(nextPrompt.length).toBeLessThan(20_000);
      lengths.push(nextPrompt.length);
    }
    expect(new Set(lengths).size).toBe(1);
    const deliveredPrompt = buildPrompt(ctx as any, {}, { resumedSession: false });
    await execute(ctx as any);
    const calls = vi.mocked(serverUtils.runChildProcess).mock.calls;
    const args = calls[calls.length - 1]?.[2] as string[];
    expect(args[2]).toBe(deliveredPrompt);
  });

  it("fails closed when a rollover capsule is missing", () => {
    const { ctx } = makeCtx();
    (ctx as any).context.wakeReason = "session_rollover_required";
    expect(() => buildPrompt(ctx as any, {})).toThrow("session_rollover_capsule_missing");
  });

  it("fails closed when a rollover capsule exceeds the prompt boundary", () => {
    const { ctx } = makeCtx();
    (ctx as any).context.wakeReason = "session_rollover_required";
    (ctx as any).executionContinuation = {
      issueId: "issue-1",
      coverage: { kind: "bounded_task_capsule" },
      taskStateCapsule: {
        version: 1, issueId: "issue-1", hash: "hash", stateFingerprint: "state",
        objective: "x".repeat(33_000), nextAction: "Read the current issue",
        completedWork: null, completedActionRefs: [], blockers: [], artifactRefs: [],
      },
    };
    expect(() => buildPrompt(ctx as any, {})).toThrow("session_rollover_capsule_oversized");
  });

  it("rejects a rollover capsule bound to a different issue", () => {
    const { ctx } = makeCtx();
    (ctx as any).context.wakeReason = "session_rollover_required";
    (ctx as any).executionContinuation = {
      coverage: { kind: "bounded_task_capsule" },
      taskStateCapsule: {
        version: 1,
        issueId: "other-issue",
        hash: "capsule-hash",
        stateFingerprint: "state-one",
        objective: "Other issue",
        nextAction: "Read the current issue",
        completedWork: null,
        completedActionRefs: [],
        blockers: [],
        artifactRefs: [],
      },
    };
    expect(() => buildPrompt(ctx as any, {})).toThrow("session_rollover_capsule_issue_mismatch");
  });

  it("transports a typed rollover result and clears the provider session", async () => {
    vi.mocked(fs.readFile).mockImplementation(async (file) =>
      String(file).endsWith(".result.json")
        ? JSON.stringify({
            version: 1,
            failed: true,
            partial: true,
            stop_reason: "session_rollover_required",
            turn_exit_reason: "session_rollover_required",
          })
        : "",
    );
    const { ctx } = makeCtx();
    (ctx as Record<string, unknown>).autonomousBudgetEnvelope = {
      requestCount: 8,
      inputTokens: 64_000,
      outputTokens: 8_000,
      runtimeMs: 300_000,
      costMicrousd: 250_000,
    };

    const result = await execute(ctx as any);

    expect(result.errorCode).toBe("session_rollover_required");
    expect(result.clearSession).toBe(true);
    expect(result.resultJson).toMatchObject({
      turn_exit_reason: "session_rollover_required",
    });
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("omits the auto model when an explicit provider is selected", async () => {
    const { ctx } = makeCtx({ provider: "openai-codex" });

    await execute(ctx as any);

    const mocked = vi.mocked(serverUtils.runChildProcess);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const args = lastCall[2] as string[];
    expect(args).toContain("openai-codex");
    expect(args).not.toContain("auto");
  });

  it("omits worktree lifecycle output from the agent response", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "✓ Worktree created: /tmp/.worktrees/hermes-7b3bab57",
        "  Branch: hermes/hermes-7b3bab57",
        "  Base:   HEAD (local — could not reach remote)",
        "Hey Naz! How can I help?",
        "✓ Worktree cleaned up: /tmp/.worktrees/hermes-7b3bab57",
        "",
      ].join("\n"),
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.summary).toBe("Hey Naz! How can I help?");
    expect(result.resultJson).toMatchObject({
      result: "Hey Naz! How can I help?",
    });
  });

  it("preserves ordinary response lines that resemble labels", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Branch: keep this user-authored line\nBase: keep this too\n",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.summary).toBe(
      "Branch: keep this user-authored line\nBase: keep this too",
    );
  });

  it("preserves a specific stderr diagnostic for a nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: provider unavailable\n",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("reports the exit code when a nonzero exit has no diagnostic", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 130,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Hermes exited with code 130");
  });

  it("leaves timeout diagnostics to the heartbeat timeout path", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not label signal cancellation as a silent nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });
});

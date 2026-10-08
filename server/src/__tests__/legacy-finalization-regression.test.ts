import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  budgetPolicies,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeRunResults,
  projectWorkspaces,
  projects,
  statusDecisions,
  workAssessments,
  issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "Legacy adapter completed through the flag-off heartbeat.",
  resultJson: {
    summary: "Legacy bytes",
    nested: { count: 1, ok: true },
    apiCalls: 1,
    successfulProviderResponses: 1,
    usageTelemetryComplete: true,
    costStatus: "actual",
    costUnavailableReason: null,
    cost_usd: 0.000001,
    providerRequestIds: ["legacy-finalization-response"],
  },
  provider: "test",
  model: "legacy-test",
  usage: { inputTokens: 10, outputTokens: 5 },
  usageBasis: "per_run" as const,
  budgetTelemetry: {
    providerRequestId: "legacy-finalization-response",
    requestCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    runtimeMs: 100,
    costMicrousd: 1,
    rateCardVersion: "test-v1",
  },
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";

describe("P6-32 legacy finalization regression", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-legacy-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "Legacy snapshot",
      issuePrefix: "LGC",
      status: "active",
      autonomousExecutionPaused: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Legacy project", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy agent",
      adapterType: "codex_local",
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Complete through the legacy adapter",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values([
      { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);
  }, 30_000);

  afterAll(async () => {
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await temporary.cleanup();
    }
  });

  it("executes a flag-off heartbeat through the legacy adapter with byte-stable reads and zero native rows", async () => {
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
    });
    expect(queued).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runId = queued!.id;
    const publicBefore = await heartbeat.getRun(runId);

    expect(adapterExecute).toHaveBeenCalledOnce();
    expect(publicBefore).toMatchObject({
      id: runId,
      status: "succeeded",
      runtimeMode: "legacy",
      runtimeModeReason: "direct_adapter",
      resultJson: { summary: "Legacy bytes", nested: { count: 1, ok: true } },
    });
    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([]);
    expect(JSON.stringify(await heartbeat.getRun(runId))).toBe(JSON.stringify(publicBefore));

    await expect(db.select().from(completionContracts).where(eq(completionContracts.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(workAssessments).where(eq(workAssessments.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(1);
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, it, expect, vi } from "vitest";
import { agents, companies, issues, budgetPolicies, heartbeatRuns,
  agentWakeupRequests, autonomousBudgetReservations, projects, projectWorkspaces, createDb,
  startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { execute as executeHermes } from "../../../packages/adapters/hermes/src/server/execute.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const observed = vi.hoisted(() => ({ calls: 0, result: null as any, duration: 0 }));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: () => ({ supportsLocalAgentJwt: false,
    execute: async (ctx: any) => {
      if (++observed.calls > 1) throw new Error("synthetic_smoke_run_limit");
      const root = process.env.MANAGED_CONTRACT_SMOKE_ROOT;
      const cwd = ctx.context?.paperclipWorkspace?.cwd;
      if (!root || typeof cwd !== "string" || !cwd.startsWith(root + "/")) {
        throw new Error("synthetic_smoke_workspace_not_contained");
      }
      const started = performance.now();
      observed.result = await executeHermes(ctx);
      observed.duration = Math.ceil(performance.now() - started);
      return observed.result;
    },
  }) };
});

const root = process.env.MANAGED_CONTRACT_SMOKE_ROOT;
(root ? describe : describe.skip)("approved one-wake loopback managed-contract smoke", () => {
  it("correlates real transport, ledger, terminal, settlement and zero successors", async () => {
    const config = JSON.parse(await readFile(path.join(root!, "fixture.json"), "utf8"));
    expect(new URL(config.url).hostname).toBe("127.0.0.1");
    expect(config.synthetic).toBe(true);
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-managed-contract-smoke-test-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), projectId = randomUUID();
    let heartbeat: ReturnType<typeof heartbeatService> | undefined;
    let proof: Record<string, unknown> = { synthetic: true, status: "incomplete" };
    try {
      await db.insert(companies).values({ id: companyId, name: "Synthetic managed smoke",
        status: "active", autonomousExecutionPaused: false, issuePrefix: "SMOKE",
        defaultResponsibleUserId: "fixture-user", requireBoardApprovalForNewAgents: false });
      await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic Hermes",
        role: "engineer", status: "active", adapterType: "hermes_local",
        adapterConfig: config.adapterConfig,
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
      await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic fixture" });
      await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Committed fixture",
        cwd: config.adapterConfig.cwd, sourceType: "local_path", isPrimary: true });
      await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Synthetic no-progress smoke",
        status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-user" });
      const limits = { request_count: 4, input_tokens: 500000, output_tokens: 4000,
        runtime_ms: 90000, billed_microusd: 250000 };
      await db.insert(budgetPolicies).values(Object.entries(limits).flatMap(([metric, amount]) =>
        (["per_run", "lifetime"] as const).map((windowKind) => ({
          companyId, scopeType: "task", scopeId: issueId, metric, amount,
          windowKind, hardStopEnabled: true,
        }))));
      heartbeat = heartbeatService(db, { runtimeEnv: {}, verifyBudgetEvidenceForTest: (result) => {
        const evidence = result.resultJson?.durableCallEvidence as any;
        if (!evidence?.complete || evidence.requestCount !== 2 ||
            evidence.inputTokens !== 200 || evidence.outputTokens !== 40 ||
            evidence.estimatedCostUsd !== 0.00028 || evidence.externalBillingVerified !== false ||
            evidence.terminalDiscrepancies.length !== 0 ||
            evidence.rateCardSnapshots.some((rate: any) => rate.billing_base_url !== config.url)) return null;
        return { providerRequestId: evidence.providerRequestIds[0], requestCount: evidence.requestCount,
          inputTokens: evidence.inputTokens, outputTokens: evidence.outputTokens,
          runtimeMs: observed.duration, costMicrousd: 280,
          rateCardVersion: `synthetic:${evidence.rateCardSnapshots[0].rate_card_id}` };
      } });
      const wake = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system",
        reason: "issue_assigned", payload: { issueId },
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "system", requestedByActorId: "fixture", idempotencyKey: `smoke:${issueId}` });
      expect(wake).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      const reservations = await db.select().from(autonomousBudgetReservations)
        .where(eq(autonomousBudgetReservations.companyId, companyId));
      const transport = JSON.parse(await readFile(path.join(root!, "transport.json"), "utf8"));
      proof = { synthetic: true, status: "checking", companyId, agentId, issueId,
        adapterInvocations: observed.calls, adapterResult: observed.result, runs, wakes, reservations,
        transportCount: transport.length, externalProviderCharge: "none",
        syntheticEstimatedCostUsd: 0.00028 };
      await writeFile(path.join(root!, "proof.json"), JSON.stringify(proof, null, 2));
      expect(observed.calls).toBe(1);
      expect(transport).toHaveLength(2);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "failed", errorCode: "no_progress", retryOfRunId: null });
      expect(wakes).toHaveLength(1);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({ status: "reconciled", actualRequestCount: 2,
        actualInputTokens: 200, actualOutputTokens: 40, actualCostMicrousd: 280 });
      expect(observed.result.resultJson.durableCallEvidence.runId).toBe(runs[0].id);
      proof.status = "passed";
    } finally {
      await writeFile(path.join(root!, "proof.json"), JSON.stringify(proof, null, 2));
      if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await tempDb.cleanup();
    }
  }, 150000);
});

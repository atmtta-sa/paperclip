import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  closeRegisteredClients,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Authorized ORP interaction continuation completed.",
    provider: "fixture",
    model: "fixture-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({
    track: vi.fn(),
    hashPrivateRef: vi.fn(() => "fixture-private-reference"),
  }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.ts";
import { queueResolvedInteractionContinuationWakeup } from "../routes/issues.ts";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = embeddedSupport.supported ? describe : describe.skip;

async function waitForInteractionRun(
  db: ReturnType<typeof createDb>,
  interactionId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matching = (await db.select().from(heartbeatRuns)).filter(
      (run) =>
        (run.contextSnapshot as Record<string, unknown> | null)?.interactionId ===
        interactionId,
    );
    if (matching.length === 1 && !["queued", "running"].includes(matching[0]!.status)) {
      return matching[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for exactly one terminal interaction run");
}

describePostgres("authorized interaction resolution continuity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-interaction-continuity-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    if (externalTestDatabaseUrl) {
      await closeRegisteredClients(externalTestDatabaseUrl);
    }
    await tempDb?.cleanup();
  });

  it("does not wake while pending and creates one successful continuation after authorized resolution", async () => {
    const userId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `F${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(authUsers).values({
      id: userId,
      name: "Authorized Fixture User",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "ORP Resolution Fixture",
      issuePrefix,
      defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ORP Fixture Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resolve the synthetic ORP decision",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: userId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const interactions = issueThreadInteractionService(db);
    const pending = await interactions.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        resolverPolicy: "human_only",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Authorize the synthetic continuation?" },
      },
      { agentId },
    );

    expect(pending.status).toBe("pending");
    expect(pending.effectiveResolverPolicy).toBe("human_only");
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);

    const resolution = await interactions.acceptInteraction(
      { id: issueId, companyId, projectId: null, goalId: null },
      pending.id,
      {},
      { userId },
    );
    const resolved = resolution.interaction;
    expect(resolved.status).toBe("accepted");
    expect(resolved.resolvedByUserId).toBe(userId);

    const heartbeat = heartbeatService(db);
    const wakeInput = {
      db,
      heartbeat,
      issue: { id: issueId, companyId, assigneeAgentId: agentId, status: "in_progress" },
      interaction: resolved,
      actor: { actorType: "user" as const, actorId: userId },
      source: "fixture.authorized_resolution",
    };
    await queueResolvedInteractionContinuationWakeup(wakeInput);

    const run = await waitForInteractionRun(db, pending.id);
    await heartbeat.drainActiveRunExecutions();
    const wakes = (await db.select().from(agentWakeupRequests)).filter(
      (wake) =>
        (wake.payload as Record<string, unknown> | null)?.interactionId === pending.id,
    );
    const runs = (await db.select().from(heartbeatRuns)).filter(
      (candidate) =>
        (candidate.contextSnapshot as Record<string, unknown> | null)?.interactionId ===
        pending.id,
    );
    const result = run.resultJson as Record<string, unknown> | null;

    expect(wakes).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "completed", runId: run.id });
    expect(run.status).toBe("succeeded");
    expect(result?.summary).toBe(
      "Authorized ORP interaction continuation completed.",
    );
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    console.log(
      JSON.stringify({
        pending: {
          interactionId: pending.id,
          resolverPolicy: pending.effectiveResolverPolicy,
          wakeCount: 0,
          runCount: 0,
        },
        resolved: {
          status: resolved.status,
          resolvedByUserId: resolved.resolvedByUserId,
          wakeCount: wakes.length,
          runCount: runs.length,
          wakeId: wakes[0]!.id,
          runId: run.id,
          runStatus: run.status,
          output: result?.summary,
          adapterExecutions: mockAdapterExecute.mock.calls.length,
        },
      }),
    );
  }, 20_000);
});

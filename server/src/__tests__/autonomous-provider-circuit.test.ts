import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  autonomousBudgetReservations,
  autonomousProviderCircuits,
  budgetPolicies,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  acquireAutonomousProviderCircuitPermit,
  recordAutonomousProviderCircuitOutcome,
} from "../services/autonomous-provider-circuit.js";
import { reserveAutonomousBudget } from "../services/autonomous-budget-reservations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OPEN_COOLDOWN_MS = 5 * 60_000;

describeEmbeddedPostgres("autonomous provider circuit", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-circuit-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Provider circuit company",
      autonomousExecutionPaused: false,
      issuePrefix: `PC${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("denies provider admission while the circuit is open", async () => {
    const companyId = await createCompany();
    const openedAt = new Date("2026-09-28T12:00:00.000Z");
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: null,
    };

    await recordAutonomousProviderCircuitOutcome(db, {
      ...scope,
      runId: randomUUID(),
      outcome: "transient_failure",
      now: openedAt,
    });
    await recordAutonomousProviderCircuitOutcome(db, {
      ...scope,
      runId: randomUUID(),
      outcome: "transient_failure",
      now: openedAt,
    });

    const admission = await acquireAutonomousProviderCircuitPermit(db, {
      ...scope,
      runId: randomUUID(),
      now: new Date(openedAt.getTime() + OPEN_COOLDOWN_MS - 1),
    });

    expect(admission).toMatchObject({
      admitted: false,
      reason: "provider_circuit_open",
    });
    const [circuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(circuit).toMatchObject({
      state: "open",
      consecutiveFailureCount: 2,
      probeRunId: null,
    });
  });

  it("admits exactly one half-open probe after cooldown", async () => {
    const companyId = await createCompany();
    const openedAt = new Date("2026-09-28T13:00:00.000Z");
    const dueAt = new Date(openedAt.getTime() + OPEN_COOLDOWN_MS);
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: "credential-hash",
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordAutonomousProviderCircuitOutcome(db, {
        ...scope,
        runId: randomUUID(),
        outcome: "transient_failure",
        now: openedAt,
      });
    }

    const runIds = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      runIds.map((runId) =>
        acquireAutonomousProviderCircuitPermit(db, {
          ...scope,
          runId,
          now: dueAt,
        }),
      ),
    );

    const admitted = results.filter((result) => result.admitted);
    const denied = results.filter((result) => !result.admitted);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ admitted: true, mode: "half_open_probe" });
    expect(denied).toEqual([
      expect.objectContaining({
        admitted: false,
        reason: "provider_circuit_probe_in_flight",
      }),
    ]);

    const [circuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(circuit).toMatchObject({
      state: "half_open",
      probeRunId: runIds.find((runId) =>
        admitted.some((result) => result.admitted && result.runId === runId),
      ),
    });
  });

  it("opens immediately for provider quota and preserves Retry-After", async () => {
    const companyId = await createCompany();
    const now = new Date("2026-09-28T14:00:00.000Z");
    const retryNotBefore = new Date(now.getTime() + 30 * 60_000);
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: null,
    };

    await recordAutonomousProviderCircuitOutcome(db, {
      ...scope,
      runId: randomUUID(),
      outcome: "provider_quota",
      retryNotBefore,
      now,
    });

    const admission = await acquireAutonomousProviderCircuitPermit(db, {
      ...scope,
      runId: randomUUID(),
      now: new Date(now.getTime() + OPEN_COOLDOWN_MS),
    });
    expect(admission).toEqual({
      admitted: false,
      reason: "provider_circuit_open",
      retryAt: retryNotBefore,
    });
  });

  it("closes only from verified success by the claimed half-open probe", async () => {
    const companyId = await createCompany();
    const openedAt = new Date("2026-09-28T15:00:00.000Z");
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: null,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordAutonomousProviderCircuitOutcome(db, {
        ...scope,
        runId: randomUUID(),
        outcome: "transient_failure",
        now: openedAt,
      });
    }
    const probeRunId = randomUUID();
    await acquireAutonomousProviderCircuitPermit(db, {
      ...scope,
      runId: probeRunId,
      now: new Date(openedAt.getTime() + OPEN_COOLDOWN_MS),
    });

    await recordAutonomousProviderCircuitOutcome(db, {
      ...scope,
      runId: randomUUID(),
      outcome: "verified_success",
      now: new Date(openedAt.getTime() + OPEN_COOLDOWN_MS + 1),
    });
    let [circuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(circuit.state).toBe("half_open");

    await recordAutonomousProviderCircuitOutcome(db, {
      ...scope,
      runId: probeRunId,
      outcome: "verified_success",
      now: new Date(openedAt.getTime() + OPEN_COOLDOWN_MS + 2),
    });
    [circuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(circuit).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 0,
      probeRunId: null,
      lastSuccessRunId: probeRunId,
    });
  });

  it("reopens when the claimed half-open probe fails", async () => {
    const companyId = await createCompany();
    const openedAt = new Date("2026-09-28T16:00:00.000Z");
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: null,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordAutonomousProviderCircuitOutcome(db, {
        ...scope,
        runId: randomUUID(),
        outcome: "transient_failure",
        now: openedAt,
      });
    }
    const probeAt = new Date(openedAt.getTime() + OPEN_COOLDOWN_MS);
    const probeRunId = randomUUID();
    await acquireAutonomousProviderCircuitPermit(db, {
      ...scope,
      runId: probeRunId,
      now: probeAt,
    });

    await recordAutonomousProviderCircuitOutcome(db, {
      ...scope,
      runId: probeRunId,
      outcome: "transient_failure",
      now: probeAt,
    });

    const [circuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(circuit).toMatchObject({
      state: "open",
      probeRunId: null,
      nextProbeAt: new Date(probeAt.getTime() + OPEN_COOLDOWN_MS),
    });
  });

  it("reopens an inconclusive half-open probe without counting a provider failure", async () => {
    const companyId = await createCompany();
    const openedAt = new Date("2026-09-28T16:30:00.000Z");
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: null,
    };
    let lastFailureRunId = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastFailureRunId = randomUUID();
      await recordAutonomousProviderCircuitOutcome(db, {
        ...scope,
        runId: lastFailureRunId,
        outcome: "transient_failure",
        now: openedAt,
      });
    }
    const probeAt = new Date(openedAt.getTime() + OPEN_COOLDOWN_MS);
    const probeRunId = randomUUID();
    await acquireAutonomousProviderCircuitPermit(db, {
      ...scope,
      runId: probeRunId,
      now: probeAt,
    });

    await recordAutonomousProviderCircuitOutcome(db, {
      ...scope,
      runId: probeRunId,
      outcome: "probe_inconclusive",
      now: probeAt,
    });

    const [circuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(circuit).toMatchObject({
      state: "open",
      consecutiveFailureCount: 2,
      lastFailureRunId,
      probeRunId: null,
      nextProbeAt: new Date(probeAt.getTime() + OPEN_COOLDOWN_MS),
    });
  });

  it("denies budget reservation atomically when the provider circuit is open", async () => {
    const companyId = await createCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Provider circuit agent",
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Provider circuit admission",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values([
      { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: null,
    };
    const openedAt = new Date("2026-09-28T17:00:00.000Z");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordAutonomousProviderCircuitOutcome(db, {
        ...scope,
        runId: randomUUID(),
        outcome: "transient_failure",
        now: openedAt,
      });
    }

    const result = await reserveAutonomousBudget(db, {
      companyId,
      agentId,
      issueId,
      runId: randomUUID(),
      provider: scope.provider,
      credentialIdentifierHash: scope.credentialIdentifierHash,
    });

    expect(result).toMatchObject({
      admitted: false,
      reason: "provider_circuit_open",
    });
    expect(
      await db
        .select()
        .from(autonomousBudgetReservations)
        .where(eq(autonomousBudgetReservations.companyId, companyId)),
    ).toHaveLength(0);
  });

  it("does not strand a due probe when budget admission is denied", async () => {
    const companyId = await createCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget denied probe agent",
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Budget denied provider probe",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values([
      { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "per_run", amount: 0 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);
    const scope = {
      companyId,
      provider: "openai-codex",
      credentialIdentifierHash: null,
    };
    const openedAt = new Date("2020-01-01T00:00:00.000Z");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordAutonomousProviderCircuitOutcome(db, {
        ...scope,
        runId: randomUUID(),
        outcome: "transient_failure",
        now: openedAt,
      });
    }

    const result = await reserveAutonomousBudget(db, {
      companyId,
      agentId,
      issueId,
      runId: randomUUID(),
      provider: scope.provider,
      credentialIdentifierHash: scope.credentialIdentifierHash,
    });

    expect(result).toMatchObject({ admitted: false, reason: "task_budget_exhausted" });
    const [circuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(circuit).toMatchObject({ state: "open", probeRunId: null });
    expect(
      await db
        .select()
        .from(autonomousBudgetReservations)
        .where(eq(autonomousBudgetReservations.companyId, companyId)),
    ).toHaveLength(0);
  });
});

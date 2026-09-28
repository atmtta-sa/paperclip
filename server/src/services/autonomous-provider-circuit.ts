import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { autonomousProviderCircuits, companies } from "@paperclipai/db";

export const AUTONOMOUS_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = 2;
export const AUTONOMOUS_PROVIDER_CIRCUIT_OPEN_COOLDOWN_MS = 5 * 60_000;

const DEFAULT_CREDENTIAL_SCOPE = "default";

type ProviderCircuitScope = {
  companyId: string;
  provider: string;
  credentialIdentifierHash?: string | null;
};

type ProviderCircuitRun = ProviderCircuitScope & {
  runId: string;
  now?: Date;
};

type ProviderCircuitTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function normalizeScope(input: ProviderCircuitScope) {
  const provider = input.provider.trim().toLowerCase();
  if (!provider) throw new Error("autonomous_provider_circuit_provider_missing");
  const credentialIdentifierHash = input.credentialIdentifierHash?.trim();
  return {
    companyId: input.companyId,
    provider,
    credentialIdentifierHash: credentialIdentifierHash
      ? `hash:${credentialIdentifierHash}`
      : DEFAULT_CREDENTIAL_SCOPE,
  };
}

function scopeWhere(scope: ReturnType<typeof normalizeScope>) {
  return and(
    eq(autonomousProviderCircuits.companyId, scope.companyId),
    eq(autonomousProviderCircuits.provider, scope.provider),
    eq(
      autonomousProviderCircuits.credentialIdentifierHash,
      scope.credentialIdentifierHash,
    ),
  );
}

async function lockCompany(
  tx: ProviderCircuitTransaction,
  companyId: string,
) {
  const company = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!company) throw new Error("autonomous_provider_circuit_company_missing");
}

export async function acquireAutonomousProviderCircuitPermitWithLockedCompany(
  tx: ProviderCircuitTransaction,
  input: ProviderCircuitRun,
): Promise<
  | { admitted: true; mode: "closed" | "half_open_probe"; runId: string }
  | {
      admitted: false;
      reason: "provider_circuit_open" | "provider_circuit_probe_in_flight";
      retryAt: Date | null;
    }
> {
  const scope = normalizeScope(input);
  const now = input.now ?? new Date();
  const circuit = await tx
    .select()
    .from(autonomousProviderCircuits)
    .where(scopeWhere(scope))
    .then((rows) => rows[0] ?? null);

  if (!circuit) {
    await tx.insert(autonomousProviderCircuits).values(scope);
    return { admitted: true as const, mode: "closed" as const, runId: input.runId };
  }
  if (circuit.state === "closed") {
    return { admitted: true as const, mode: "closed" as const, runId: input.runId };
  }
  if (circuit.state === "half_open") {
    if (circuit.probeRunId === input.runId) {
      return {
        admitted: true as const,
        mode: "half_open_probe" as const,
        runId: input.runId,
      };
    }
    return {
      admitted: false as const,
      reason: "provider_circuit_probe_in_flight" as const,
      retryAt: circuit.nextProbeAt,
    };
  }
  if (circuit.nextProbeAt && now.getTime() < circuit.nextProbeAt.getTime()) {
    return {
      admitted: false as const,
      reason: "provider_circuit_open" as const,
      retryAt: circuit.nextProbeAt,
    };
  }

  await tx
    .update(autonomousProviderCircuits)
    .set({
      state: "half_open",
      probeRunId: input.runId,
      probeClaimedAt: now,
      updatedAt: now,
    })
    .where(eq(autonomousProviderCircuits.id, circuit.id));
  return {
    admitted: true as const,
    mode: "half_open_probe" as const,
    runId: input.runId,
  };
}

export async function acquireAutonomousProviderCircuitPermit(
  db: Db,
  input: ProviderCircuitRun,
) {
  return db.transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    return acquireAutonomousProviderCircuitPermitWithLockedCompany(tx, input);
  });
}

export async function recordAutonomousProviderCircuitOutcome(
  db: Db,
  input: ProviderCircuitRun & {
    outcome:
      | "transient_failure"
      | "provider_quota"
      | "verified_success"
      | "probe_inconclusive";
    retryNotBefore?: Date | null;
  },
) {
  const scope = normalizeScope(input);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockCompany(tx, scope.companyId);
    const circuit = await tx
      .select()
      .from(autonomousProviderCircuits)
      .where(scopeWhere(scope))
      .then((rows) => rows[0] ?? null);

    if (input.outcome === "verified_success") {
      if (!circuit || circuit.state === "open") return circuit;
      if (circuit.state === "half_open" && circuit.probeRunId !== input.runId) {
        return circuit;
      }
      return tx
        .update(autonomousProviderCircuits)
        .set({
          state: "closed",
          consecutiveFailureCount: 0,
          openedAt: null,
          nextProbeAt: null,
          probeRunId: null,
          probeClaimedAt: null,
          lastSuccessRunId: input.runId,
          updatedAt: now,
        })
        .where(eq(autonomousProviderCircuits.id, circuit.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    if (input.outcome === "probe_inconclusive") {
      if (
        !circuit ||
        circuit.state !== "half_open" ||
        circuit.probeRunId !== input.runId
      ) {
        return circuit;
      }
      const nextProbeAt = new Date(
        Math.max(
          now.getTime() + AUTONOMOUS_PROVIDER_CIRCUIT_OPEN_COOLDOWN_MS,
          circuit.nextProbeAt?.getTime() ?? 0,
        ),
      );
      return tx
        .update(autonomousProviderCircuits)
        .set({
          state: "open",
          openedAt: now,
          nextProbeAt,
          probeRunId: null,
          probeClaimedAt: null,
          updatedAt: now,
        })
        .where(eq(autonomousProviderCircuits.id, circuit.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    if (circuit?.lastFailureRunId === input.runId) return circuit;
    if (circuit?.state === "half_open" && circuit.probeRunId !== input.runId) {
      return circuit;
    }
    const failureCount = (circuit?.consecutiveFailureCount ?? 0) + 1;
    const opens = input.outcome === "provider_quota" ||
      circuit?.state === "half_open" ||
      circuit?.state === "open" ||
      failureCount >= AUTONOMOUS_PROVIDER_CIRCUIT_FAILURE_THRESHOLD;
    const retryCandidates = [
      new Date(now.getTime() + AUTONOMOUS_PROVIDER_CIRCUIT_OPEN_COOLDOWN_MS),
      circuit?.nextProbeAt ?? null,
      input.retryNotBefore ?? null,
    ].filter((value): value is Date => value instanceof Date);
    const nextProbeAt = opens
      ? new Date(Math.max(...retryCandidates.map((value) => value.getTime())))
      : null;

    if (!circuit) {
      return tx
        .insert(autonomousProviderCircuits)
        .values({
          ...scope,
          state: opens ? "open" : "closed",
          consecutiveFailureCount: failureCount,
          openedAt: opens ? now : null,
          nextProbeAt,
          lastFailureRunId: input.runId,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
    }

    return tx
      .update(autonomousProviderCircuits)
      .set({
        state: opens ? "open" : "closed",
        consecutiveFailureCount: failureCount,
        openedAt: opens ? now : circuit.openedAt,
        nextProbeAt,
        probeRunId: null,
        probeClaimedAt: null,
        lastFailureRunId: input.runId,
        updatedAt: now,
      })
      .where(eq(autonomousProviderCircuits.id, circuit.id))
      .returning()
      .then((rows) => rows[0] ?? null);
  });
}

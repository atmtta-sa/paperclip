import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { autonomousBudgetReservations, companies } from "@paperclipai/db";
import { recordAutonomousPromptGrowthAlert } from "./autonomous-prompt-growth-alert.js";

export type AutonomousBudgetReconciliationInput = {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  providerActivityOccurred: boolean;
  verifiedNoProviderActivity?: boolean;
  providerRequestId: string | null;
  actual: {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    runtimeMs: number;
    costMicrousd?: number;
    costCents?: number;
  } | null;
  provider?: string | null;
  model?: string | null;
  rateCardVersion?: string | null;
};

type NormalizedActual = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  runtimeMs: number;
  costMicrousd: number;
};

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("autonomous_budget_reservation_invalid_amount");
  }
  return value;
}

function normalizeActual(
  actual: NonNullable<AutonomousBudgetReconciliationInput["actual"]>,
): NormalizedActual {
  const explicitMicrousd =
    actual.costMicrousd === undefined ? null : nonNegativeInteger(actual.costMicrousd);
  const legacyMicrousd =
    actual.costCents === undefined ? null : nonNegativeInteger(actual.costCents) * 10_000;
  if (explicitMicrousd === null && legacyMicrousd === null) {
    throw new Error("autonomous_budget_reservation_invalid_amount");
  }
  if (
    explicitMicrousd !== null &&
    legacyMicrousd !== null &&
    explicitMicrousd !== legacyMicrousd
  ) {
    throw new Error("autonomous_budget_reservation_conflicting_cost_units");
  }
  return {
    requestCount: nonNegativeInteger(actual.requestCount),
    inputTokens: nonNegativeInteger(actual.inputTokens),
    outputTokens: nonNegativeInteger(actual.outputTokens),
    runtimeMs: nonNegativeInteger(actual.runtimeMs),
    costMicrousd: explicitMicrousd ?? legacyMicrousd!,
  };
}

function reconciliationMatches(
  row: typeof autonomousBudgetReservations.$inferSelect,
  input: AutonomousBudgetReconciliationInput,
  actual: NormalizedActual | null,
  status: "reconciled" | "retained_missing_telemetry" | "released",
): boolean {
  return (
    row.status === status &&
    row.providerActivityOccurred === input.providerActivityOccurred &&
    row.providerRequestId === input.providerRequestId &&
    row.actualRequestCount === (actual?.requestCount ?? null) &&
    row.actualInputTokens === (actual?.inputTokens ?? null) &&
    row.actualOutputTokens === (actual?.outputTokens ?? null) &&
    row.actualRuntimeMs === (actual?.runtimeMs ?? null) &&
    row.actualCostMicrousd === (actual?.costMicrousd ?? null)
  );
}

export async function reconcileAutonomousBudget(
  db: Db,
  input: AutonomousBudgetReconciliationInput,
): Promise<{ status: "reconciled" | "retained_missing_telemetry" | "released"; replayed: boolean }> {
  const actual = input.actual ? normalizeActual(input.actual) : null;
  const hasCompleteTelemetry =
    input.providerActivityOccurred && actual !== null && Boolean(input.providerRequestId?.trim());
  const verifiedNoProviderActivity =
    input.verifiedNoProviderActivity === true &&
    !input.providerActivityOccurred &&
    actual === null &&
    input.providerRequestId === null;
  const status = verifiedNoProviderActivity
    ? "released"
    : hasCompleteTelemetry
      ? "reconciled"
      : "retained_missing_telemetry";

  return db.transaction(async (tx) => {
    // Match admission's lock order and serialize cross-run alert deduplication.
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, input.companyId)).for("update");
    if (!company) throw new Error("autonomous_budget_reconciliation_scope_mismatch");
    const row = await tx
      .select()
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, input.runId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("autonomous_budget_reservation_not_found");
    if (
      row.companyId !== input.companyId ||
      row.agentId !== input.agentId ||
      row.issueId !== input.issueId
    ) {
      throw new Error("autonomous_budget_reconciliation_scope_mismatch");
    }
    if (input.provider !== undefined && row.provider !== input.provider) {
      throw new Error("autonomous_budget_reconciliation_provider_mismatch");
    }
    if (input.model !== undefined && row.model !== input.model) {
      throw new Error("autonomous_budget_reconciliation_model_mismatch");
    }
    if (row.status !== "reserved") {
      if (reconciliationMatches(row, input, actual, status)) {
        return { status, replayed: true };
      }
      throw new Error("autonomous_budget_reconciliation_conflict");
    }

    await tx
      .update(autonomousBudgetReservations)
      .set({
        status,
        providerActivityOccurred: input.providerActivityOccurred,
        providerRequestId: input.providerRequestId,
        actualRequestCount: hasCompleteTelemetry ? actual.requestCount : null,
        actualInputTokens: hasCompleteTelemetry ? actual.inputTokens : null,
        actualOutputTokens: hasCompleteTelemetry ? actual.outputTokens : null,
        actualRuntimeMs: hasCompleteTelemetry ? actual.runtimeMs : null,
        actualCostCents: hasCompleteTelemetry
          ? Math.ceil(actual.costMicrousd / 10_000)
          : null,
        actualCostMicrousd: hasCompleteTelemetry ? actual.costMicrousd : null,
        rateCardVersion: input.rateCardVersion ?? row.rateCardVersion,
        reconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(autonomousBudgetReservations.id, row.id));

    if (hasCompleteTelemetry) await recordAutonomousPromptGrowthAlert(tx, row, actual);

    return { status, replayed: false };
  });
}

import { and, eq, inArray } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
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
    runtimeMs: number | null;
    costMicrousd?: number | null;
    costCents?: number;
  } | null;
  provider?: string | null;
  model?: string | null;
  billingMode?: "metered_currency" | "subscription_included";
  rateCardVersion?: string | null;
  settlementEvidence?: {
    source: string;
    contractVersion: number;
    runId: string;
    digestSha256: string;
    costBasis: string;
    runtimeBasis: string | null;
    runtimeApplicability?: string | null;
    billingMode?: string;
    routePolicyId?: string;
    routePolicyVersion?: number;
    routePolicyDigest?: string;
    credentialPrincipalId?: string;
    rootChainRequestLimit?: number;
    tokenAccountingBasis?: string;
  } | null;
};

type NormalizedActual = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  runtimeMs: number | null;
  costMicrousd: number | null;
};

type SettlementState = NonNullable<
  typeof autonomousBudgetReservations.$inferSelect.settlementState
>;

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("autonomous_budget_reservation_invalid_amount");
  }
  return value;
}

function normalizeActual(
  actual: NonNullable<AutonomousBudgetReconciliationInput["actual"]>,
  billingMode: "metered_currency" | "subscription_included",
): NormalizedActual {
  const explicitMicrousd =
    actual.costMicrousd == null ? null : nonNegativeInteger(actual.costMicrousd);
  const legacyMicrousd =
    actual.costCents === undefined ? null : nonNegativeInteger(actual.costCents) * 10_000;
  if (billingMode === "subscription_included") {
    if (explicitMicrousd !== null || legacyMicrousd !== null) {
      throw new Error("autonomous_budget_subscription_monetary_amount_forbidden");
    }
    return {
      requestCount: nonNegativeInteger(actual.requestCount),
      inputTokens: nonNegativeInteger(actual.inputTokens),
      outputTokens: nonNegativeInteger(actual.outputTokens),
      runtimeMs: actual.runtimeMs === null ? null : nonNegativeInteger(actual.runtimeMs),
      costMicrousd: null,
    };
  }
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
  if (actual.runtimeMs === null) {
    throw new Error("autonomous_budget_reservation_invalid_amount");
  }
  return {
    requestCount: nonNegativeInteger(actual.requestCount),
    inputTokens: nonNegativeInteger(actual.inputTokens),
    outputTokens: nonNegativeInteger(actual.outputTokens),
    runtimeMs: nonNegativeInteger(actual.runtimeMs),
    costMicrousd: explicitMicrousd ?? legacyMicrousd!,
  };
}

function hasCompleteSubscriptionPolicyEvidence(
  evidence: AutonomousBudgetReconciliationInput["settlementEvidence"],
  runId: string,
): boolean {
  return evidence?.source === "hermes_sqlite_transport_owner" &&
    evidence.contractVersion === 3 &&
    evidence.runId === runId &&
    /^[a-f0-9]{64}$/.test(evidence.digestSha256) &&
    evidence.costBasis === "subscription_included" &&
    evidence.billingMode === "subscription_included" &&
    typeof evidence.routePolicyId === "string" && evidence.routePolicyId.length > 0 &&
    Number.isSafeInteger(evidence.routePolicyVersion) && evidence.routePolicyVersion! > 0 &&
    typeof evidence.routePolicyDigest === "string" &&
    /^[a-f0-9]{64}$/.test(evidence.routePolicyDigest) &&
    typeof evidence.credentialPrincipalId === "string" &&
    evidence.credentialPrincipalId.length > 0 &&
    Number.isSafeInteger(evidence.rootChainRequestLimit) && evidence.rootChainRequestLimit! > 0 &&
    evidence.tokenAccountingBasis === "provider_reported_tokens_v1";
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
    row.actualCostMicrousd === (actual?.costMicrousd ?? null) &&
    isDeepStrictEqual(row.settlementEvidence ?? null, input.settlementEvidence ?? null)
  );
}

function deriveSettlementState(
  row: typeof autonomousBudgetReservations.$inferSelect,
  actual: NormalizedActual | null,
  hasCompleteTelemetry: boolean,
  verifiedNoProviderActivity: boolean,
): SettlementState {
  if (verifiedNoProviderActivity) return "released_zero_usage";
  if (!hasCompleteTelemetry || !actual) return "uncertain_requires_reconciliation";
  const runtimeOver = actual.runtimeMs !== null && actual.runtimeMs > row.reservedRuntimeMs;
  const runtimeUnder = actual.runtimeMs !== null && actual.runtimeMs < row.reservedRuntimeMs;
  if (
    actual.requestCount > row.reservedRequestCount ||
    actual.inputTokens > row.reservedInputTokens ||
    actual.outputTokens > row.reservedOutputTokens ||
    runtimeOver ||
    (actual.costMicrousd !== null && actual.costMicrousd > (row.reservedCostMicrousd ?? 0))
  ) return "consumed_over_reservation";
  if (
    actual.requestCount < row.reservedRequestCount ||
    actual.inputTokens < row.reservedInputTokens ||
    actual.outputTokens < row.reservedOutputTokens ||
    runtimeUnder ||
    (actual.costMicrousd !== null && actual.costMicrousd < (row.reservedCostMicrousd ?? 0))
  ) return "partially_consumed";
  return "consumed";
}

export async function reconcileAutonomousBudget(
  db: Db,
  input: AutonomousBudgetReconciliationInput,
): Promise<{
  status: "reconciled" | "retained_missing_telemetry" | "released";
  settlementState: SettlementState;
  replayed: boolean;
  rootChainCommittedRequests: number;
}> {
  const billingMode = input.billingMode ?? "metered_currency";
  const actual = input.actual ? normalizeActual(input.actual, billingMode) : null;
  const runtimeUnavailable = billingMode === "subscription_included" &&
    input.settlementEvidence?.contractVersion === 3 &&
    input.settlementEvidence.runtimeBasis === null &&
    input.settlementEvidence.runtimeApplicability === "unavailable_by_route";
  if (actual?.runtimeMs === null && !runtimeUnavailable) {
    throw new Error("autonomous_budget_reservation_invalid_amount");
  }
  const hasCompleteTelemetry =
    input.providerActivityOccurred && actual !== null && Boolean(input.providerRequestId?.trim()) &&
    (billingMode !== "subscription_included" ||
      hasCompleteSubscriptionPolicyEvidence(input.settlementEvidence, input.runId));
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
    if (row.billingMode !== billingMode) {
      throw new Error("autonomous_budget_reconciliation_billing_mode_mismatch");
    }
    if (billingMode === "subscription_included" && input.settlementEvidence) {
      // Route-policy identity is checked only against concrete evidence fields.
      // Absent or incomplete evidence (e.g. unresolved post-dispatch attempts) is
      // not an identity mismatch: it retains the reservation as uncertain below.
      const fields = [
        ["billing_mode", input.settlementEvidence.billingMode, billingMode],
        ["route_policy_id", input.settlementEvidence.routePolicyId, row.routePolicyId],
        ["route_policy_version", input.settlementEvidence.routePolicyVersion, row.routePolicyVersion],
        ["route_policy_digest", input.settlementEvidence.routePolicyDigest, row.routePolicyDigest],
        ["credential_principal_id", input.settlementEvidence.credentialPrincipalId, row.credentialPrincipalId],
        ["root_chain_request_limit", input.settlementEvidence.rootChainRequestLimit, row.rootChainRequestLimit],
      ] as const;
      const mismatch = fields.find(([, evidenceValue, storedValue]) =>
        evidenceValue !== undefined && evidenceValue !== storedValue);
      if (mismatch) {
        throw new Error(`autonomous_budget_reconciliation_route_policy_mismatch:${mismatch[0]}`);
      }
    }
    const settlementState = deriveSettlementState(
      row,
      actual,
      hasCompleteTelemetry,
      verifiedNoProviderActivity,
    );
    // Cumulative root-chain consumption: reserved requests stand in for
    // consumption until reconciled actuals replace them (conservative).
    // Read after any state transition so first settlement and replay expose
    // the same post-settlement total.
    const readRootChainCommittedRequests = async () => {
      const chainRows = row.chainRootRunId
        ? await tx
            .select({
              status: autonomousBudgetReservations.status,
              reservedRequestCount: autonomousBudgetReservations.reservedRequestCount,
              actualRequestCount: autonomousBudgetReservations.actualRequestCount,
            })
            .from(autonomousBudgetReservations)
            .where(
              and(
                eq(autonomousBudgetReservations.companyId, input.companyId),
                eq(autonomousBudgetReservations.chainRootRunId, row.chainRootRunId),
                inArray(autonomousBudgetReservations.status, [
                  "reserved",
                  "reconciled",
                  "retained_missing_telemetry",
                ]),
              ),
            )
        : [];
      return chainRows.reduce(
        (total, chainRow) =>
          total + (chainRow.status === "reconciled"
            ? chainRow.actualRequestCount ?? chainRow.reservedRequestCount
            : chainRow.reservedRequestCount),
        0,
      );
    };
    const recoveringAuthoritativeTelemetry =
      row.status === "retained_missing_telemetry" &&
      row.settlementState === "uncertain_requires_reconciliation" &&
      status === "reconciled" &&
      hasCompleteTelemetry;
    if (row.status !== "reserved" && !recoveringAuthoritativeTelemetry) {
      if (
        reconciliationMatches(row, input, actual, status) &&
        row.settlementState === settlementState
      ) {
        const rootChainCommittedRequests = await readRootChainCommittedRequests();
        return { status, settlementState, replayed: true, rootChainCommittedRequests };
      }
      throw new Error("autonomous_budget_reconciliation_conflict");
    }

    await tx
      .update(autonomousBudgetReservations)
      .set({
        status,
        settlementState,
        providerActivityOccurred: input.providerActivityOccurred,
        providerRequestId: input.providerRequestId,
        actualRequestCount: hasCompleteTelemetry ? actual.requestCount : null,
        actualInputTokens: hasCompleteTelemetry ? actual.inputTokens : null,
        actualOutputTokens: hasCompleteTelemetry ? actual.outputTokens : null,
        actualRuntimeMs: hasCompleteTelemetry ? actual.runtimeMs : null,
        actualCostCents: hasCompleteTelemetry && actual.costMicrousd !== null
          ? Math.ceil(actual.costMicrousd / 10_000) : null,
        actualCostMicrousd: hasCompleteTelemetry ? actual.costMicrousd : null,
        overrunInputTokens: hasCompleteTelemetry
          ? Math.max(0, actual.inputTokens - row.reservedInputTokens)
          : 0,
        rateCardVersion: input.rateCardVersion ?? row.rateCardVersion,
        settlementEvidence: input.settlementEvidence ?? null,
        reconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(autonomousBudgetReservations.id, row.id));

    if (hasCompleteTelemetry) await recordAutonomousPromptGrowthAlert(tx, row, actual);

    const rootChainCommittedRequests = await readRootChainCommittedRequests();
    return { status, settlementState, replayed: false, rootChainCommittedRequests };
  });
}

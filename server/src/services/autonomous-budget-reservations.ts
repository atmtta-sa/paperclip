import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  autonomousBudgetReservations,
  budgetIncidents,
  budgetPolicies,
  companies,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { BudgetMetric, BudgetScopeType, BudgetWindowKind } from "@paperclipai/shared";
import { recordAutonomousCostVelocityAlert } from "./autonomous-cost-velocity-alert.js";
import { acquireAutonomousProviderCircuitPermitWithLockedCompany } from "./autonomous-provider-circuit.js";
import { lockEligibleAutomaticSuccessorLaunchSettlement } from "./automatic-successor-settlement.js";

export type AutonomousBudgetRequest = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  runtimeMs: number;
  costMicrousd?: number;
  costCents?: number;
};

export type AutonomousBudgetEnvelope = Omit<
  AutonomousBudgetRequest,
  "costMicrousd" | "costCents"
> & { costMicrousd: number | null };

type NormalizedAutonomousBudgetRequest = AutonomousBudgetEnvelope;

export type AutonomousBudgetReservationInput = {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  previousRunId?: string | null;
  requested?: AutonomousBudgetRequest;
  provider?: string | null;
  model?: string | null;
  credentialIdentifierHash?: string | null;
  rateCardVersion?: string | null;
  billingPolicy?: {
    policyId: string;
    policyVersion: number;
    policyDigest: string;
    billingMode: "metered_currency" | "subscription_included";
    credentialPrincipalId: string;
    maxRootChainProviderRequests: number;
  } | null;
};

export type BudgetBlockReason =
  | "company_budget_exhausted"
  | "agent_budget_exhausted"
  | "task_budget_exhausted";

const UTILIZATION_THRESHOLDS = [50, 75, 90, 100] as const;

function incidentWindow(windowKind: BudgetWindowKind, now: Date): { start: Date; end: Date } {
  if (windowKind === "calendar_day_utc") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
  }
  if (windowKind === "calendar_month_utc") {
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1)),
      end: new Date(Date.UTC(9999, 0, 1)),
    };
  }
  return { start: now, end: new Date(now.getTime() + 1) };
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("autonomous_budget_reservation_invalid_amount");
  }
  return value;
}

function normalizeBudgetRequest(
  requested: AutonomousBudgetRequest,
  billingMode: "metered_currency" | "subscription_included" = "metered_currency",
): NormalizedAutonomousBudgetRequest {
  if (billingMode === "subscription_included") {
    if (requested.costMicrousd != null || requested.costCents != null) {
      throw new Error("autonomous_budget_subscription_monetary_amount_forbidden");
    }
    return {
      requestCount: nonNegativeInteger(requested.requestCount),
      inputTokens: nonNegativeInteger(requested.inputTokens),
      outputTokens: nonNegativeInteger(requested.outputTokens),
      runtimeMs: nonNegativeInteger(requested.runtimeMs),
      costMicrousd: null,
    };
  }
  const explicitMicrousd =
    requested.costMicrousd === undefined
      ? null
      : nonNegativeInteger(requested.costMicrousd);
  const legacyMicrousd =
    requested.costCents === undefined
      ? null
      : nonNegativeInteger(requested.costCents) * 10_000;
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
    requestCount: nonNegativeInteger(requested.requestCount),
    inputTokens: nonNegativeInteger(requested.inputTokens),
    outputTokens: nonNegativeInteger(requested.outputTokens),
    runtimeMs: nonNegativeInteger(requested.runtimeMs),
    costMicrousd: explicitMicrousd ?? legacyMicrousd!,
  };
}

function requestedMetric(requested: NormalizedAutonomousBudgetRequest, metric: BudgetMetric): number {
  switch (metric) {
    case "billed_cents":
      return (requested.costMicrousd ?? 0) / 10_000;
    case "billed_microusd":
      return requested.costMicrousd ?? 0;
    case "request_count":
      return requested.requestCount;
    case "input_tokens":
      return requested.inputTokens;
    case "output_tokens":
      return requested.outputTokens;
    case "runtime_ms":
      return requested.runtimeMs;
  }
}

function recordedMetric(
  row: typeof autonomousBudgetReservations.$inferSelect,
  metric: BudgetMetric,
): number {
  const reconciled = row.status === "reconciled";
  const costMicrousd = reconciled
    ? (row.actualCostMicrousd ?? row.reservedCostMicrousd ?? (row.reservedCostCents ?? 0) * 10_000)
    : (row.reservedCostMicrousd ?? (row.reservedCostCents ?? 0) * 10_000);
  switch (metric) {
    case "billed_cents":
      return costMicrousd / 10_000;
    case "billed_microusd":
      return costMicrousd;
    case "request_count":
      return reconciled
        ? (row.actualRequestCount ?? row.reservedRequestCount)
        : row.reservedRequestCount;
    case "input_tokens":
      return reconciled ? (row.actualInputTokens ?? row.reservedInputTokens) : row.reservedInputTokens;
    case "output_tokens":
      return reconciled
        ? (row.actualOutputTokens ?? row.reservedOutputTokens)
        : row.reservedOutputTokens;
    case "runtime_ms":
      return reconciled ? (row.actualRuntimeMs ?? row.reservedRuntimeMs) : row.reservedRuntimeMs;
  }
}

function remainingChainEnvelope(
  envelope: NormalizedAutonomousBudgetRequest,
  rows: Array<typeof autonomousBudgetReservations.$inferSelect>,
): NormalizedAutonomousBudgetRequest {
  const remaining = (metric: BudgetMetric) =>
    Math.max(
      0,
      requestedMetric(envelope, metric) -
        rows.reduce((total, row) => total + recordedMetric(row, metric), 0),
    );
  return {
    requestCount: remaining("request_count"),
    inputTokens: remaining("input_tokens"),
    outputTokens: remaining("output_tokens"),
    runtimeMs: remaining("runtime_ms"),
    costMicrousd: envelope.costMicrousd === null ? null : remaining("billed_microusd"),
  };
}

function windowStart(windowKind: BudgetWindowKind, now: Date): Date | null {
  if (windowKind === "calendar_day_utc") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (windowKind === "calendar_month_utc") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  return null;
}

function scopeReason(scopeType: BudgetScopeType): BudgetBlockReason {
  if (scopeType === "company") return "company_budget_exhausted";
  if (scopeType === "agent") return "agent_budget_exhausted";
  return "task_budget_exhausted";
}

function deriveRunEnvelope(
  policies: Array<typeof budgetPolicies.$inferSelect>,
  billingMode: "metered_currency" | "subscription_included" = "metered_currency",
): NormalizedAutonomousBudgetRequest {
  const perRun = policies.filter((policy) => policy.windowKind === "per_run");
  const minimum = (metric: BudgetMetric) => {
    const amounts = perRun
      .filter((policy) => policy.metric === metric)
      .map((policy) => policy.amount);
    return amounts.length > 0 ? Math.min(...amounts) : null;
  };
  const costAmounts = perRun.flatMap((policy) => {
    if (policy.metric === "billed_microusd") return [policy.amount];
    if (policy.metric === "billed_cents") return [policy.amount * 10_000];
    return [];
  });
  const envelope = {
    requestCount: minimum("request_count"),
    inputTokens: minimum("input_tokens"),
    outputTokens: minimum("output_tokens"),
    runtimeMs: minimum("runtime_ms"),
    costMicrousd: billingMode === "subscription_included"
      ? null
      : costAmounts.length > 0 ? Math.min(...costAmounts) : null,
  };
  const missing = Object.entries(envelope).find(([key, value]) =>
    value === null && !(key === "costMicrousd" && billingMode === "subscription_included"))?.[0];
  if (missing) throw new Error(`autonomous_run_budget_policy_missing:${missing}`);
  return normalizeBudgetRequest(envelope as AutonomousBudgetRequest, billingMode);
}

function validateBillingPolicy(input: AutonomousBudgetReservationInput): void {
  const policy = input.billingPolicy;
  if (!policy) return;
  if (policy.billingMode !== "subscription_included" || !policy.policyId.trim() ||
      !Number.isSafeInteger(policy.policyVersion) || policy.policyVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(policy.policyDigest) || !policy.credentialPrincipalId.trim() ||
      !Number.isSafeInteger(policy.maxRootChainProviderRequests) ||
      policy.maxRootChainProviderRequests < 1) {
    throw new Error("autonomous_budget_billing_policy_invalid");
  }
}

function matchesBillingPolicyBinding(
  reservation: {
    billingMode: "metered_currency" | "subscription_included";
    routePolicyId: string | null;
    routePolicyVersion: number | null;
    routePolicyDigest: string | null;
    credentialPrincipalId: string | null;
    rootChainRequestLimit: number | null;
  },
  policy: AutonomousBudgetReservationInput["billingPolicy"],
): boolean {
  const requestedMode = policy?.billingMode ?? "metered_currency";
  if (reservation.billingMode !== requestedMode) return false;
  if (reservation.billingMode === "metered_currency") return policy == null;
  return policy != null && reservation.routePolicyId === policy.policyId &&
    reservation.routePolicyVersion === policy.policyVersion &&
    reservation.routePolicyDigest === policy.policyDigest &&
    reservation.credentialPrincipalId === policy.credentialPrincipalId &&
    reservation.rootChainRequestLimit === policy.maxRootChainProviderRequests;
}

export async function reserveAutonomousBudget(
  db: Db,
  input: AutonomousBudgetReservationInput,
): Promise<
  | {
      admitted: true;
      reservationId: string;
      replayed: boolean;
      billingMode: "metered_currency" | "subscription_included";
      provider: string | null;
      model: string | null;
      envelope: AutonomousBudgetEnvelope;
    }
  | { admitted: false; reason: BudgetBlockReason; policyId: string }
  | { admitted: false; reason: "autonomous_execution_paused" }
  | {
      admitted: false;
      reason: "provider_circuit_open" | "provider_circuit_probe_in_flight";
      retryAt: Date | null;
    }
> {
  validateBillingPolicy(input);
  return db.transaction(async (tx) => {
    // Serialize pause and admission on the company row, including replay.
    const [company] = await tx.select({ paused: companies.autonomousExecutionPaused })
      .from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company || company.paused) {
      return { admitted: false as const, reason: "autonomous_execution_paused" as const };
    }
    let automaticSuccessorLaunch = false;
    if (input.previousRunId) {
      const eligible = await lockEligibleAutomaticSuccessorLaunchSettlement(tx as unknown as Db, {
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        runId: input.runId,
        previousRunId: input.previousRunId,
      });
      if (eligible === false) throw new Error("automatic_successor_launch_denied");
      automaticSuccessorLaunch = eligible === true;
    }
    const agent = await tx.select({ id: agents.id, paused: agents.autonomousExecutionPaused })
      .from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    const issue = await tx.select({ id: issues.id, paused: issues.autonomousExecutionPaused })
      .from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent || !issue) throw new Error("autonomous_budget_scope_mismatch");
    if (agent.paused || issue.paused) {
      return { admitted: false as const, reason: "autonomous_execution_paused" as const };
    }
    const acquireProviderCircuitDenial = async () => {
      if (!input.provider?.trim()) return null;
      const circuitPermit =
        await acquireAutonomousProviderCircuitPermitWithLockedCompany(tx, {
          companyId: input.companyId,
          provider: input.provider,
          credentialIdentifierHash: input.credentialIdentifierHash,
          runId: input.runId,
        });
      return circuitPermit.admitted ? null : circuitPermit;
    };
    const policies = await tx
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, input.companyId),
          eq(budgetPolicies.isActive, true),
          eq(budgetPolicies.hardStopEnabled, true),
          or(
            and(
              eq(budgetPolicies.scopeType, "company"),
              or(isNull(budgetPolicies.scopeId), eq(budgetPolicies.scopeId, input.companyId)),
            ),
            and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, input.agentId)),
            and(eq(budgetPolicies.scopeType, "task"), eq(budgetPolicies.scopeId, input.issueId)),
          ),
        ),
      )
      .orderBy(
        budgetPolicies.scopeType,
        budgetPolicies.scopeId,
        budgetPolicies.metric,
        budgetPolicies.windowKind,
        budgetPolicies.id,
      )
      .for("update");

    const existing = await tx
      .select({
        id: autonomousBudgetReservations.id,
        companyId: autonomousBudgetReservations.companyId,
        agentId: autonomousBudgetReservations.agentId,
        issueId: autonomousBudgetReservations.issueId,
        requestCount: autonomousBudgetReservations.reservedRequestCount,
        inputTokens: autonomousBudgetReservations.reservedInputTokens,
        outputTokens: autonomousBudgetReservations.reservedOutputTokens,
        runtimeMs: autonomousBudgetReservations.reservedRuntimeMs,
        costMicrousd: autonomousBudgetReservations.reservedCostMicrousd,
        billingMode: autonomousBudgetReservations.billingMode,
        routePolicyId: autonomousBudgetReservations.routePolicyId,
        routePolicyVersion: autonomousBudgetReservations.routePolicyVersion,
        routePolicyDigest: autonomousBudgetReservations.routePolicyDigest,
        credentialPrincipalId: autonomousBudgetReservations.credentialPrincipalId,
        rootChainRequestLimit: autonomousBudgetReservations.rootChainRequestLimit,
        provider: autonomousBudgetReservations.provider,
        model: autonomousBudgetReservations.model,
      })
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, input.runId))
      .then((rows) => rows[0] ?? null);
    if (existing) {
      if (
        existing.companyId !== input.companyId ||
        existing.agentId !== input.agentId ||
        existing.issueId !== input.issueId
      ) {
        throw new Error("autonomous_budget_reservation_scope_mismatch");
      }
      if (!matchesBillingPolicyBinding(existing, input.billingPolicy)) {
        throw new Error("autonomous_budget_reservation_billing_policy_mismatch");
      }
      if (existing.provider !== (input.provider ?? null) || existing.model !== (input.model ?? null)) {
        throw new Error("autonomous_budget_reservation_execution_binding_mismatch");
      }
      if (automaticSuccessorLaunch) {
        const authorized = await tx.select({ executionStage: heartbeatRuns.executionStage })
          .from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, input.runId),
            eq(heartbeatRuns.executionStage, "launch_authorized"),
          )).then((rows) => rows[0] ?? null);
        if (!authorized) throw new Error("automatic_successor_launch_denied");
      }
      const circuitDenial = await acquireProviderCircuitDenial();
      if (circuitDenial) return circuitDenial;
      return {
        admitted: true as const,
        reservationId: existing.id,
        replayed: true,
        billingMode: existing.billingMode,
        provider: existing.provider,
        model: existing.model,
        envelope: {
          requestCount: existing.requestCount,
          inputTokens: existing.inputTokens,
          outputTokens: existing.outputTokens,
          runtimeMs: existing.runtimeMs,
          costMicrousd: existing.costMicrousd,
        },
      };
    }
    if (policies.length === 0) throw new Error("autonomous_budget_policy_missing");
    const billingMode = input.billingPolicy?.billingMode ?? "metered_currency";
    let chainRootRunId = input.runId;
    if (input.previousRunId) {
      const predecessor = await tx
        .select({
          companyId: autonomousBudgetReservations.companyId,
          agentId: autonomousBudgetReservations.agentId,
          issueId: autonomousBudgetReservations.issueId,
          chainRootRunId: autonomousBudgetReservations.chainRootRunId,
          billingMode: autonomousBudgetReservations.billingMode,
          routePolicyId: autonomousBudgetReservations.routePolicyId,
          routePolicyVersion: autonomousBudgetReservations.routePolicyVersion,
          routePolicyDigest: autonomousBudgetReservations.routePolicyDigest,
          credentialPrincipalId: autonomousBudgetReservations.credentialPrincipalId,
          rootChainRequestLimit: autonomousBudgetReservations.rootChainRequestLimit,
        })
        .from(autonomousBudgetReservations)
        .where(eq(autonomousBudgetReservations.runId, input.previousRunId))
        .then((rows) => rows[0] ?? null);
      if (
        !predecessor ||
        predecessor.companyId !== input.companyId ||
        predecessor.agentId !== input.agentId ||
        predecessor.issueId !== input.issueId
      ) {
        throw new Error("autonomous_budget_chain_predecessor_mismatch");
      }
      const policy = input.billingPolicy;
      if (predecessor.billingMode !== billingMode ||
          (predecessor.billingMode === "subscription_included" &&
           (!policy || predecessor.routePolicyId !== policy.policyId ||
            predecessor.routePolicyVersion !== policy.policyVersion ||
            predecessor.routePolicyDigest !== policy.policyDigest ||
            predecessor.credentialPrincipalId !== policy.credentialPrincipalId ||
            predecessor.rootChainRequestLimit !== policy.maxRootChainProviderRequests))) {
        throw new Error("autonomous_budget_chain_billing_policy_mismatch");
      }
      chainRootRunId = predecessor.chainRootRunId;
    }

    const chainRows = await tx
      .select()
      .from(autonomousBudgetReservations)
      .where(
        and(
          eq(autonomousBudgetReservations.companyId, input.companyId),
          eq(autonomousBudgetReservations.chainRootRunId, chainRootRunId),
          inArray(autonomousBudgetReservations.status, [
            "reserved",
            "reconciled",
            "retained_missing_telemetry",
          ]),
        ),
      );
    const requested = input.requested
      ? normalizeBudgetRequest(input.requested, billingMode)
      : input.previousRunId
        ? remainingChainEnvelope(deriveRunEnvelope(policies, billingMode), chainRows)
        : deriveRunEnvelope(policies, billingMode);
    const committedChainRequests = chainRows.reduce(
      (total, row) => total + recordedMetric(row, "request_count"), 0,
    );
    if (input.billingPolicy && committedChainRequests + requested.requestCount >
        input.billingPolicy.maxRootChainProviderRequests) {
      throw new Error("autonomous_budget_root_chain_request_limit_exceeded");
    }

    const now = new Date();
    const crossedThresholds: Array<{
      policy: typeof budgetPolicies.$inferSelect;
      threshold: (typeof UTILIZATION_THRESHOLDS)[number];
      observed: number;
    }> = [];
    for (const policy of policies) {
      if (billingMode === "subscription_included" &&
          (policy.metric === "billed_cents" || policy.metric === "billed_microusd")) continue;
      if (policy.amount <= 0) {
        return { admitted: false as const, reason: scopeReason(policy.scopeType), policyId: policy.id };
      }
      const start = windowStart(policy.windowKind, now);
      const scopeFilter =
        policy.scopeType === "company"
          ? eq(autonomousBudgetReservations.companyId, input.companyId)
          : policy.scopeType === "agent"
            ? and(
                eq(autonomousBudgetReservations.companyId, input.companyId),
                eq(autonomousBudgetReservations.agentId, input.agentId),
              )
            : and(
                eq(autonomousBudgetReservations.companyId, input.companyId),
                eq(autonomousBudgetReservations.issueId, input.issueId),
              );
      const rows =
        policy.windowKind === "per_run"
          ? chainRows
          : await tx
              .select()
              .from(autonomousBudgetReservations)
              .where(
                and(
                  scopeFilter,
                  inArray(autonomousBudgetReservations.status, [
                    "reserved",
                    "reconciled",
                    "retained_missing_telemetry",
                  ]),
                  start ? gte(autonomousBudgetReservations.createdAt, start) : undefined,
                ),
              );
      const observed = rows.reduce(
        (total, row) => total + recordedMetric(row, policy.metric),
        0,
      );
      const requestedAmount = requestedMetric(requested, policy.metric);
      if (policy.windowKind === "per_run" && requestedAmount === 0 && observed >= policy.amount) {
        return {
          admitted: false as const,
          reason: scopeReason(policy.scopeType),
          policyId: policy.id,
        };
      }
      const projected = observed + requestedAmount;
      if (projected > policy.amount) {
        return {
          admitted: false as const,
          reason: scopeReason(policy.scopeType),
          policyId: policy.id,
        };
      }
      if (policy.notifyEnabled) {
        for (const threshold of UTILIZATION_THRESHOLDS) {
          if (projected * 100 >= policy.amount * threshold) {
            crossedThresholds.push({ policy, threshold, observed: projected });
          }
        }
      }
    }

    const circuitDenial = await acquireProviderCircuitDenial();
    if (circuitDenial) return circuitDenial;
    if (automaticSuccessorLaunch && input.previousRunId) {
      const [authorized] = await tx.update(heartbeatRuns).set({
        executionStage: "launch_authorized",
        updatedAt: new Date(),
      }).where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.retryOfRunId, input.previousRunId),
        or(isNull(heartbeatRuns.executionStage), eq(heartbeatRuns.executionStage, "preparing")),
      )).returning({ id: heartbeatRuns.id });
      if (!authorized) throw new Error("automatic_successor_launch_denied");
    }
    const reservation = await tx
      .insert(autonomousBudgetReservations)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        runId: input.runId,
        chainRootRunId,
        status: "reserved",
        reservedRequestCount: requested.requestCount,
        reservedInputTokens: requested.inputTokens,
        reservedOutputTokens: requested.outputTokens,
        reservedRuntimeMs: requested.runtimeMs,
        reservedCostCents: requested.costMicrousd === null
          ? null : Math.ceil(requested.costMicrousd / 10_000),
        reservedCostMicrousd: requested.costMicrousd,
        billingMode,
        monetaryApplicability: billingMode === "subscription_included"
          ? "not_applicable_per_request" : "applicable_per_request",
        routePolicyId: input.billingPolicy?.policyId ?? null,
        routePolicyVersion: input.billingPolicy?.policyVersion ?? null,
        routePolicyDigest: input.billingPolicy?.policyDigest ?? null,
        credentialPrincipalId: input.billingPolicy?.credentialPrincipalId ?? null,
        rootChainRequestLimit: input.billingPolicy?.maxRootChainProviderRequests ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        credentialIdentifierHash: input.credentialIdentifierHash ?? null,
        rateCardVersion: input.rateCardVersion ?? null,
      })
      .returning({
        id: autonomousBudgetReservations.id,
        provider: autonomousBudgetReservations.provider,
        model: autonomousBudgetReservations.model,
      })
      .then((rows) => rows[0]);

    for (const { policy, threshold, observed } of crossedThresholds) {
      const window = incidentWindow(policy.windowKind, now);
      await tx
        .insert(budgetIncidents)
        .values({
          companyId: input.companyId,
          policyId: policy.id,
          scopeType: policy.scopeType,
          scopeId: policy.scopeId,
          metric: policy.metric,
          windowKind: policy.windowKind,
          windowStart: window.start,
          windowEnd: window.end,
          thresholdType: `${threshold}_percent`,
          amountLimit: policy.amount,
          amountObserved: Math.ceil(observed),
          status: "open",
        })
        .onConflictDoNothing();
    }

    for (const policy of policies) {
      if (policy.scopeType === "company" && policy.metric === "billed_microusd"
        && policy.windowKind === "calendar_day_utc") {
        await recordAutonomousCostVelocityAlert(tx, input, policy, now);
      }
    }

    return {
      admitted: true as const,
      reservationId: reservation.id,
      replayed: false,
      billingMode,
      provider: reservation.provider,
      model: reservation.model,
      envelope: requested,
    };
  });
}

export {
  reconcileAutonomousBudget,
  type AutonomousBudgetReconciliationInput,
} from "./autonomous-budget-reconciliation.js";

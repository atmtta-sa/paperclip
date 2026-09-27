import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  autonomousBudgetReservations,
  budgetIncidents,
  budgetPolicies,
  companies,
  issues,
} from "@paperclipai/db";
import type { BudgetMetric, BudgetScopeType, BudgetWindowKind } from "@paperclipai/shared";
import { recordAutonomousCostVelocityAlert } from "./autonomous-cost-velocity-alert.js";

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
> & { costMicrousd: number };

type NormalizedAutonomousBudgetRequest = AutonomousBudgetEnvelope;

export type AutonomousBudgetReservationInput = {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  requested?: AutonomousBudgetRequest;
  provider?: string | null;
  model?: string | null;
  credentialIdentifierHash?: string | null;
  rateCardVersion?: string | null;
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

function normalizeBudgetRequest(requested: AutonomousBudgetRequest): NormalizedAutonomousBudgetRequest {
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
      return requested.costMicrousd / 10_000;
    case "billed_microusd":
      return requested.costMicrousd;
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
    ? (row.actualCostMicrousd ?? row.reservedCostMicrousd ?? row.reservedCostCents * 10_000)
    : (row.reservedCostMicrousd ?? row.reservedCostCents * 10_000);
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
    costMicrousd: costAmounts.length > 0 ? Math.min(...costAmounts) : null,
  };
  const missing = Object.entries(envelope).find(([, value]) => value === null)?.[0];
  if (missing) throw new Error(`autonomous_run_budget_policy_missing:${missing}`);
  return normalizeBudgetRequest(envelope as NormalizedAutonomousBudgetRequest);
}

export async function reserveAutonomousBudget(
  db: Db,
  input: AutonomousBudgetReservationInput,
): Promise<
  | {
      admitted: true;
      reservationId: string;
      replayed: boolean;
      envelope: AutonomousBudgetEnvelope;
    }
  | { admitted: false; reason: BudgetBlockReason; policyId: string }
  | { admitted: false; reason: "autonomous_execution_paused" }
> {
  return db.transaction(async (tx) => {
    // Serialize pause and admission on the company row, including replay.
    const [company] = await tx.select({ paused: companies.autonomousExecutionPaused })
      .from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company || company.paused) {
      return { admitted: false as const, reason: "autonomous_execution_paused" as const };
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
        requestCount: autonomousBudgetReservations.reservedRequestCount,
        inputTokens: autonomousBudgetReservations.reservedInputTokens,
        outputTokens: autonomousBudgetReservations.reservedOutputTokens,
        runtimeMs: autonomousBudgetReservations.reservedRuntimeMs,
        costMicrousd: autonomousBudgetReservations.reservedCostMicrousd,
      })
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, input.runId))
      .then((rows) => rows[0] ?? null);
    if (existing) {
      return {
        admitted: true as const,
        reservationId: existing.id,
        replayed: true,
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
    const requested = input.requested
      ? normalizeBudgetRequest(input.requested)
      : deriveRunEnvelope(policies);

    const now = new Date();
    const crossedThresholds: Array<{
      policy: typeof budgetPolicies.$inferSelect;
      threshold: (typeof UTILIZATION_THRESHOLDS)[number];
      observed: number;
    }> = [];
    for (const policy of policies) {
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
          ? []
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
      const projected = observed + requestedMetric(requested, policy.metric);
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

    const reservation = await tx
      .insert(autonomousBudgetReservations)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        runId: input.runId,
        status: "reserved",
        reservedRequestCount: requested.requestCount,
        reservedInputTokens: requested.inputTokens,
        reservedOutputTokens: requested.outputTokens,
        reservedRuntimeMs: requested.runtimeMs,
        reservedCostCents: Math.ceil(requested.costMicrousd / 10_000),
        reservedCostMicrousd: requested.costMicrousd,
        provider: input.provider ?? null,
        model: input.model ?? null,
        credentialIdentifierHash: input.credentialIdentifierHash ?? null,
        rateCardVersion: input.rateCardVersion ?? null,
      })
      .returning({ id: autonomousBudgetReservations.id })
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
      envelope: requested,
    };
  });
}

export {
  reconcileAutonomousBudget,
  type AutonomousBudgetReconciliationInput,
} from "./autonomous-budget-reconciliation.js";

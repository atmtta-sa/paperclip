import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  autonomousBudgetReservations,
  companies,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { reconcileAutonomousBudget } from "./autonomous-budget-reconciliation.js";

const historicalProfileErrors = new Set([
  "hermes_managed_profile_invalid",
  "hermes_managed_profile_missing",
]);
const conflictCodes = new Set([
  "autonomous_budget_reconciliation_conflict",
  "autonomous_budget_reconciliation_scope_mismatch",
  "autonomous_budget_reconciliation_provider_mismatch",
  "autonomous_budget_reconciliation_model_mismatch",
]);

type RecoveryInput = {
  companyId: string;
  runId: string;
  actor: { actorType: "agent" | "user"; actorId: string };
  body: {
    agentId: string;
    issueId: string;
    provider: string;
    model: string;
    evidence: {
      reviewedAdapterSourceCommit: string;
      operatorAttested: true;
    };
  };
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceDigest(input: {
  run: typeof heartbeatRuns.$inferSelect;
  reservation: typeof autonomousBudgetReservations.$inferSelect;
  issueId: string;
}): string {
  const { run, reservation, issueId } = input;
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    runId: run.id,
    companyId: run.companyId,
    agentId: run.agentId,
    issueId,
    status: run.status,
    executionStage: run.executionStage,
    error: run.error,
    errorCode: run.errorCode,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    processPid: run.processPid,
    processGroupId: run.processGroupId,
    processStartedAt: run.processStartedAt?.toISOString() ?? null,
    exitCode: run.exitCode,
    signal: run.signal,
    usageJson: run.usageJson,
    resultStopReason: object(run.resultJson)?.stopReason ?? null,
    reservationId: reservation.id,
    provider: reservation.provider,
    model: reservation.model,
    providerActivityOccurred: reservation.providerActivityOccurred,
    providerRequestId: reservation.providerRequestId,
    actualRequestCount: reservation.actualRequestCount,
    actualInputTokens: reservation.actualInputTokens,
    actualOutputTokens: reservation.actualOutputTokens,
    actualRuntimeMs: reservation.actualRuntimeMs,
    actualCostCents: reservation.actualCostCents,
    actualCostMicrousd: reservation.actualCostMicrousd,
  })).digest("hex");
}

function hasConflictingResultEvidence(resultJson: unknown): boolean {
  const result = object(resultJson);
  if (!result || result.stopReason !== "adapter_failed") return true;
  return [
    "executionRecovery",
    "durableCallEvidence",
    "pretransportEvidence",
    "budgetTelemetry",
    "providerRequestIds",
    "usage",
    "cost_usd",
    "successfulProviderResponses",
    "providerInputTokens",
  ].some((key) => result[key] != null);
}

export async function recoverHistoricalHermesPreproviderBudget(db: Db, input: RecoveryInput) {
  const { companyId, runId, body, actor } = input;
  return db.transaction(async (tx) => {
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).for("update");
    if (!company) throw notFound("Company not found");
    const [run] = await tx.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("share");
    if (!run) throw notFound("Run not found");
    const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents)
      .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId))).for("share");
    if (!agent) throw notFound("Run not found");
    const [reservation] = await tx.select().from(autonomousBudgetReservations)
      .where(and(eq(autonomousBudgetReservations.runId, runId), eq(autonomousBudgetReservations.companyId, companyId)));
    if (!reservation) throw notFound("Reservation not found");
    const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId))).limit(1);
    const context = object(run.contextSnapshot);
    const actuals = [
      reservation.actualRequestCount,
      reservation.actualInputTokens,
      reservation.actualOutputTokens,
      reservation.actualRuntimeMs,
      reservation.actualCostCents,
      reservation.actualCostMicrousd,
    ];
    const firstRecovery = reservation.status === "reserved" && reservation.settlementState == null;
    const replay = reservation.status === "released" && reservation.settlementState === "released_zero_usage";
    if (
      agent.adapterType !== "hermes_local" ||
      run.status !== "failed" ||
      run.executionStage !== "dispatching" ||
      run.errorCode !== "adapter_failed" ||
      !historicalProfileErrors.has(run.error ?? "") ||
      !run.startedAt ||
      !run.finishedAt ||
      run.processPid != null ||
      run.processGroupId != null ||
      run.processStartedAt != null ||
      run.exitCode != null ||
      run.signal != null ||
      run.usageJson != null ||
      hasConflictingResultEvidence(run.resultJson) ||
      run.agentId !== body.agentId ||
      context?.issueId !== body.issueId ||
      reservation.agentId !== body.agentId ||
      reservation.issueId !== body.issueId ||
      reservation.provider !== body.provider ||
      reservation.model !== body.model ||
      reservation.providerActivityOccurred ||
      reservation.providerRequestId != null ||
      actuals.some((value) => value != null) ||
      run.scheduledRetryAt != null ||
      run.scheduledRetryReason != null ||
      successor != null ||
      (!firstRecovery && !replay)
    ) {
      throw conflict("Run does not have exact historical Hermes preprovider evidence");
    }
    const runRecordSha256 = evidenceDigest({ run, reservation, issueId: body.issueId });
    const evidence = { ...body.evidence, runRecordSha256 };
    const [existingAudit] = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "autonomous_budget.preprovider_recovered"),
      eq(activityLog.entityId, reservation.id),
    )).limit(1);
    const previousEvidence = object(object(existingAudit?.details)?.evidence);
    if (existingAudit && (
      previousEvidence?.reviewedAdapterSourceCommit !== evidence.reviewedAdapterSourceCommit ||
      previousEvidence?.operatorAttested !== true ||
      previousEvidence?.runRecordSha256 !== evidence.runRecordSha256
    )) {
      throw conflict("Recovery evidence conflicts with the original audited recovery");
    }
    if ((firstRecovery && existingAudit) || (replay && !existingAudit)) {
      throw conflict("Recovery settlement and audit state disagree");
    }
    let result;
    try {
      result = await reconcileAutonomousBudget(tx as unknown as Db, {
        companyId,
        agentId: body.agentId,
        issueId: body.issueId,
        runId,
        providerActivityOccurred: false,
        verifiedNoProviderActivity: true,
        providerRequestId: null,
        actual: null,
        provider: body.provider,
        model: body.model,
      });
    } catch (error) {
      if (error instanceof Error && conflictCodes.has(error.message)) throw conflict(error.message);
      throw error;
    }
    if (result.replayed) return { result, publication: null };
    const { publication } = await persistActivity(tx as unknown as Db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "autonomous_budget.preprovider_recovered",
      entityType: "autonomous_budget_reservation",
      entityId: reservation.id,
      details: {
        runId,
        agentId: body.agentId,
        issueId: body.issueId,
        provider: body.provider,
        model: body.model,
        basis: "deterministic_hermes_profile_validation_failure",
        evidence,
        ...result,
      },
    });
    return { result, publication };
  });
}

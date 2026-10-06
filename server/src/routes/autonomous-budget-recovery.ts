import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { autonomousBudgetReservations, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { persistActivity, publishActivity } from "../services/activity-log.js";
import { reconcileAutonomousBudget } from "../services/autonomous-budget-reconciliation.js";
import { recoverHistoricalHermesPreproviderBudget } from "../services/historical-hermes-preprovider-recovery.js";

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(256).refine((value) => value === value.trim());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const recoverySchema = z.object({
  agentId: z.string().uuid(),
  issueId: z.string().uuid(),
  provider: text,
  model: text,
  providerRequestId: text,
  actual: z.object({
    requestCount: amount.positive().max(2_147_483_647),
    inputTokens: amount,
    outputTokens: amount,
    runtimeMs: amount,
    costMicrousd: amount.max(2_147_483_647 * 10_000),
  }).strict(),
  // Board attestation, not automated verification of a hash or billing statement.
  evidence: z.object({
    usageSha256: sha256,
    billingSha256: sha256,
    billingBasis: z.enum(["subscription_included", "verified_incremental_charge"]),
    operatorAttested: z.literal(true),
  }).strict(),
}).strict().refine(
  (body) => body.evidence.billingBasis !== "subscription_included" || body.actual.costMicrousd === 0,
  { message: "Subscription-included incremental cost must be zero", path: ["actual", "costMicrousd"] },
);
const preproviderRecoverySchema = z.object({
  agentId: z.string().uuid(),
  issueId: z.string().uuid(),
  provider: text,
  model: text,
  evidence: z.object({
    reviewedAdapterSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    operatorAttested: z.literal(true),
  }).strict(),
}).strict();
const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const conflictCodes = new Set([
  "autonomous_budget_reconciliation_conflict",
  "autonomous_budget_reconciliation_scope_mismatch",
  "autonomous_budget_reconciliation_provider_mismatch",
  "autonomous_budget_reconciliation_model_mismatch",
]);

export function autonomousBudgetRecoveryRoutes(db: Db) {
  const router = Router();
  router.post("/companies/:companyId/budgets/autonomous-reservations/:runId/recover", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const runId = z.string().uuid().parse(req.params.runId);
    const body = recoverySchema.parse(req.body);
    const actor = getActorInfo(req);
    const { evidence, ...telemetry } = body;
    const committed = await db.transaction(async (tx) => {
      // Preserve settlement's company-first lock order. Audit failure rolls back settlement.
      const [company] = await tx.select({ id: companies.id }).from(companies)
        .where(eq(companies.id, companyId)).for("update");
      if (!company) throw notFound("Company not found");
      const [run] = await tx.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("share");
      if (!run) throw notFound("Run not found");
      if (!terminalStatuses.has(run.status) || run.agentId !== body.agentId) {
        throw conflict("Recovery requires a terminal run with matching agent");
      }
      const [reservation] = await tx.select().from(autonomousBudgetReservations)
        .where(and(eq(autonomousBudgetReservations.runId, runId), eq(autonomousBudgetReservations.companyId, companyId)));
      if (!reservation) throw notFound("Reservation not found");
      const recoverable = reservation.status === "retained_missing_telemetry"
        && reservation.settlementState === "uncertain_requires_reconciliation";
      if (!recoverable && reservation.status !== "reconciled") {
        throw conflict("Reservation is not awaiting telemetry recovery");
      }
      let result;
      try {
        result = await reconcileAutonomousBudget(tx as unknown as Db, {
          ...telemetry, companyId, runId, providerActivityOccurred: true,
        });
      } catch (error) {
        if (error instanceof Error && conflictCodes.has(error.message)) throw conflict(error.message);
        throw error;
      }
      if (result.replayed) return { result, publication: null };
      const { publication } = await persistActivity(tx as unknown as Db, {
        companyId, actorType: actor.actorType, actorId: actor.actorId,
        action: "autonomous_budget.telemetry_recovered", entityType: "autonomous_budget_reservation",
        entityId: reservation.id, details: { runId, agentId: body.agentId, issueId: body.issueId, evidence, actual: body.actual, providerRequestId: body.providerRequestId, ...result },
      });
      return { result, publication };
    });
    if (committed.publication) publishActivity(committed.publication);
    res.json(committed.result);
  });

  router.post("/companies/:companyId/budgets/autonomous-reservations/:runId/recover-preprovider", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const runId = z.string().uuid().parse(req.params.runId);
    const body = preproviderRecoverySchema.parse(req.body);
    const actor = getActorInfo(req);
    const committed = await recoverHistoricalHermesPreproviderBudget(db, {
      companyId,
      runId,
      body,
      actor,
    });
    if (committed.publication) publishActivity(committed.publication);
    res.json(committed.result);
  });
  return router;
}

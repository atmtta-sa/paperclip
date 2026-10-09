import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { budgetPolicies, issues, type Db } from "@paperclipai/db";

/** Synthetic limits for isolated fake-adapter tests; never configures a live company. */
export async function seedSyntheticCompanyBudgets(db: Db, companyId: string) {
  await db.insert(budgetPolicies).values([
    { companyId, scopeType: "company", scopeId: companyId, metric: "request_count", windowKind: "per_run", amount: 8 },
    { companyId, scopeType: "company", scopeId: companyId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
    { companyId, scopeType: "company", scopeId: companyId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
    { companyId, scopeType: "company", scopeId: companyId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
    { companyId, scopeType: "company", scopeId: companyId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
  ]).onConflictDoNothing();
}

/** Synthetic task limits for isolated fake-adapter tests with concrete issue scope. */
export async function seedSyntheticTaskBudgets(
  db: Db,
  companyId: string,
  issueId: string,
) {
  const issue = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  assert.ok(issue, "Synthetic task budgets require an existing company-matching issue");
  await db.insert(budgetPolicies).values([
    { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "lifetime", amount: 80 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "lifetime", amount: 640_000 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "lifetime", amount: 80_000 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "lifetime", amount: 3_000_000 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "lifetime", amount: 10_000_000 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
    { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
  ]).onConflictDoNothing();
}

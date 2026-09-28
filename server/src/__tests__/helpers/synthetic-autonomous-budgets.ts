import { budgetPolicies, type Db } from "@paperclipai/db";

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

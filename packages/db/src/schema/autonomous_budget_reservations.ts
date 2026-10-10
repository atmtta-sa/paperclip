import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const autonomousBudgetReservations = pgTable(
  "autonomous_budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    runId: uuid("run_id").notNull(),
    chainRootRunId: uuid("chain_root_run_id").notNull(),
    status: text("status")
      .$type<"reserved" | "reconciled" | "retained_missing_telemetry" | "released">()
      .notNull()
      .default("reserved"),
    settlementState: text("settlement_state").$type<
      | "consumed"
      | "partially_consumed"
      | "released_zero_usage"
      | "consumed_over_reservation"
      | "uncertain_requires_reconciliation"
    >(),
    reservedRequestCount: integer("reserved_request_count").notNull().default(0),
    reservedInputTokens: bigint("reserved_input_tokens", { mode: "number" }).notNull().default(0),
    reservedOutputTokens: bigint("reserved_output_tokens", { mode: "number" }).notNull().default(0),
    reservedRuntimeMs: bigint("reserved_runtime_ms", { mode: "number" }).notNull().default(0),
    reservedCostCents: integer("reserved_cost_cents").default(0),
    reservedCostMicrousd: bigint("reserved_cost_microusd", { mode: "number" }).default(0),
    actualRequestCount: integer("actual_request_count"),
    actualInputTokens: bigint("actual_input_tokens", { mode: "number" }),
    actualOutputTokens: bigint("actual_output_tokens", { mode: "number" }),
    actualRuntimeMs: bigint("actual_runtime_ms", { mode: "number" }),
    actualCostCents: integer("actual_cost_cents"),
    actualCostMicrousd: bigint("actual_cost_microusd", { mode: "number" }),
    billingMode: text("billing_mode")
      .$type<"metered_currency" | "subscription_included">()
      .notNull()
      .default("metered_currency"),
    monetaryApplicability: text("monetary_applicability")
      .$type<"applicable_per_request" | "not_applicable_per_request">()
      .notNull()
      .default("applicable_per_request"),
    routePolicyId: text("route_policy_id"),
    routePolicyVersion: integer("route_policy_version"),
    routePolicyDigest: text("route_policy_digest"),
    credentialPrincipalId: text("credential_principal_id"),
    rootChainRequestLimit: integer("root_chain_request_limit"),
    overrunInputTokens: bigint("overrun_input_tokens", { mode: "number" }).notNull().default(0),
    provider: text("provider"),
    model: text("model"),
    providerRequestId: text("provider_request_id"),
    providerActivityOccurred: boolean("provider_activity_occurred").notNull().default(false),
    credentialIdentifierHash: text("credential_identifier_hash"),
    rateCardVersion: text("rate_card_version"),
    settlementEvidence: jsonb("settlement_evidence").$type<{
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
    } | null>(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runUniqueIdx: uniqueIndex("autonomous_budget_reservations_run_uq").on(table.runId),
    chainRootIdx: index("autonomous_budget_reservations_chain_root_idx").on(
      table.companyId,
      table.chainRootRunId,
    ),
    companyCreatedIdx: index("autonomous_budget_reservations_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    taskCreatedIdx: index("autonomous_budget_reservations_task_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    agentCreatedIdx: index("autonomous_budget_reservations_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    billingShapeCheck: check(
      "autonomous_budget_reservations_billing_shape_check",
      sql`(
        (${table.billingMode} = 'metered_currency'
          and ${table.monetaryApplicability} = 'applicable_per_request'
          and ${table.reservedCostCents} is not null
          and ${table.reservedCostMicrousd} is not null)
        or
        (${table.billingMode} = 'subscription_included'
          and ${table.monetaryApplicability} = 'not_applicable_per_request'
          and ${table.reservedCostCents} is null
          and ${table.reservedCostMicrousd} is null
          and ${table.routePolicyId} is not null
          and ${table.routePolicyVersion} is not null and ${table.routePolicyVersion} > 0
          and ${table.routePolicyDigest} ~ '^[a-f0-9]{64}$'
          and ${table.credentialPrincipalId} is not null
          and ${table.rootChainRequestLimit} is not null and ${table.rootChainRequestLimit} > 0)
      )`,
    ),
  }),
);

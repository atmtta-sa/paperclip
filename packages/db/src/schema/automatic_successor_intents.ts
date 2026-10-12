import {
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

export const automaticSuccessorIntents = pgTable(
  "automatic_successor_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    predecessorRunId: uuid("predecessor_run_id").notNull(),
    chainRootRunId: uuid("chain_root_run_id").notNull(),
    kind: text("kind")
      .$type<"productive" | "corrective" | "recovery" | "terminal">()
      .notNull(),
    status: text("status")
      .$type<"pending" | "materialized" | "denied" | "cancelled">()
      .notNull()
      .default("pending"),
    reason: text("reason").notNull(),
    denialReason: text("denial_reason"),
    checkpointRef: text("checkpoint_ref"),
    nextAction: text("next_action"),
    authorizationBinding: jsonb("authorization_binding")
      .$type<Record<string, unknown>>()
      .notNull(),
    policyVersion: integer("policy_version").notNull(),
    budgetSnapshot: jsonb("budget_snapshot").$type<Record<string, unknown>>(),
    wakeupRequestId: uuid("wakeup_request_id"),
    successorRunId: uuid("successor_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    predecessorUniqueIdx: uniqueIndex("automatic_successor_intents_predecessor_uq").on(
      table.companyId,
      table.predecessorRunId,
    ),
    pendingIdx: index("automatic_successor_intents_pending_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
  }),
);

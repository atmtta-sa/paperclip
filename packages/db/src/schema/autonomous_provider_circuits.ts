import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const autonomousProviderCircuits = pgTable(
  "autonomous_provider_circuits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    credentialIdentifierHash: text("credential_identifier_hash").notNull(),
    state: text("state")
      .$type<"closed" | "open" | "half_open">()
      .notNull()
      .default("closed"),
    consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
    probeRunId: uuid("probe_run_id"),
    probeClaimedAt: timestamp("probe_claimed_at", { withTimezone: true }),
    lastFailureRunId: uuid("last_failure_run_id"),
    lastSuccessRunId: uuid("last_success_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeUniqueIdx: uniqueIndex("autonomous_provider_circuits_scope_uq").on(
      table.companyId,
      table.provider,
      table.credentialIdentifierHash,
    ),
    companyStateIdx: index("autonomous_provider_circuits_company_state_idx").on(
      table.companyId,
      table.state,
    ),
  }),
);

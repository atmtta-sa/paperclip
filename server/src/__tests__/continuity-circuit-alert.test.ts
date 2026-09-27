import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recordContinuityCircuitAlert } from "../services/continuity-circuit-alert.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("continuity circuit audit alert", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-circuit-alert-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });

  it("deduplicates simultaneous and later runs of one circuit episode, but records a new episode", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const openedAt = new Date("2026-09-27T00:00:00.000Z");
    await db.insert(companies).values({ id: companyId, name: "Circuit company",
      issuePrefix: `CA${companyId.slice(0, 4)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Circuit agent",
      role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(heartbeatRuns).values(ids.map((id) => ({ id, companyId, agentId,
      status: "failed", contextSnapshot: { issueId }, stateFingerprintAfter: "same",
      noProgressStreak: 2, continuityCircuitState: "open" as const,
      continuityCircuitOpenedAt: openedAt })));
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await Promise.all(rows.slice(0, 2).map((run) => recordContinuityCircuitAlert(db, run, issueId)));
    await recordContinuityCircuitAlert(db, rows[0], issueId);
    await recordContinuityCircuitAlert(db, rows[2], issueId);
    const matching = () => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.continuity_circuit_opened")));
    expect(await matching()).toHaveLength(1);
    expect((await db.select({ alertedAt: heartbeatRuns.continuityCircuitAlertedAt })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .every((run) => run.alertedAt instanceof Date)).toBe(true);
    const reopenedAt = new Date("2026-09-27T01:00:00.000Z");
    const reopenedId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: reopenedId, companyId, agentId,
      status: "failed", contextSnapshot: { issueId }, stateFingerprintAfter: "same",
      noProgressStreak: 2, continuityCircuitState: "open", continuityCircuitOpenedAt: reopenedAt });
    const [reopened] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, reopenedId));
    await recordContinuityCircuitAlert(db, reopened, issueId);
    expect(await matching()).toHaveLength(2);
  });
});

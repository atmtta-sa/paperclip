import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { setAutonomousExecutionPause } from "../services/autonomous-execution-control.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("autonomous execution control", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-autonomous-pause-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });

  it("audits each actual pause transition once and reads the persisted state back", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause company",
      autonomousExecutionPaused: false,
      issuePrefix: `AP${companyId.slice(0, 4)}`, requireBoardApprovalForNewAgents: false });
    const input = { companyId, paused: true, actorId: "board-1" };
    expect(await setAutonomousExecutionPause(db, input)).toEqual({ companyId, paused: true });
    expect(await setAutonomousExecutionPause(db, input)).toEqual({ companyId, paused: true });
    expect((await db.select({ status: companies.status }).from(companies)
      .where(eq(companies.id, companyId)))[0]?.status).toBe("active");
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))
      .toMatchObject([{ actorId: "board-1", action: "autonomous_execution.paused", details: { paused: true } }]);
    expect(await setAutonomousExecutionPause(db, { ...input, paused: false })).toEqual({ companyId, paused: false });
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(logs).toHaveLength(2);
    expect(logs.map((row) => row.action)).toEqual(["autonomous_execution.paused", "autonomous_execution.resumed"]);
    expect(await setAutonomousExecutionPause(db, { ...input, companyId: randomUUID() })).toBeNull();
  });
  it("defaults newly created companies to paused autonomous execution", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Default paused company",
      issuePrefix: `DP${companyId.slice(0, 4)}` });
    expect((await db.select({ paused: companies.autonomousExecutionPaused })
      .from(companies).where(eq(companies.id, companyId)))[0]?.paused).toBe(true);
  });
});

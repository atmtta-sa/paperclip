import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { claimAgentRunSlot } from "../services/agent-run-admission.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat agent run admission", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-admission-");
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("atomically admits only one of four queued runs across independent database clients", async () => {
    const dbs = Array.from({ length: 4 }, () =>
      createDb(tempDb!.connectionString),
    );
    const [firstDb] = dbs;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runIds = Array.from({ length: 4 }, () => randomUUID());

    await firstDb.insert(companies).values({
      id: companyId,
      name: "Single-flight test",
      issuePrefix: `SF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      autonomousExecutionPaused: false,
    });
    await firstDb.insert(agents).values({
      id: agentId,
      companyId,
      name: "SingleFlightAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await firstDb.insert(heartbeatRuns).values(
      runIds.map((id) => ({ id, companyId, agentId, status: "queued" as const })),
    );

    const admit = (db: ReturnType<typeof createDb>, runId: string) =>
      db.transaction(async (tx) => {
        const hasSlot = await claimAgentRunSlot(tx, {
          agentId,
          maxConcurrentRuns: 1,
        });
        if (!hasSlot) return false;

        const [claimed] = await tx
          .update(heartbeatRuns)
          .set({ status: "running", startedAt: new Date() })
          .where(eq(heartbeatRuns.id, runId))
          .returning({ id: heartbeatRuns.id });
        return Boolean(claimed);
      });

    const results = await Promise.all(
      runIds.map((runId, index) => admit(dbs[index]!, runId)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const runs = await firstDb
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.filter((run) => run.status === "running")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(3);
  });
});

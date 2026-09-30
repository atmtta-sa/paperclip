import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { createChatTaskDispatchRepository } from "./chat-task-dispatch-repository.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("chat task dispatch repository", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-chat-task-dispatch-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `D${companyId.slice(0, 7).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Dispatch Test",
      issuePrefix,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Visualization Tool Developer",
      status: "idle",
    });
    return { companyId, agentId, issuePrefix };
  }

  it("matches one active agent by exact normalized name", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(agents).values([
      {
        companyId,
        name: "Visualization Developer",
        status: "idle",
      },
      {
        companyId,
        name: "Visualization Tool Developer",
        status: "terminated",
      },
      {
        companyId,
        name: "Visualization Tool Developer",
        status: "paused",
      },
    ]);

    await expect(
      createChatTaskDispatchRepository(db).findAgentsByExactName(
        companyId,
        "  visualization tool developer ",
      ),
    ).resolves.toEqual([
      { id: agentId, name: "Visualization Tool Developer" },
    ]);
  });

  it("returns only assigned, unblocked todo/in-progress issues", async () => {
    const { companyId, agentId, issuePrefix } = await seed();
    const blockerId = randomUUID();
    const readyId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        identifier: `${issuePrefix}-267`,
        title: "Blocking task",
        status: "todo",
      },
      {
        id: readyId,
        companyId,
        identifier: `${issuePrefix}-268`,
        title: "Ready task",
        status: "in_progress",
        assigneeAgentId: agentId,
      },
      {
        id: blockedId,
        companyId,
        identifier: `${issuePrefix}-269`,
        title: "Blocked task",
        status: "todo",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        identifier: `${issuePrefix}-270`,
        title: "Backlog task",
        status: "backlog",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        identifier: `${issuePrefix}-271`,
        title: "Done task",
        status: "done",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
      resolutionState: "unresolved",
    });

    await expect(
      createChatTaskDispatchRepository(db).listRunnableIssueCandidates(
        companyId,
        agentId,
      ),
    ).resolves.toEqual([
      {
        id: readyId,
        identifier: `${issuePrefix}-268`,
        title: "Ready task",
        status: "in_progress",
        hasUnresolvedBlockers: false,
        hasActiveExecution: false,
      },
    ]);
  });

  it("finds a runnable task after earlier blocked tasks before applying its limit", async () => {
    const { companyId, agentId, issuePrefix } = await seed();
    const blockerId = randomUUID();
    const blockedOneId = randomUUID();
    const blockedTwoId = randomUUID();
    const readyId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        identifier: `${issuePrefix}-100`,
        title: "Blocker",
        status: "todo",
      },
      {
        id: blockedOneId,
        companyId,
        identifier: `${issuePrefix}-101`,
        title: "Blocked one",
        status: "todo",
        assigneeAgentId: agentId,
      },
      {
        id: blockedTwoId,
        companyId,
        identifier: `${issuePrefix}-102`,
        title: "Blocked two",
        status: "todo",
        assigneeAgentId: agentId,
      },
      {
        id: readyId,
        companyId,
        identifier: `${issuePrefix}-103`,
        title: "Ready task",
        status: "todo",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: blockerId,
        relatedIssueId: blockedOneId,
        type: "blocks",
        resolutionState: "unresolved",
      },
      {
        companyId,
        issueId: blockerId,
        relatedIssueId: blockedTwoId,
        type: "blocks",
        resolutionState: "unresolved",
      },
    ]);

    await expect(
      createChatTaskDispatchRepository(db).listRunnableIssueCandidates(
        companyId,
        agentId,
      ),
    ).resolves.toEqual([
      {
        id: readyId,
        identifier: `${issuePrefix}-103`,
        title: "Ready task",
        status: "todo",
        hasUnresolvedBlockers: false,
        hasActiveExecution: false,
      },
    ]);
  });

  it("excludes candidates while the agent has an active run or pending wake", async () => {
    const { companyId, agentId, issuePrefix } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${issuePrefix}-268`,
      title: "Ready task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const repository = createChatTaskDispatchRepository(db);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await expect(
      repository.listRunnableIssueCandidates(companyId, agentId),
    ).resolves.toEqual([]);

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "on_demand",
      status: "queued",
      payload: { issueId },
    });
    await expect(
      repository.listRunnableIssueCandidates(companyId, agentId),
    ).resolves.toEqual([]);
  });
});

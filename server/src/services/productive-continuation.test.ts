import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  automaticSuccessorIntents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { predecessorRetryAuthorityAllows } from "./automatic-successor-settlement.js";
import {
  buildAutomaticSuccessorWakeIdempotencyKey,
  claimAutomaticSuccessorIntent,
  decideProductiveRecoveryIntent,
  parseProductiveRunDisposition,
  predecessorProductiveContinuationAuthorityAllows,
  productiveContinuationBindingFromRuns,
  settleAutomaticSuccessorIntent,
} from "./productive-continuation.js";

const binding = {
  companyId: "company-1",
  issueId: "issue-1",
  agentId: "agent-1",
  runId: "run-1",
  workspaceId: "workspace-1",
};

function disposition(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "continue_same_issue",
    companyId: binding.companyId,
    issueId: binding.issueId,
    agentId: binding.agentId,
    runId: binding.runId,
    workspaceId: binding.workspaceId,
    nextAction: "Apply the verified scanner exclusion patch.",
    checkpoint: {
      kind: "run_workspace",
      runId: binding.runId,
      workspaceId: binding.workspaceId,
    },
    ...overrides,
  };
}

describe("productive same-issue continuation contract", () => {
  it("accepts an exact version-one same-issue disposition", () => {
    expect(parseProductiveRunDisposition({ runDisposition: disposition() }, binding)).toEqual({
      kind: "continue_same_issue",
      disposition: disposition(),
    });
  });

  it("does not treat an advanced liveness label as continuation authority", () => {
    expect(parseProductiveRunDisposition({ livenessState: "advanced" }, binding)).toEqual({
      kind: "legacy_missing",
    });
  });

  it("preserves an unknown disposition version but denies a successor", () => {
    expect(
      parseProductiveRunDisposition(
        { runDisposition: disposition({ version: 3 }) },
        binding,
      ),
    ).toEqual({
      kind: "denied",
      reason: "unsupported_disposition",
    });
  });

  it.each([
    ["wrong issue", { issueId: "issue-2" }, "authorization_binding_mismatch"],
    ["wrong workspace", { workspaceId: "workspace-2" }, "authorization_binding_mismatch"],
    ["wrong checkpoint run", { checkpoint: { kind: "run_workspace", runId: "run-2", workspaceId: binding.workspaceId } }, "checkpoint_invalid"],
    ["empty next action", { nextAction: "  " }, "next_action_invalid"],
  ])("denies %s", (_label, override, reason) => {
    expect(
      parseProductiveRunDisposition(
        { runDisposition: disposition(override) },
        binding,
      ),
    ).toEqual({ kind: "denied", reason });
  });

  it("uses positive productive authority without broadening retry authority", () => {
    const run = {
      status: "succeeded",
      errorCode: null,
      resultJson: { runDisposition: disposition() },
    } as any;

    expect(predecessorProductiveContinuationAuthorityAllows(run, binding)).toBe(true);
    expect(predecessorRetryAuthorityAllows(run)).toBe(false);
  });

  it("derives launch authority only from an intent-bound same-workspace successor", () => {
    const predecessor = {
      id: binding.runId,
      companyId: binding.companyId,
      agentId: binding.agentId,
      contextSnapshot: {
        issueId: binding.issueId,
        paperclipWorkspace: { workspaceId: binding.workspaceId },
      },
    } as any;
    const successor = {
      contextSnapshot: {
        issueId: binding.issueId,
        automaticSuccessorIntentId: "intent-1",
        productiveContinuation: true,
      },
    } as any;

    expect(
      productiveContinuationBindingFromRuns(predecessor, successor, binding.issueId),
    ).toEqual(binding);
    expect(
      productiveContinuationBindingFromRuns(
        predecessor,
        { contextSnapshot: { issueId: binding.issueId } } as any,
        binding.issueId,
      ),
    ).toBeNull();
  });

  it("does not let productive recovery reinterpret a missing or terminal intent", () => {
    expect(decideProductiveRecoveryIntent(null)).toEqual({ kind: "skip" });
    expect(
      decideProductiveRecoveryIntent({ kind: "productive", status: "pending" }),
    ).toEqual({ kind: "materialize" });
    expect(
      decideProductiveRecoveryIntent({ kind: "productive", status: "materialized" }),
    ).toEqual({ kind: "skip" });
    expect(
      decideProductiveRecoveryIntent({ kind: "corrective", status: "pending" }),
    ).toEqual({ kind: "skip" });
    expect(
      decideProductiveRecoveryIntent({ kind: "terminal", status: "materialized" }),
    ).toEqual({ kind: "skip" });
    expect(
      decideProductiveRecoveryIntent({ kind: "terminal", status: "denied" }),
    ).toEqual({ kind: "skip" });
  });
});

describe("bound terminal disposition contract (version 2)", () => {
  function boundTerminal(overrides: Record<string, unknown> = {}) {
    return {
      version: 2,
      kind: "complete",
      companyId: binding.companyId,
      issueId: binding.issueId,
      agentId: binding.agentId,
      runId: binding.runId,
      workspaceId: binding.workspaceId,
      ...overrides,
    };
  }

  it("accepts an exactly bound terminal disposition as a terminal decision", () => {
    expect(
      parseProductiveRunDisposition({ runDisposition: boundTerminal() }, binding),
    ).toEqual({
      kind: "terminal",
      dispositionKind: "complete",
      disposition: boundTerminal(),
    });
  });

  it("accepts a bound terminal disposition for a run without a workspace", () => {
    const workspacelessBinding = { ...binding, workspaceId: null };
    expect(
      parseProductiveRunDisposition(
        { runDisposition: boundTerminal({ workspaceId: null }) },
        workspacelessBinding,
      ),
    ).toEqual({
      kind: "terminal",
      dispositionKind: "complete",
      disposition: boundTerminal({ workspaceId: null }),
    });
  });

  it.each([
    ["wrong company", { companyId: "company-2" }],
    ["wrong issue", { issueId: "issue-2" }],
    ["missing issue scope", { issueId: null }],
    ["wrong agent", { agentId: "agent-2" }],
    ["wrong run", { runId: "run-2" }],
    ["wrong workspace", { workspaceId: "workspace-2" }],
    ["missing workspace", { workspaceId: null }],
  ])("denies a terminal disposition with %s", (_label, override) => {
    expect(
      parseProductiveRunDisposition(
        { runDisposition: boundTerminal(override) },
        binding,
      ),
    ).toEqual({ kind: "denied", reason: "authorization_binding_mismatch" });
  });

  it.each(["blocked", "needs_human", "in_review", "cancelled"])(
    "accepts a bound %s disposition as a terminal decision",
    (kind) => {
      expect(
        parseProductiveRunDisposition(
          { runDisposition: boundTerminal({ kind }) },
          binding,
        ),
      ).toEqual({
        kind: "terminal",
        dispositionKind: kind,
        disposition: boundTerminal({ kind }),
      });
    },
  );

  it("accepts an exactly bound version-two continuation", () => {
    expect(
      parseProductiveRunDisposition(
        { runDisposition: disposition({ version: 2 }) },
        binding,
      ),
    ).toEqual({
      kind: "continue_same_issue",
      disposition: disposition({ version: 2 }),
    });
  });

  it.each([
    ["wrong issue", { version: 2, issueId: "issue-2" }, "authorization_binding_mismatch"],
    ["wrong workspace", { version: 2, workspaceId: "workspace-2" }, "authorization_binding_mismatch"],
    ["wrong checkpoint run", { version: 2, checkpoint: { kind: "run_workspace", runId: "run-2", workspaceId: binding.workspaceId } }, "checkpoint_invalid"],
    ["empty next action", { version: 2, nextAction: "  " }, "next_action_invalid"],
  ])("denies a version-two continuation with %s", (_label, override, reason) => {
    expect(
      parseProductiveRunDisposition(
        { runDisposition: disposition(override) },
        binding,
      ),
    ).toEqual({ kind: "denied", reason });
  });

  it("keeps legacy version-one terminal dispositions on the no-successor path", () => {
    expect(
      parseProductiveRunDisposition(
        { runDisposition: { version: 1, kind: "complete" } },
        binding,
      ),
    ).toEqual({ kind: "no_successor", dispositionKind: "complete" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("automatic successor arbitration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-productive-continuation-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows competing automatic paths to create one intent for a predecessor", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const predecessorRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Continuation arbitration",
      issuePrefix: `CA${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Continuation agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue one issue",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: predecessorRunId,
      companyId,
      agentId,
      status: "succeeded",
      finishedAt: new Date(),
      contextSnapshot: { issueId },
    });

    const base = {
      companyId,
      issueId,
      agentId,
      predecessorRunId,
      chainRootRunId: predecessorRunId,
      checkpointRef: `run-workspace:${predecessorRunId}:workspace-1`,
      authorizationBinding: { issueId, agentId, workspaceId: "workspace-1" },
      policyVersion: 1,
      reason: "explicit_disposition",
    };
    const [productive, corrective] = await Promise.all([
      claimAutomaticSuccessorIntent(db, { ...base, kind: "productive" }),
      claimAutomaticSuccessorIntent(db, { ...base, kind: "corrective" }),
    ]);

    expect([productive.created, corrective.created].filter(Boolean)).toHaveLength(1);
    expect(productive.intent.id).toBe(corrective.intent.id);
    const rows = await db.select().from(automaticSuccessorIntents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      issueId,
      agentId,
      predecessorRunId,
      status: "pending",
    });
    expect(buildAutomaticSuccessorWakeIdempotencyKey(rows[0]!.id)).toBe(
      `automatic-successor:${rows[0]!.id}`,
    );

    const wakeupRequestId = randomUUID();
    const successorRunId = randomUUID();
    await settleAutomaticSuccessorIntent(db, {
      intentId: rows[0]!.id,
      outcome: "materialized",
      wakeupRequestId,
      successorRunId,
    });
    await settleAutomaticSuccessorIntent(db, {
      intentId: rows[0]!.id,
      outcome: "denied",
      denialReason: "materialization_denied",
    });
    const [settled] = await db
      .select()
      .from(automaticSuccessorIntents)
      .where(eq(automaticSuccessorIntents.id, rows[0]!.id));
    expect(settled).toMatchObject({
      status: "materialized",
      wakeupRequestId,
      successorRunId,
      denialReason: null,
    });
  });
});

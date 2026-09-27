import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";

export type IssueTaskBlockerState = {
  blockerIssueId: string;
  blockerKind: string;
  requiredEvidenceVersion: string;
  resolutionState: "unresolved" | "resolved";
  evidenceRevision: number;
};

export type IssueTaskMaterialState = {
  issue: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    executionPolicy: unknown;
    executionState: unknown;
    unblockDescriptor: unknown;
  };
  blockers: IssueTaskBlockerState[];
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildIssueTaskStateFingerprint(
  input: IssueTaskMaterialState,
): string {
  const canonical = {
    issue: input.issue,
    blockers: [...input.blockers].sort((left, right) =>
      [
        left.blockerIssueId,
        left.blockerKind,
        left.requiredEvidenceVersion,
        left.resolutionState,
        left.evidenceRevision,
      ].join("\u001f").localeCompare(
        [
          right.blockerIssueId,
          right.blockerKind,
          right.requiredEvidenceVersion,
          right.resolutionState,
          right.evidenceRevision,
        ].join("\u001f"),
      ),
    ),
  };
  return createHash("sha256")
    .update(stableStringify(canonical))
    .digest("hex")
    .slice(0, 32);
}

export async function loadIssueTaskStateFingerprint(input: {
  db: Db;
  companyId: string;
  issueId: string;
}): Promise<string | null> {
  const issue = await input.db
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
      unblockDescriptor: issues.unblockDescriptor,
    })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return null;

  const blockers = await input.db
    .select({
      blockerIssueId: issueRelations.issueId,
      blockerKind: issueRelations.blockerKind,
      requiredEvidenceVersion: issueRelations.requiredEvidenceVersion,
      resolutionState: issueRelations.resolutionState,
      evidenceRevision: issueRelations.evidenceRevision,
    })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.relatedIssueId, input.issueId),
        eq(issueRelations.type, "blocks"),
      ),
    );

  return buildIssueTaskStateFingerprint({ issue, blockers });
}

export type IssueContinuityWorkOutcome =
  | "productive"
  | "blocked"
  | "no_progress"
  | "provider_error"
  | "telemetry_missing"
  | "budget_exhausted"
  | "cancelled";

export function transitionIssueContinuityState(input: {
  terminalStatus: string;
  fingerprintBefore: string;
  fingerprintAfter: string;
  previousNoProgressStreak: number;
  /** Only an explicit zero from a validated adapter result denies provider work. */
  successfulProviderResponses?: number;
  /** An explicit empty Hermes result cannot establish useful work. */
  hasVisibleResponse?: boolean;
  authorizedHumanResume?: boolean;
  forcedOutcome?: "telemetry_missing" | "budget_exhausted" | "blocked";
}): {
  workOutcome: IssueContinuityWorkOutcome;
  noProgressStreak: number;
  circuitState: "closed" | "open";
  openedNow: boolean;
} {
  if (input.forcedOutcome) {
    return {
      workOutcome: input.forcedOutcome,
      noProgressStreak: input.previousNoProgressStreak + 1,
      circuitState: "open",
      openedNow: true,
    };
  }
  if (input.terminalStatus === "cancelled") {
    return {
      workOutcome: "cancelled",
      noProgressStreak: 0,
      circuitState: "closed",
      openedNow: false,
    };
  }
  if (input.terminalStatus !== "succeeded") {
    return {
      workOutcome: "provider_error",
      noProgressStreak: 0,
      circuitState: "closed",
      openedNow: false,
    };
  }
  if (input.fingerprintBefore !== input.fingerprintAfter &&
      input.successfulProviderResponses !== 0 && input.hasVisibleResponse !== false) {
    return {
      workOutcome: "productive",
      noProgressStreak: 0,
      circuitState: "closed",
      openedNow: false,
    };
  }

  const previousNoProgressStreak = input.authorizedHumanResume
    ? 0
    : input.previousNoProgressStreak;
  const noProgressStreak = previousNoProgressStreak + 1;
  const circuitState = noProgressStreak >= 2 ? "open" : "closed";
  return {
    workOutcome: "no_progress",
    noProgressStreak,
    circuitState,
    openedNow: circuitState === "open" && previousNoProgressStreak < 2,
  };
}

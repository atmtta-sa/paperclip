import { describe, expect, it } from "vitest";
import {
  buildIssueTaskStateFingerprint,
  transitionIssueContinuityState,
} from "./issue-continuity-state.js";

const MATERIAL_STATE = {
  issue: {
    id: "issue-1",
    title: "Ship continuity guard",
    description: "Stop unchanged autonomous wakes",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    executionPolicy: { budget: { requests: 8, tokens: 200_000 } },
    executionState: { phase: "implementation" },
    unblockDescriptor: null,
  },
  blockers: [
    {
      blockerIssueId: "blocker-1",
      blockerKind: "issue_dependency",
      requiredEvidenceVersion: "issue_done_v1",
      resolutionState: "resolved" as const,
      evidenceRevision: 2,
    },
  ],
};

describe("issue continuity state", () => {
  it("builds the same fingerprint for semantically identical material state", () => {
    const reordered = {
      blockers: [...MATERIAL_STATE.blockers].reverse(),
      issue: {
        ...MATERIAL_STATE.issue,
        executionPolicy: { budget: { tokens: 200_000, requests: 8 } },
      },
    };

    expect(buildIssueTaskStateFingerprint(MATERIAL_STATE)).toBe(
      buildIssueTaskStateFingerprint(reordered),
    );
  });

  it("changes the fingerprint when material task state changes", () => {
    const changed = {
      ...MATERIAL_STATE,
      issue: { ...MATERIAL_STATE.issue, status: "blocked" },
    };

    expect(buildIssueTaskStateFingerprint(changed)).not.toBe(
      buildIssueTaskStateFingerprint(MATERIAL_STATE),
    );
  });

  it("opens the circuit on the second same-fingerprint no-progress outcome", () => {
    expect(
      transitionIssueContinuityState({
        terminalStatus: "succeeded",
        fingerprintBefore: "same",
        fingerprintAfter: "same",
        previousNoProgressStreak: 1,
      }),
    ).toEqual({
      workOutcome: "no_progress",
      noProgressStreak: 2,
      circuitState: "open",
      openedNow: true,
    });
  });

  it.each(["telemetry_missing", "budget_exhausted"] as const)(
    "opens the circuit immediately for %s",
    (forcedOutcome) => {
      expect(
        transitionIssueContinuityState({
          terminalStatus: "failed",
          fingerprintBefore: "same",
          fingerprintAfter: "same",
          previousNoProgressStreak: 0,
          forcedOutcome,
        }),
      ).toEqual({
        workOutcome: forcedOutcome,
        noProgressStreak: 1,
        circuitState: "open",
        openedNow: true,
      });
    },
  );

  it("resets an open circuit when an authorized human explicitly resumes", () => {
    expect(
      transitionIssueContinuityState({
        terminalStatus: "succeeded",
        fingerprintBefore: "same",
        fingerprintAfter: "same",
        previousNoProgressStreak: 2,
        authorizedHumanResume: true,
      }),
    ).toEqual({
      workOutcome: "no_progress",
      noProgressStreak: 1,
      circuitState: "closed",
      openedNow: false,
    });
  });

  it("resets the streak and closes the circuit after a verified fingerprint change", () => {
    expect(
      transitionIssueContinuityState({
        terminalStatus: "succeeded",
        fingerprintBefore: "before",
        fingerprintAfter: "after",
        previousNoProgressStreak: 2,
      }),
    ).toEqual({
      workOutcome: "productive",
      noProgressStreak: 0,
      circuitState: "closed",
      openedNow: false,
    });
  });
});

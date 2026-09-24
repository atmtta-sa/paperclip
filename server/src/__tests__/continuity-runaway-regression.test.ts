import { describe, expect, it } from "vitest";
import {
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
} from "../services/issue-rewake-throttle.ts";

const NOW = new Date("2026-09-20T08:30:00.000Z");

describe("September 20 continuity runaway regression", () => {
  it("admits no repeated blocker-resolution wake after an unchanged no-progress streak", () => {
    const recentTerminalRuns = [
      {
        id: "run-2",
        status: "succeeded",
        finishedAt: new Date(NOW.getTime() - 10_000),
      },
      {
        id: "run-1",
        status: "succeeded",
        finishedAt: new Date(NOW.getTime() - 40_000),
      },
    ];

    let admitted = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const throttleEligible = isThrottleCandidateIssueRewake({
        reason: "issue_blockers_resolved",
        wakeCommentId: null,
        requestedByActorType: "system",
        forceFreshSession: false,
        hasExplicitResume: false,
      });
      const blocked = throttleEligible
        ? evaluateIssueRewakeThrottle({
            now: NOW,
            recentTerminalRuns,
            runIdsWithIssueProgress: new Set(),
            hasNewIssueInputSinceLastRun: false,
          }).blocked
        : false;
      if (!blocked) admitted += 1;
    }

    expect(admitted).toBe(0);
  });
});
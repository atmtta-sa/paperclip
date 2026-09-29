import { describe, expect, it } from "vitest";
import {
  LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT,
  nextLogicalExecutionIdentity,
} from "./logical-execution.js";

describe("logical execution identity", () => {
  it("ignores caller-supplied identity on a root run", () => {
    expect(nextLogicalExecutionIdentity({
      id: "root-run",
      retryOfRunId: null,
      contextSnapshot: {
        logicalExecution: {
          key: "attacker-key",
          rootRunId: "attacker-root",
          providerAttempt: 1,
        },
      },
      resultJson: {
        executionRecovery: { providerWorkStarted: true },
      },
    }, "issue-1")).toEqual({
      key: "issue:issue-1:generation:root-run",
      rootRunId: "root-run",
      providerAttempt: 2,
    });
  });

  it("fails closed when a descendant loses its durable identity", () => {
    expect(nextLogicalExecutionIdentity({
      id: "child-run",
      retryOfRunId: "root-run",
      contextSnapshot: {},
      resultJson: {
        executionRecovery: { providerWorkStarted: false },
      },
    }, "issue-1")).toMatchObject({
      providerAttempt: LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT + 1,
    });
  });
});

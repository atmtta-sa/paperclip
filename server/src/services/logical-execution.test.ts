import { describe, expect, it } from "vitest";
import {
  LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT,
  evaluateAutomaticSuccessorAdmission,
  nextLogicalExecutionIdentity,
  startLogicalExecutionIdentity,
} from "./logical-execution.js";

describe("logical execution identity", () => {
  it("admits four bounded provider attempts and denies the fifth", () => {
    expect(LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT).toBe(4);
    expect(evaluateAutomaticSuccessorAdmission({
      nextProviderAttempt: 4,
      committedRootChainRequests: 12,
      requestedRequestCount: 4,
      maxRootChainProviderRequests: 16,
    })).toEqual({ eligible: true });
    expect(evaluateAutomaticSuccessorAdmission({
      nextProviderAttempt: 5,
      committedRootChainRequests: 12,
      requestedRequestCount: 4,
      maxRootChainProviderRequests: 16,
    })).toEqual({
      eligible: false,
      reason: "logical_execution_provider_attempt_limit_exhausted",
    });
  });

  it("denies a requested envelope that exceeds remaining root-chain capacity", () => {
    expect(evaluateAutomaticSuccessorAdmission({
      nextProviderAttempt: 3,
      committedRootChainRequests: 9,
      requestedRequestCount: 4,
      maxRootChainProviderRequests: 12,
    })).toEqual({
      eligible: false,
      reason: "logical_execution_root_chain_request_budget_exhausted",
    });
  });

  it("reports provider-attempt exhaustion when request capacity remains", () => {
    expect(evaluateAutomaticSuccessorAdmission({
      nextProviderAttempt: LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT + 1,
      committedRootChainRequests: 2,
      requestedRequestCount: 1,
      maxRootChainProviderRequests: 12,
    })).toEqual({
      eligible: false,
      reason: "logical_execution_provider_attempt_limit_exhausted",
    });
  });

  it("gives root-chain exhaustion deterministic precedence", () => {
    expect(evaluateAutomaticSuccessorAdmission({
      nextProviderAttempt: LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT + 1,
      committedRootChainRequests: 12,
      requestedRequestCount: 4,
      maxRootChainProviderRequests: 12,
    })).toEqual({
      eligible: false,
      reason: "logical_execution_root_chain_request_budget_exhausted",
    });
  });

  it("starts a fresh bounded generation for a session rollover successor", () => {
    expect(startLogicalExecutionIdentity("rollover-run", "issue-1")).toEqual({
      key: "issue:issue-1:generation:rollover-run",
      rootRunId: "rollover-run",
      providerAttempt: 1,
    });
  });

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

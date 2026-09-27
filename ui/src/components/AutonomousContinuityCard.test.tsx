import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutonomousContinuityCard } from "./AutonomousContinuityCard";
import type { AutonomousContinuitySnapshot } from "../api/budgets";

const snapshot: AutonomousContinuitySnapshot = {
  companyId: "company-1", paused: true, autonomousPaused: true,
  totals: { runs: 1, requests: 8, inputTokens: 64000, outputTokens: 8000,
    costMicrousd: 250000, held: 1, missingTelemetry: 1 },
  circuitAlerts: [{ id: "alert-1", issueId: "task-1", agentId: "agent-1", runId: "run-1",
    stateFingerprint: "same", circuitOpenedAt: "2026-09-27T00:00:00Z",
    createdAt: "2026-09-27T00:00:00Z" }],
  promptGrowthAlerts: [{ id: "growth-1", issueId: "task-1", agentId: "agent-1", runId: "run-1",
    previousInputTokens: 10_000, actualInputTokens: 35_000, createdAt: "2026-09-27T00:00:00Z" }],
  costVelocityAlerts: [{ id: "velocity-1", companyId: "company-1", agentId: "agent-1",
    runId: "run-1", committedCostMicrousd: 300_000, dailyLimitMicrousd: 1_000_000,
    windowMinutes: 15, createdAt: "2026-09-27T00:00:00Z" }],
  policyLimits: [
    { id: "policy-1", scopeType: "company", scopeId: "company-1", metric: "billed_microusd",
      windowKind: "calendar_day_utc", amount: 1_000_000, committed: 300_000, remaining: 700_000 },
    { id: "policy-2", scopeType: "task", scopeId: "task-1", metric: "request_count",
      windowKind: "per_run", amount: 8, committed: null, remaining: null },
  ],
  recent: [{ runId: "run-1", agentId: "agent-1", issueId: "task-1",
    agentAutonomousPaused: false, taskAutonomousPaused: true,
    reservationStatus: "retained_missing_telemetry", reservedCostMicrousd: 250000,
    actualCostMicrousd: null, workOutcome: "telemetry_missing", fingerprintBefore: "same",
    fingerprintAfter: "same", noProgressStreak: 2, circuitState: "open",
    stopReason: "missing_usage", createdAt: "2026-09-27T00:00:00Z" }],
};

describe("AutonomousContinuityCard", () => {
  it("makes retained telemetry and unknown charge visible", () => {
    const html = renderToStaticMarkup(<AutonomousContinuityCard snapshot={snapshot} loading={false} error={false} />);
    expect(html).toContain("Missing telemetry: 1");
    expect(html).toContain("unverified");
    expect(html).toContain("circuit open");
    expect(html).toContain("Circuit opened alerts");
    expect(html).toContain("Prompt growth alerts (in-app audit only");
    expect(html).toContain("10,000 → 35,000");
    expect(html).toContain("Committed-cost velocity (in-app audit only");
    expect(html).toContain("$0.3000 of $1.0000 daily cap in 15 minutes");
    expect(html).toContain("Remaining policy allowance (committed ledger, not provider billing)");
    expect(html).toContain("$0.7000 remaining of $1.0000");
    expect(html).toContain("8 requests per run (no cumulative remaining)");
    expect(html).toContain("task-1");
    expect(html).toContain("not externally delivered");
    expect(html).toContain("Effective execution state: Paused");
    expect(html).toContain("not verified provider billing");
  });
  it("does not present an inaccessible ledger as zero", () => {
    const html = renderToStaticMarkup(<AutonomousContinuityCard loading={false} error />);
    expect(html).toContain("Continuity ledger unavailable");
    expect(html).not.toContain("Requests: 0");
  });
  it("offers pause only while the dedicated control is not set", () => {
    const active = renderToStaticMarkup(<AutonomousContinuityCard
      snapshot={{ ...snapshot, paused: false, autonomousPaused: false }}
      loading={false} error={false} onPause={() => undefined} />);
    expect(active).toContain("Pause new autonomous dispatches");
    const paused = renderToStaticMarkup(<AutonomousContinuityCard
      snapshot={snapshot} loading={false} error={false} onPause={() => undefined} />);
    expect(paused).not.toContain("<button");
  });
  it("offers scoped agent pause and task resume from persisted flags", () => {
    const html = renderToStaticMarkup(<AutonomousContinuityCard
      snapshot={snapshot} loading={false} error={false}
      onScopedPause={() => undefined} />);
    expect(html).toContain("Pause agent agent-1");
    expect(html).toContain("Resume task task-1");
    expect(html).not.toContain("Resume agent agent-1");
    expect(html).not.toContain("Pause task task-1");
  });
});

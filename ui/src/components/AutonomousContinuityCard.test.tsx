import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutonomousContinuityCard } from "./AutonomousContinuityCard";
import type { AutonomousContinuitySnapshot } from "../api/budgets";

const snapshot: AutonomousContinuitySnapshot = {
  companyId: "company-1", paused: true, autonomousPaused: true,
  totals: { runs: 1, requests: 8, inputTokens: 64000, outputTokens: 8000,
    costMicrousd: 250000, held: 1, missingTelemetry: 1 },
  recent: [{ runId: "run-1", agentId: "agent-1", issueId: "task-1",
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
});

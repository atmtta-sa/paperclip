import type { AutonomousContinuitySnapshot } from "../api/budgets";

function usd(microusd: number) {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

export function AutonomousContinuityCard({ snapshot, loading, error }: {
  snapshot?: AutonomousContinuitySnapshot;
  loading: boolean;
  error: boolean;
}) {
  return (
    <section aria-label="Autonomous continuity" className="rounded-lg border border-border p-4 space-y-3">
      <h2 className="text-lg font-semibold">Autonomous continuity</h2>
      {error ? <p role="alert" className="text-destructive">Continuity ledger unavailable. Do not assume zero usage.</p>
        : loading || !snapshot ? <p>Loading continuity ledger…</p>
        : <>
          <p>Company execution: {snapshot.paused ? "Paused" : "Active"}. All-time ledger commitments, not verified provider billing or remaining allowance.</p>
          <p>Runs: {snapshot.totals.runs} · Requests: {snapshot.totals.requests} · Input: {snapshot.totals.inputTokens} · Output: {snapshot.totals.outputTokens} · Committed: {usd(snapshot.totals.costMicrousd)}</p>
          {snapshot.totals.missingTelemetry > 0 ? <p role="alert" className="text-destructive">Missing telemetry: {snapshot.totals.missingTelemetry} retained reservations. Automation must remain blocked.</p> : null}
          <p>Held reservations: {snapshot.totals.held}</p>
          <ul className="space-y-2">
            {snapshot.recent.map((run) => <li key={run.runId} className="border-t border-border pt-2 text-sm break-words">
              <span className="font-mono">{run.runId}</span> · agent {run.agentId} · task {run.issueId ?? "unlinked"} · {run.workOutcome ?? "outcome unknown"} · {run.reservationStatus} · circuit {run.circuitState ?? "unknown"} · streak {run.noProgressStreak ?? "unknown"}
              <span className="block">Fingerprint {run.fingerprintBefore ?? "unknown"} → {run.fingerprintAfter ?? "unknown"}; stop {run.stopReason ?? "none recorded"}; reserved {usd(run.reservedCostMicrousd)}, actual {run.actualCostMicrousd == null ? "unverified" : usd(run.actualCostMicrousd)}</span>
            </li>)}
          </ul>
        </>}
    </section>
  );
}

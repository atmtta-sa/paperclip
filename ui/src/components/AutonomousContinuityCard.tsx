import type { AutonomousContinuitySnapshot } from "../api/budgets";

function usd(microusd: number) {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

export function AutonomousContinuityCard({ snapshot, loading, error, onPause, pausing, pauseError }: {
  snapshot?: AutonomousContinuitySnapshot;
  loading: boolean;
  error: boolean;
  onPause?: () => void;
  pausing?: boolean;
  pauseError?: boolean;
}) {
  return (
    <section aria-label="Autonomous continuity" className="rounded-lg border border-border p-4 space-y-3">
      <h2 className="text-lg font-semibold">Autonomous continuity</h2>
      {error ? <p role="alert" className="text-destructive">Continuity ledger unavailable. Do not assume zero usage.</p>
        : loading || !snapshot ? <p>Loading continuity ledger…</p>
        : <>
          <p>Effective execution state: {snapshot.paused ? "Paused" : "Active"}. All-time ledger commitments, not verified provider billing or remaining allowance.</p>
          <p>New autonomous dispatches: {snapshot.autonomousPaused ? "Paused" : "Allowed by pause control"}. Already-running requests are not cancelled.</p>
          {!snapshot.autonomousPaused && onPause ? <button type="button" onClick={onPause} disabled={pausing}
            className="rounded border border-destructive px-3 py-1 text-destructive disabled:opacity-50">
            {pausing ? "Pausing…" : "Pause new autonomous dispatches"}
          </button> : null}
          {pauseError ? <p role="alert" className="text-destructive">Pause failed; check the control state before retrying.</p> : null}
          <p>Runs: {snapshot.totals.runs} · Requests: {snapshot.totals.requests} · Input: {snapshot.totals.inputTokens} · Output: {snapshot.totals.outputTokens} · Committed: {usd(snapshot.totals.costMicrousd)}</p>
          {snapshot.totals.missingTelemetry > 0 ? <p role="alert" className="text-destructive">Missing telemetry: {snapshot.totals.missingTelemetry} retained reservations. Automation must remain blocked.</p> : null}
          <p>Held reservations: {snapshot.totals.held}</p>
          {snapshot.circuitAlerts.length > 0 ? <div role="alert" className="border border-destructive rounded p-2 text-sm">
            <p>Circuit opened alerts (in-app audit only; not externally delivered):</p>
            <ul>{snapshot.circuitAlerts.map((alert) => <li key={alert.id}>
              Task {alert.issueId} · agent {alert.agentId ?? "unknown"} · run {alert.runId ?? "unknown"} · fingerprint {alert.stateFingerprint ?? "unknown"} · opened {alert.circuitOpenedAt ?? "unknown"}
            </li>)}</ul>
          </div> : null}
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

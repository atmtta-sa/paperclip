import type { AutonomousContinuitySnapshot } from "../api/budgets";

function usd(microusd: number) {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

function policyAmount(metric: AutonomousContinuitySnapshot["policyLimits"][number]["metric"], value: number) {
  if (metric === "billed_cents") return usd(value * 10_000);
  if (metric === "billed_microusd") return usd(value);
  const unit = metric === "request_count" ? " requests" : metric === "runtime_ms" ? " ms" : " tokens";
  return `${value.toLocaleString()}${unit}`;
}

export function AutonomousContinuityCard({ snapshot, loading, error, onPause, pausing, pauseError,
  onScopedPause, scopedPausePending, scopedPauseError }: {
  snapshot?: AutonomousContinuitySnapshot;
  loading: boolean;
  error: boolean;
  onPause?: () => void;
  pausing?: boolean;
  pauseError?: boolean;
  onScopedPause?: (scopeType: "agent" | "task", scopeId: string, paused: boolean) => void;
  scopedPausePending?: boolean;
  scopedPauseError?: boolean;
}) {
  return (
    <section aria-label="Autonomous continuity" className="rounded-lg border border-border p-4 space-y-3">
      <h2 className="text-lg font-semibold">Autonomous continuity</h2>
      {error ? <p role="alert" className="text-destructive">Continuity ledger unavailable. Do not assume zero usage.</p>
        : loading || !snapshot ? <p>Loading continuity ledger…</p>
        : <>
          <p>Effective execution state: {snapshot.paused ? "Paused" : "Active"}. All-time ledger commitments, not verified provider billing. Policy allowances below use current windows.</p>
          <p>New autonomous dispatches: {snapshot.autonomousPaused ? "Paused" : "Allowed by pause control"}. Already-running requests are not cancelled.</p>
          {!snapshot.autonomousPaused && onPause ? <button type="button" onClick={onPause} disabled={pausing}
            className="rounded border border-destructive px-3 py-1 text-destructive disabled:opacity-50">
            {pausing ? "Pausing…" : "Pause new autonomous dispatches"}
          </button> : null}
          {pauseError ? <p role="alert" className="text-destructive">Pause failed; check the control state before retrying.</p> : null}
          {scopedPauseError ? <p role="alert" className="text-destructive">Scoped pause change failed; check the control state before retrying.</p> : null}
          <p>Runs: {snapshot.totals.runs} · Requests: {snapshot.totals.requests} · Input: {snapshot.totals.inputTokens} · Output: {snapshot.totals.outputTokens} · Committed: {usd(snapshot.totals.costMicrousd)}</p>
          {snapshot.totals.missingTelemetry > 0 ? <p role="alert" className="text-destructive">Missing telemetry: {snapshot.totals.missingTelemetry} retained reservations. Automation must remain blocked.</p> : null}
          <p>Held reservations: {snapshot.totals.held}</p>
          <div className="text-sm">
            <p>Remaining policy allowance (committed ledger, not provider billing):</p>
            {snapshot.policyLimits.length === 0 ? <p>No active hard-stop company/agent/task policies.</p> :
              <ul>{snapshot.policyLimits.map((policy) => <li key={policy.id}>
                {policy.scopeType} {policy.scopeId} · {policy.metric} · {policy.windowKind === "per_run"
                  ? <>{policyAmount(policy.metric, policy.amount)} per run (no cumulative remaining)</>
                  : <>{policyAmount(policy.metric, policy.remaining ?? 0)} remaining of {policyAmount(policy.metric, policy.amount)} · {policy.windowKind === "calendar_day_utc" ? "UTC day" : policy.windowKind === "calendar_month_utc" ? "UTC month" : "lifetime"} · committed {policyAmount(policy.metric, policy.committed ?? 0)}</>}
              </li>)}</ul>}
          </div>
          {snapshot.circuitAlerts.length > 0 ? <div role="alert" className="border border-destructive rounded p-2 text-sm">
            <p>Circuit opened alerts (in-app audit only; not externally delivered):</p>
            <ul>{snapshot.circuitAlerts.map((alert) => <li key={alert.id}>
              Task {alert.issueId} · agent {alert.agentId ?? "unknown"} · run {alert.runId ?? "unknown"} · fingerprint {alert.stateFingerprint ?? "unknown"} · opened {alert.circuitOpenedAt ?? "unknown"}
            </li>)}</ul>
          </div> : null}
          {snapshot.promptGrowthAlerts.length > 0 ? <div role="alert" className="border border-destructive rounded p-2 text-sm">
            <p>Prompt growth alerts (in-app audit only; not externally delivered):</p>
            <ul>{snapshot.promptGrowthAlerts.map((alert) => <li key={alert.id}>
              Task {alert.issueId} · agent {alert.agentId ?? "unknown"} · run {alert.runId ?? "unknown"} · input tokens {alert.previousInputTokens.toLocaleString()} → {alert.actualInputTokens.toLocaleString()}
            </li>)}</ul>
          </div> : null}
          {snapshot.costVelocityAlerts.length > 0 ? <div role="alert" className="border border-destructive rounded p-2 text-sm">
            <p>Committed-cost velocity (in-app audit only; not externally delivered; not verified provider billing):</p>
            <ul>{snapshot.costVelocityAlerts.map((alert) => <li key={alert.id}>
              Agent {alert.agentId ?? "unknown"} · run {alert.runId ?? "unknown"} · {usd(alert.committedCostMicrousd)} of {usd(alert.dailyLimitMicrousd)} daily cap in {alert.windowMinutes} minutes
            </li>)}</ul>
          </div> : null}
          <ul className="space-y-2">
            {snapshot.recent.map((run) => <li key={run.runId} className="border-t border-border pt-2 text-sm break-words">
              <span className="font-mono">{run.runId}</span> · agent {run.agentId} · task {run.issueId ?? "unlinked"} · {run.workOutcome ?? "outcome unknown"} · {run.reservationStatus} · circuit {run.circuitState ?? "unknown"} · streak {run.noProgressStreak ?? "unknown"}
              <span className="block">Fingerprint {run.fingerprintBefore ?? "unknown"} → {run.fingerprintAfter ?? "unknown"}; stop {run.stopReason ?? "none recorded"}; reserved {usd(run.reservedCostMicrousd)}, actual {run.actualCostMicrousd == null ? "unverified" : usd(run.actualCostMicrousd)}</span>
              {onScopedPause && run.agentAutonomousPaused != null
                && snapshot.recent.findIndex((item) => item.agentId === run.agentId) === snapshot.recent.indexOf(run)
                ? <button type="button" disabled={scopedPausePending}
                  className="rounded border border-border px-2 py-1 mr-2 disabled:opacity-50"
                  onClick={() => onScopedPause("agent", run.agentId, !run.agentAutonomousPaused)}>
                  {run.agentAutonomousPaused ? "Resume" : "Pause"} agent {run.agentId}
                </button> : null}
              {onScopedPause && run.issueId && run.taskAutonomousPaused != null
                && snapshot.recent.findIndex((item) => item.issueId === run.issueId) === snapshot.recent.indexOf(run)
                ? <button type="button" disabled={scopedPausePending}
                  className="rounded border border-border px-2 py-1 disabled:opacity-50"
                  onClick={() => onScopedPause("task", run.issueId!, !run.taskAutonomousPaused)}>
                  {run.taskAutonomousPaused ? "Resume" : "Pause"} task {run.issueId}
                </button> : null}
            </li>)}
          </ul>
        </>}
    </section>
  );
}

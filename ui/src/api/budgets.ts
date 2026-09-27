import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetOverview,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
} from "@paperclipai/shared";
import { api } from "./client";

export type AutonomousContinuitySnapshot = {
  companyId: string;
  paused: boolean;
  autonomousPaused: boolean;
  totals: {
    runs: number; requests: number; inputTokens: number; outputTokens: number;
    costMicrousd: number; held: number; missingTelemetry: number;
  };
  circuitAlerts: Array<{
    id: string; issueId: string; agentId: string | null; runId: string | null;
    stateFingerprint: string | null; circuitOpenedAt: string | null; createdAt: string;
  }>;
  promptGrowthAlerts: Array<{
    id: string; issueId: string; agentId: string | null; runId: string | null;
    previousInputTokens: number; actualInputTokens: number; createdAt: string;
  }>;
  costVelocityAlerts: Array<{
    id: string; companyId: string; agentId: string | null; runId: string | null;
    committedCostMicrousd: number; dailyLimitMicrousd: number; windowMinutes: number;
    createdAt: string;
  }>;
  policyLimits: Array<{
    id: string; scopeType: "company" | "agent" | "task"; scopeId: string;
    metric: "billed_cents" | "billed_microusd" | "request_count" | "input_tokens" | "output_tokens" | "runtime_ms";
    windowKind: "per_run" | "calendar_day_utc" | "calendar_month_utc" | "lifetime";
    amount: number; committed: number | null; remaining: number | null;
  }>;
  recent: Array<{
    runId: string; agentId: string; issueId: string | null;
    agentAutonomousPaused: boolean | null; taskAutonomousPaused: boolean | null;
    reservationStatus: string; reservedCostMicrousd: number; actualCostMicrousd: number | null;
    workOutcome: string | null; fingerprintBefore: string | null;
    fingerprintAfter: string | null; noProgressStreak: number | null;
    circuitState: string | null; stopReason: string | null; createdAt: string;
  }>;
};

export const budgetsApi = {
  overview: (companyId: string) =>
    api.get<BudgetOverview>(`/companies/${companyId}/budgets/overview`),
  autonomousContinuity: (companyId: string) =>
    api.get<AutonomousContinuitySnapshot>(`/companies/${companyId}/budgets/autonomous-continuity`),
  pauseAutonomous: (companyId: string) =>
    api.post<{ companyId: string; paused: boolean }>(`/companies/${companyId}/budgets/autonomous-pause`, { paused: true }),
  setScopedAutonomousPause: (companyId: string, scopeType: "agent" | "task", scopeId: string, paused: boolean) =>
    api.post<{ companyId: string; scopeType: "agent" | "task"; scopeId: string; paused: boolean }>(
      `/companies/${companyId}/budgets/autonomous-pause/${scopeType}/${encodeURIComponent(scopeId)}`, { paused },
    ),
  upsertPolicy: (companyId: string, data: BudgetPolicyUpsertInput) =>
    api.post<BudgetPolicySummary>(`/companies/${companyId}/budgets/policies`, data),
  resolveIncident: (companyId: string, incidentId: string, data: BudgetIncidentResolutionInput) =>
    api.post<BudgetIncident>(
      `/companies/${companyId}/budget-incidents/${encodeURIComponent(incidentId)}/resolve`,
      data,
    ),
};

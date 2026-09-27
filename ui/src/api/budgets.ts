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
  totals: {
    runs: number; requests: number; inputTokens: number; outputTokens: number;
    costMicrousd: number; held: number; missingTelemetry: number;
  };
  recent: Array<{
    runId: string; agentId: string; issueId: string | null;
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
  upsertPolicy: (companyId: string, data: BudgetPolicyUpsertInput) =>
    api.post<BudgetPolicySummary>(`/companies/${companyId}/budgets/policies`, data),
  resolveIncident: (companyId: string, incidentId: string, data: BudgetIncidentResolutionInput) =>
    api.post<BudgetIncident>(
      `/companies/${companyId}/budget-incidents/${encodeURIComponent(incidentId)}/resolve`,
      data,
    ),
};

const APPROVAL_REQUIRED_ACTIONS = new Set([
  "bind_protected_repository",
  "invoke_provider_or_spend",
  "push_merge_or_deploy",
  "activate_production",
]);
const STANDING_AUTHORITY_ACTIONS = new Set([
  "review_stopped_work",
  "honor_wait",
  "resume_developer",
  "request_corrections",
  "release_next_task",
  "verify_project_uat",
  "await_naz_approval",
]);

export function authorizeTeamLeadAction({ action, scope, approval } = {}) {
  if (STANDING_AUTHORITY_ACTIONS.has(action)) {
    return { allowed: true, reason: "standing Team Lead authority" };
  }
  if (!APPROVAL_REQUIRED_ACTIONS.has(action)) {
    return { allowed: false, reason: `unknown Team Lead action ${String(action)}` };
  }

  const exactApproval =
    typeof scope === "string" &&
    scope.trim().length > 0 &&
    approval?.status === "accepted" &&
    approval?.action === action &&
    approval?.scope === scope &&
    approval?.bounded === true;
  if (!exactApproval) {
    return {
      allowed: false,
      reason: `explicit bounded approval required for ${action}`,
    };
  }

  return { allowed: true, reason: "exact bounded approval present" };
}

export const PROJECT_WATCHDOG_INSTRUCTIONS = [
  "Review every stopped task subtree for this project.",
  "Honor first-class blockers, approvals, interactions, queued wakes, and scheduled retries; do not create duplicate work.",
  "If acceptance criteria remain, return precise continuation instructions to the same developer and restore a live execution path.",
  "If required evidence is missing, failed, or duplicated, request corrections naming each exact gate.",
  "Accept a task only when every required gate has one passing report.",
  "At the final task, require a working UAT URL, exact testing steps, safe test data, and limitations from the developer.",
  "Independently verify the UAT URL and steps before presenting the project to Naz.",
  "Do not release the next project until Naz explicitly confirms testing_successful.",
].join("\n");

function normalizedStrings(values) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
    : [];
}

function evidenceCorrections(requiredGates, evidenceReports) {
  const reportsByGate = new Map();
  for (const report of Array.isArray(evidenceReports) ? evidenceReports : []) {
    if (!report || typeof report.gate !== "string") continue;
    const gate = report.gate.trim();
    if (!gate) continue;
    const reports = reportsByGate.get(gate) ?? [];
    reports.push(report);
    reportsByGate.set(gate, reports);
  }

  const corrections = [];
  for (const gate of normalizedStrings(requiredGates)) {
    const reports = reportsByGate.get(gate) ?? [];
    if (reports.length === 0) {
      corrections.push(`missing gate ${gate}`);
      continue;
    }
    if (reports.length > 1) {
      corrections.push(`duplicate evidence for gate ${gate}`);
      continue;
    }
    const [report] = reports;
    if (report.status !== "passed") {
      const detail = typeof report.detail === "string" && report.detail.trim()
        ? `: ${report.detail.trim()}`
        : "";
      corrections.push(`failed gate ${gate}${detail}`);
    }
  }
  return corrections;
}

function validUat(uat) {
  return Boolean(
    uat &&
    typeof uat.url === "string" &&
    uat.url.trim() &&
    Array.isArray(uat.steps) &&
    uat.steps.some((step) => typeof step === "string" && step.trim()),
  );
}

export function decideStoppedWork(input) {
  if (input?.pendingWait) {
    return { action: "honor_wait", wait: input.pendingWait };
  }

  const remaining = normalizedStrings(input?.remainingAcceptanceCriteria);
  if (remaining.length > 0) {
    return {
      action: "resume_developer",
      developerTaskId: input.developerTaskId,
      reasons: remaining.map((criterion) => `remaining acceptance criterion: ${criterion}`),
    };
  }

  const corrections = evidenceCorrections(input?.requiredGates, input?.evidenceReports);
  if (corrections.length > 0) {
    return {
      action: "request_corrections",
      developerTaskId: input.developerTaskId,
      reasons: corrections,
    };
  }

  if (!input?.projectFinalTask) {
    return { action: "release_next_task", completedTaskId: input.developerTaskId };
  }

  if (!validUat(input.uat)) {
    return { action: "request_uat_handoff", developerTaskId: input.developerTaskId };
  }

  if (input.uat.leadVerified !== true) {
    return { action: "verify_project_uat", developerTaskId: input.developerTaskId };
  }

  if (
    input?.nazApproval?.status !== "accepted" ||
    input?.nazApproval?.outcome !== "testing_successful"
  ) {
    return {
      action: "await_naz_approval",
      uat: { url: input.uat.url, steps: input.uat.steps },
    };
  }

  return { action: "release_next_project", completedTaskId: input.developerTaskId };
}

export function buildProjectWatchdogRequest(teamLeadAgentId) {
  if (typeof teamLeadAgentId !== "string" || !teamLeadAgentId.trim()) {
    throw new Error("Team Lead agent id is required");
  }
  return {
    agentId: teamLeadAgentId.trim(),
    instructions: PROJECT_WATCHDOG_INSTRUCTIONS,
  };
}

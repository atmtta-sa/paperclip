export type PaperclipHermesContextKind =
  | "objective"
  | "acceptance_criterion"
  | "constraint"
  | "directive"
  | "evidence"
  | "persona_ref"
  | "repository_instructions_ref"
  | "checkpoint_ref"
  | "continuation_summary";

export type PaperclipHermesContextAuthority =
  | "authoritative"
  | "verified"
  | "untrusted";

export interface PaperclipHermesContextSource {
  type: string;
  id: string;
}

export interface PaperclipHermesContextCandidate {
  kind: PaperclipHermesContextKind;
  key: string;
  value: unknown;
  authority: PaperclipHermesContextAuthority;
  precedence: number;
  revision: number;
  source: PaperclipHermesContextSource;
}

export interface PaperclipHermesContextIdentity {
  companyId: string;
  agentId: string;
  issueId: string;
  workspaceId: string;
  runId: string;
}

export interface PaperclipHermesContextEntry {
  kind: PaperclipHermesContextKind;
  key: string;
  value: unknown;
  authority: PaperclipHermesContextAuthority;
  precedence: number;
  revision: number;
  sources: PaperclipHermesContextSource[];
}

export interface PaperclipHermesContextV1 {
  version: 1;
  identity: PaperclipHermesContextIdentity;
  entries: PaperclipHermesContextEntry[];
}

export interface PaperclipHermesContextInput {
  identity: PaperclipHermesContextIdentity;
  candidates: PaperclipHermesContextCandidate[];
}

export interface PaperclipHermesIssueInput {
  id: string;
  title: string;
  description?: string | null;
}

export interface BuildPaperclipHermesContextInput {
  identity: PaperclipHermesContextIdentity;
  issue?: PaperclipHermesIssueInput | null;
  wakeIssue?: PaperclipHermesIssueInput | null;
  directive?: {
    key: string;
    value: string;
    revision: number;
    source: PaperclipHermesContextSource;
  } | null;
  comments?: Array<{ id: string; body: string }>;
  checkpoint?: {
    id: string;
    objective?: string | null;
    stateFingerprint: string;
    nextAction?: string | null;
  } | null;
  continuationSummary?: { id: string; body: string } | null;
}

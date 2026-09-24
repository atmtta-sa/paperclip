ALTER TABLE "agent_wakeup_requests" ADD COLUMN "blocker_state_fingerprint" text;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD COLUMN "blocker_kind" text DEFAULT 'issue_dependency' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD COLUMN "required_evidence_version" text DEFAULT 'issue_done_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD COLUMN "resolution_state" text DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD COLUMN "evidence_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD COLUMN "resolution_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
UPDATE "issue_relations" AS relation
SET
  "resolution_state" = 'resolved',
  "evidence_revision" = 1,
  "resolution_evidence" = jsonb_build_object(
    'blockerIssueId', blocker.id,
    'status', blocker.status,
    'statusVersion', blocker.status_version,
    'completedAt', blocker.completed_at
  ),
  "resolved_at" = blocker.completed_at
FROM "issues" AS blocker
WHERE relation.issue_id = blocker.id
  AND relation.type = 'blocks'
  AND blocker.status = 'done';--> statement-breakpoint
CREATE OR REPLACE FUNCTION initialize_issue_blocker_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  blocker_status text;
  blocker_status_version bigint;
  blocker_completed_at timestamptz;
BEGIN
  IF NEW.type <> 'blocks' THEN
    RETURN NEW;
  END IF;

  SELECT status, status_version, completed_at
  INTO blocker_status, blocker_status_version, blocker_completed_at
  FROM issues
  WHERE id = NEW.issue_id;

  IF blocker_status = 'done' THEN
    NEW.resolution_state := 'resolved';
    NEW.evidence_revision := 1;
    NEW.resolution_evidence := jsonb_build_object(
      'blockerIssueId', NEW.issue_id,
      'status', blocker_status,
      'statusVersion', blocker_status_version,
      'completedAt', blocker_completed_at
    );
    NEW.resolved_at := blocker_completed_at;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER issue_relations_initialize_blocker_evidence
BEFORE INSERT ON issue_relations
FOR EACH ROW EXECUTE FUNCTION initialize_issue_blocker_evidence();--> statement-breakpoint
CREATE OR REPLACE FUNCTION revise_issue_blocker_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR
     (OLD.status = 'done') = (NEW.status = 'done') THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'done' THEN
    UPDATE issue_relations
    SET
      resolution_state = 'resolved',
      evidence_revision = evidence_revision + 1,
      resolution_evidence = jsonb_build_object(
        'blockerIssueId', NEW.id,
        'status', NEW.status,
        'statusVersion', NEW.status_version,
        'completedAt', NEW.completed_at
      ),
      resolved_at = NEW.completed_at,
      updated_at = now()
    WHERE issue_id = NEW.id AND type = 'blocks';
  ELSE
    UPDATE issue_relations
    SET
      resolution_state = 'unresolved',
      evidence_revision = evidence_revision + 1,
      resolution_evidence = NULL,
      resolved_at = NULL,
      updated_at = now()
    WHERE issue_id = NEW.id AND type = 'blocks';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER issues_revise_blocker_evidence
AFTER UPDATE OF status ON issues
FOR EACH ROW EXECUTE FUNCTION revise_issue_blocker_evidence();--> statement-breakpoint
CREATE OR REPLACE FUNCTION persist_blocker_state_fingerprint() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reason = 'issue_blockers_resolved' AND NEW.blocker_state_fingerprint IS NULL THEN
    NEW.blocker_state_fingerprint := substring(NEW.idempotency_key from '([a-f0-9]{32})$');
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER agent_wakeup_requests_persist_blocker_fingerprint
BEFORE INSERT ON agent_wakeup_requests
FOR EACH ROW EXECUTE FUNCTION persist_blocker_state_fingerprint();
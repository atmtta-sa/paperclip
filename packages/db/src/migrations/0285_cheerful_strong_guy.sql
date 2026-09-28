ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "chain_root_run_id" uuid;--> statement-breakpoint
WITH RECURSIVE "budget_chains" AS (
  SELECT
    reservation."run_id" AS "descendant_run_id",
    reservation."run_id" AS "ancestor_run_id",
    run."retry_of_run_id" AS "next_ancestor_run_id",
    reservation."company_id",
    reservation."agent_id",
    reservation."issue_id",
    ARRAY[reservation."run_id"] AS "path"
  FROM "autonomous_budget_reservations" reservation
  LEFT JOIN "heartbeat_runs" run
    ON run."id" = reservation."run_id"
   AND run."company_id" = reservation."company_id"
   AND run."agent_id" = reservation."agent_id"

  UNION ALL

  SELECT
    chain."descendant_run_id",
    parent."run_id" AS "ancestor_run_id",
    parent_run."retry_of_run_id" AS "next_ancestor_run_id",
    chain."company_id",
    chain."agent_id",
    chain."issue_id",
    chain."path" || parent."run_id"
  FROM "budget_chains" chain
  JOIN "autonomous_budget_reservations" parent
    ON parent."run_id" = chain."next_ancestor_run_id"
   AND parent."company_id" = chain."company_id"
   AND parent."agent_id" = chain."agent_id"
   AND parent."issue_id" IS NOT DISTINCT FROM chain."issue_id"
  LEFT JOIN "heartbeat_runs" parent_run
    ON parent_run."id" = parent."run_id"
   AND parent_run."company_id" = parent."company_id"
   AND parent_run."agent_id" = parent."agent_id"
  WHERE NOT parent."run_id" = ANY(chain."path")
), "chain_roots" AS (
  SELECT DISTINCT ON ("descendant_run_id")
    "descendant_run_id",
    "ancestor_run_id" AS "chain_root_run_id"
  FROM "budget_chains"
  ORDER BY "descendant_run_id", cardinality("path") DESC
)
UPDATE "autonomous_budget_reservations" reservation
SET "chain_root_run_id" = root."chain_root_run_id"
FROM "chain_roots" root
WHERE reservation."run_id" = root."descendant_run_id";--> statement-breakpoint
UPDATE "autonomous_budget_reservations"
SET "chain_root_run_id" = "run_id"
WHERE "chain_root_run_id" IS NULL;--> statement-breakpoint
ALTER TABLE "autonomous_budget_reservations"
ALTER COLUMN "chain_root_run_id" SET NOT NULL;--> statement-breakpoint
CREATE FUNCTION "set_autonomous_budget_chain_root"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."chain_root_run_id" IS NULL THEN
    NEW."chain_root_run_id" := NEW."run_id";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "autonomous_budget_reservations_chain_root_trg"
BEFORE INSERT ON "autonomous_budget_reservations"
FOR EACH ROW
EXECUTE FUNCTION "set_autonomous_budget_chain_root"();--> statement-breakpoint
CREATE INDEX "autonomous_budget_reservations_chain_root_idx" ON "autonomous_budget_reservations" USING btree ("company_id","chain_root_run_id");
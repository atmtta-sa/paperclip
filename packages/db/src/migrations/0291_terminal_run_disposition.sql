ALTER TABLE "automatic_successor_intents"
  DROP CONSTRAINT IF EXISTS "automatic_successor_intents_kind_check";
ALTER TABLE "automatic_successor_intents"
  ADD CONSTRAINT "automatic_successor_intents_kind_check"
  CHECK ("kind" IN ('productive', 'corrective', 'recovery', 'terminal'));

DO $$ BEGIN
  CREATE TYPE "AiAgentGroupKind" AS ENUM ('TESE', 'SUPORTE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "ai_agent_groups" ADD COLUMN IF NOT EXISTS "kind" "AiAgentGroupKind" NOT NULL DEFAULT 'TESE';
ALTER TABLE "ai_agent_runs" ADD COLUMN IF NOT EXISTS "batch_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_runs_batch_key_key" ON "ai_agent_runs"("batch_key");
CREATE TABLE IF NOT EXISTS "ai_agent_test_usage" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL, "agent_id" TEXT NOT NULL,
  "user_id" TEXT, "session_id" TEXT, "model_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING', "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0, "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ai_agent_test_usage_organization_id_created_at_idx"
  ON "ai_agent_test_usage"("organization_id", "created_at");

ALTER TABLE "internal_notes" ALTER COLUMN "author_id" DROP NOT NULL;
ALTER TABLE "internal_notes" ADD COLUMN "agent_id" TEXT, ADD COLUMN "agent_run_id" TEXT,
 ADD COLUMN "generated_by_ai" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "ai_action_receipts" (
 "id" TEXT PRIMARY KEY, "agent_run_id" TEXT NOT NULL, "action" TEXT NOT NULL,
 "result" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ai_action_receipts_agent_run_id_idx" ON "ai_action_receipts"("agent_run_id");

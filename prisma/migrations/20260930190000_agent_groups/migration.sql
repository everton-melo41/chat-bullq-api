-- Lote C: aplicar separadamente, após revisão operacional.
ALTER TABLE "ai_agents" ADD COLUMN "entry_question" TEXT;
ALTER TABLE "ai_agent_handoffs" ADD COLUMN "entry_question" TEXT, ADD COLUMN "trigger_message_id" TEXT;
CREATE TABLE "ai_agent_groups" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "initial_agent_id" TEXT NOT NULL REFERENCES "ai_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ai_agent_groups_organization_id_idx" ON "ai_agent_groups"("organization_id");
CREATE TABLE "ai_agent_group_members" (
  "agent_id" TEXT NOT NULL REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "group_id" TEXT NOT NULL REFERENCES "ai_agent_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "order" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("group_id", "agent_id")
);
CREATE INDEX "ai_agent_group_members_agent_id_idx" ON "ai_agent_group_members"("agent_id");
ALTER TABLE "channels" ADD COLUMN "ai_agent_group_id" TEXT REFERENCES "ai_agent_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ai_agent_handoffs_conversation_id_created_at_idx" ON "ai_agent_handoffs"("conversation_id", "created_at");
CREATE INDEX "ai_agent_handoffs_conversation_id_trigger_message_id_idx" ON "ai_agent_handoffs"("conversation_id", "trigger_message_id");

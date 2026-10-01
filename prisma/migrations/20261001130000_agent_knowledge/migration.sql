CREATE TYPE "KnowledgeSourceType" AS ENUM ('TEXT', 'MARKDOWN', 'PDF');
CREATE TYPE "KnowledgeStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');
CREATE TABLE "knowledge_documents" (
 "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
 "title" TEXT NOT NULL, "source_type" "KnowledgeSourceType" NOT NULL, "file_name" TEXT,
 "content" TEXT NOT NULL, "status" "KnowledgeStatus" NOT NULL DEFAULT 'PROCESSING', "error" TEXT,
 "chunk_count" INTEGER NOT NULL DEFAULT 0, "size_chars" INTEGER NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "knowledge_documents_organization_id_idx" ON "knowledge_documents"("organization_id");
CREATE TABLE "knowledge_document_agents" (
 "document_id" TEXT NOT NULL REFERENCES "knowledge_documents"("id") ON DELETE CASCADE,
 "agent_id" TEXT NOT NULL REFERENCES "ai_agents"("id") ON DELETE CASCADE,
 PRIMARY KEY ("document_id", "agent_id")
);
CREATE INDEX "knowledge_document_agents_agent_id_idx" ON "knowledge_document_agents"("agent_id");

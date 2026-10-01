-- Compatível com o histórico rastreado e com a migration local já aplicada.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AI_TOOL_FAILURE';
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_revoked_by_fkey";
ALTER TABLE "messages" ADD CONSTRAINT "messages_revoked_by_fkey"
  FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DO $$
BEGIN
  IF to_regclass('"uq_pipeline_org_key"') IS NOT NULL
     AND to_regclass('"pipelines_organization_id_key_key"') IS NULL THEN
    ALTER INDEX "uq_pipeline_org_key" RENAME TO "pipelines_organization_id_key_key";
  END IF;
END $$;

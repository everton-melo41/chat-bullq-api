ALTER TABLE "departments" ADD COLUMN "channel_id" TEXT;
ALTER TABLE "channels" ADD COLUMN "default_department_id" TEXT;
CREATE INDEX "departments_channel_id_idx" ON "departments"("channel_id");
ALTER TABLE "departments" ADD CONSTRAINT "departments_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "channels" ADD CONSTRAINT "channels_default_department_id_fkey" FOREIGN KEY ("default_department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

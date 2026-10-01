import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Revisão estrutural offline: executar SQL em Postgres é validação separada de deploy.
describe('migrations manuais do estúdio', () => {
  const read = (name: string) => readFileSync(resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
  it('reconcilia enum, FK e índice em migration posterior e repetível', () => {
    const name = '20261001110000_reconcile_chat_bullq';
    expect(name.slice(0, 14) > '20261001100000').toBe(true);
    const sql = read(name);
    expect(sql).toContain(`ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AI_TOOL_FAILURE'`);
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "messages_revoked_by_fkey"');
    expect(sql).toContain('ON DELETE SET NULL ON UPDATE CASCADE');
    expect(sql).toContain(`to_regclass('"uq_pipeline_org_key"') IS NOT NULL`);
    expect(sql).toContain(`to_regclass('"pipelines_organization_id_key_key"') IS NULL`);
    expect(sql).toContain('RENAME TO "pipelines_organization_id_key_key"');
  });
  it('inclui default TESE, chave única de lote e tabela consultável de consumo', () => {
    const sql = read('20261001120000_studio_recovery_support');
    expect(sql).toContain(`DEFAULT 'TESE'`);
    expect(sql).toContain(`('TESE', 'SUPORTE')`);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_runs_batch_key_key"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "ai_agent_test_usage"');
    for (const column of ['organization_id', 'agent_id', 'user_id', 'session_id', 'input_tokens', 'output_tokens', 'cost_usd']) expect(sql).toContain(`"${column}"`);
  });
});

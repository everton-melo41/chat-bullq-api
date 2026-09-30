-- gen_random_uuid() já utilizado na migration 20260501140801_add_channel_agents.
CREATE TYPE "AiAgentRevisionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
ALTER TABLE ai_agents ADD COLUMN enabled_builtin_tools JSONB, ADD COLUMN published_revision_id TEXT, ADD COLUMN draft_revision_id TEXT;
CREATE TABLE ai_agent_revisions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
 organization_id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
 status "AiAgentRevisionStatus" NOT NULL, snapshot JSONB NOT NULL,
 created_by_id TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 published_at TIMESTAMP(3), note TEXT,
 UNIQUE(agent_id, version)
);
CREATE INDEX ai_agent_revisions_organization_id_agent_id_idx ON ai_agent_revisions(organization_id, agent_id);
CREATE UNIQUE INDEX ai_agent_revisions_one_draft ON ai_agent_revisions(agent_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX ai_agent_revisions_one_published ON ai_agent_revisions(agent_id) WHERE status = 'PUBLISHED';
INSERT INTO ai_agent_revisions (id, agent_id, organization_id, version, status, snapshot, published_at)
SELECT gen_random_uuid()::text, a.id, a.organization_id, 1, 'PUBLISHED',
jsonb_build_object(
 'name', a.name,
 'description', a.description,
 'avatarUrl', a.avatar_url,
 'kind', a.kind,
 'category', a.category,
 'capabilities', a.capabilities,
 'parentAgentId', a.parent_agent_id,
 'department', a.department,
 'squad', a.squad,
 'modelId', a.model_id,
 'modelParams', a.model_params,
 'systemPrompt', a.system_prompt,
 'operationalContext', a.operational_context,
 'operationalContextUpdatedAt', a.operational_context_updated_at,
 'temperature', a.temperature,
 'maxTokens', a.max_tokens,
 'canRespondDirectly', a.can_respond_directly,
 'isActive', a.is_active,
 'followUpEnabled', a.follow_up_enabled,
 'followUpCadenceHours', a.follow_up_cadence_hours,
 'enabledBuiltinTools', a.enabled_builtin_tools,
 'skills', COALESCE((SELECT jsonb_agg(jsonb_build_object('skillId', s.skill_id, 'requiresApproval', s.requires_approval) ORDER BY s.skill_id) FROM ai_agent_skills s WHERE s.agent_id = a.id), '[]'::jsonb)
), CURRENT_TIMESTAMP FROM ai_agents a;
UPDATE ai_agents a SET published_revision_id = r.id FROM ai_agent_revisions r WHERE r.agent_id = a.id;
ALTER TABLE ai_agents ADD FOREIGN KEY (published_revision_id) REFERENCES ai_agent_revisions(id) ON DELETE SET NULL,
 ADD FOREIGN KEY (draft_revision_id) REFERENCES ai_agent_revisions(id) ON DELETE SET NULL;
ALTER TABLE ai_agent_runs ADD COLUMN revision_id TEXT REFERENCES ai_agent_revisions(id) ON DELETE SET NULL;

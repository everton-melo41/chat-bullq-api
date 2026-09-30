import { AgentRevisionsService } from './revisions.service';
import { agentSnapshot, revisionDiff } from './agent-snapshot';

function fixture() {
  const agent: any = { id: 'agent', organizationId: 'org', name: 'Original', kind: 'WORKER', capabilities: [], modelId: 'sakana/fugu', systemPrompt: 'original prompt', temperature: 0.7, maxTokens: 1024, canRespondDirectly: true, isActive: true, skills: [], parentAgentId: null, publishedRevisionId: 'v1', draftRevisionId: null };
  const revisions: any[] = [{ id: 'v1', agentId: agent.id, organizationId: 'org', version: 1, status: 'PUBLISHED', snapshot: agentSnapshot(agent) }];
  let sequence = 1;
  const db: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    aiSkill: { count: jest.fn().mockResolvedValue(0) },
    aiAgent: {
      findFirst: jest.fn(({ where }: any) => Promise.resolve(where.organizationId === 'org' ? { ...agent, draftRevision: revisions.find(r => r.id === agent.draftRevisionId), publishedRevision: revisions.find(r => r.id === agent.publishedRevisionId) } : null)),
      update: jest.fn(({ data }: any) => { Object.assign(agent, data); return Promise.resolve(agent); }),
    },
    aiAgentRevision: {
      aggregate: jest.fn(() => Promise.resolve({ _max: { version: Math.max(...revisions.map(r => r.version)) } })),
      create: jest.fn(({ data }: any) => { const row = { id: `v${++sequence}`, ...data }; revisions.push(row); return Promise.resolve(row); }),
      update: jest.fn(({ where, data }: any) => { const row = revisions.find(r => r.id === where.id); Object.assign(row, data); return Promise.resolve(row); }),
      findFirst: jest.fn(({ where }: any) => Promise.resolve(revisions.find(r => r.version === where.version && r.organizationId === where.organizationId && r.agentId === where.agentId && r.status !== 'DRAFT'))),
      findMany: jest.fn(() => Promise.resolve(revisions)),
      delete: jest.fn(({ where }: any) => { revisions.splice(revisions.findIndex(r => r.id === where.id), 1); return Promise.resolve(); }),
    },
    aiAgentSkill: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  db.$transaction = (fn: any) => fn(db);
  return { service: new AgentRevisionsService(db), agent, revisions, db };
}

describe('agent revisions', () => {
  it('saves and updates one draft without changing published behavior', async () => {
    const { service, agent, revisions, db } = fixture();
    await service.save('org', 'agent', { systemPrompt: 'draft prompt', enabledBuiltinTools: [] }, 'user');
    await service.save('org', 'agent', { modelId: 'sakana/new' }, 'user');
    expect(agent.systemPrompt).toBe('original prompt');
    expect(revisions).toHaveLength(2);
    expect(revisions[0].snapshot.systemPrompt).toBe('original prompt');
    expect(revisions[1]).toMatchObject({ version: 2, status: 'DRAFT', createdById: 'user', snapshot: { systemPrompt: 'draft prompt', modelId: 'sakana/new', enabledBuiltinTools: [] } });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it('publishes, archives previous, increments version and keeps notes', async () => {
    const { service, agent, revisions } = fixture();
    await service.save('org', 'agent', { systemPrompt: 'published second' });
    await service.publish('org', 'agent', 'release note');
    expect(agent).toMatchObject({ systemPrompt: 'published second', draftRevisionId: null, publishedRevisionId: 'v2' });
    expect(revisions[0].status).toBe('ARCHIVED');
    expect(revisions[1]).toMatchObject({ status: 'PUBLISHED', note: 'release note', publishedAt: expect.any(Date) });
    await service.save('org', 'agent', {});
    expect(revisions[2].version).toBe(3);
    await service.publish('org', 'agent');
    await expect(service.publish('org', 'agent')).rejects.toThrow('Nenhum rascunho');
  });
  it('restores old snapshot to a new draft, without publishing', async () => {
    const { service, agent } = fixture();
    await service.save('org', 'agent', { systemPrompt: 'second' });
    await service.publish('org', 'agent');
    const restored = await service.restore('org', 'agent', 1, 'restorer');
    expect(restored).toMatchObject({ status: 'DRAFT', version: 3, createdById: 'restorer', snapshot: { systemPrompt: 'original prompt' } });
    expect(agent.publishedRevisionId).toBe('v2');
    expect(agent.systemPrompt).toBe('second');
    const replaced = await service.restore('org', 'agent', 1);
    expect(replaced.id).not.toBe(restored.id);
  });
  it('rejects cross-organization reads, writes, publication and restoration', async () => {
    const { service } = fixture();
    await expect(service.list('other', 'agent')).rejects.toThrow('Agent not found');
    await expect(service.save('other', 'agent', {})).rejects.toThrow('Agent not found');
    await expect(service.publish('other', 'agent')).rejects.toThrow('Agent not found');
    await expect(service.restore('other', 'agent', 1)).rejects.toThrow('Agent not found');
  });
  it('validates skills, required fields and hierarchy before saving', async () => {
    const { service } = fixture();
    await expect(service.save('org', 'agent', { skillIds: ['foreign'] })).rejects.toThrow('Skills inválidas');
    await expect(service.save('org', 'agent', { systemPrompt: null })).rejects.toThrow('não pode ser nulo');
    await expect(service.save('org', 'agent', { parentAgentId: 'agent' })).rejects.toThrow('cíclica');
  });
  it('captures skill approval in the draft without mutating published bindings', async () => {
    const { service, revisions, db } = fixture();
    db.aiSkill.count.mockResolvedValue(1);
    await service.save('org', 'agent', { skillIds: ['skill'] });
    await service.save('org', 'agent', { skillApproval: { skillId: 'skill', requiresApproval: true } });
    expect(revisions[1].snapshot.skills).toEqual([{ skillId: 'skill', requiresApproval: true }]);
    expect(revisions[0].snapshot.skills).toEqual([]);
    expect(db.aiAgentSkill.createMany).not.toHaveBeenCalled();
    await service.publish('org', 'agent');
    expect(db.aiAgentSkill.createMany).toHaveBeenCalledWith({ data: [{ agentId: 'agent', skillId: 'skill', requiresApproval: true }] });
  });
});

describe('revision diff', () => {
  it('keeps repeated lines and marks additions, removals and changed fields', () => {
    const result = revisionDiff({ systemPrompt: 'a\nb\na', modelId: 'old' }, { systemPrompt: 'a\nc\na', modelId: 'new' });
    expect(result.lines.filter(l => l.type !== 'added').map(l => l.text)).toEqual(['a', 'b', 'a']);
    expect(result.lines.filter(l => l.type !== 'removed').map(l => l.text)).toEqual(['a', 'c', 'a']);
    expect(result.lines).toContainEqual({ type: 'removed', text: 'b' });
    expect(result.lines).toContainEqual({ type: 'added', text: 'c' });
    expect(result.fields).toEqual([{ field: 'modelId', before: 'old', after: 'new' }]);
  });
});

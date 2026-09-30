import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { agentSnapshot, revisionDiff, SNAPSHOT_FIELDS } from './agent-snapshot';

@Injectable()
export class AgentRevisionsService {
  constructor(private readonly prisma: PrismaService) {}

  private async agent(db: Prisma.TransactionClient, organizationId: string, id: string) {
    const agent = await db.aiAgent.findFirst({ where: { id, organizationId, deletedAt: null }, include: { skills: true, draftRevision: true, publishedRevision: true } });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  private async locked<T>(org: string, id: string, work: (db: Prisma.TransactionClient, agent: any) => Promise<T>) {
    return this.prisma.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM ai_agents WHERE id = ${id} AND organization_id = ${org} FOR UPDATE`;
      return work(db, await this.agent(db, org, id));
    });
  }

  async list(org: string, id: string) {
    await this.agent(this.prisma, org, id);
    return this.prisma.aiAgentRevision.findMany({ where: { agentId: id, organizationId: org }, orderBy: { version: 'desc' } });
  }

  async save(org: string, id: string, patch: any, createdById?: string) {
    return this.locked(org, id, async (db, agent) => {
      const base = agent.draftRevision?.snapshot ?? agent.publishedRevision?.snapshot ?? agentSnapshot(agent, agent.skills);
      const snapshot = { ...base, ...Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined && (SNAPSHOT_FIELDS.includes(key as any) || key === 'skills'))) };
      if (patch.skillIds) snapshot.skills = patch.skillIds.map((skillId: string) => ({ skillId, requiresApproval: base.skills.find((b: any) => b.skillId === skillId)?.requiresApproval ?? false }));
      if (patch.skillApproval) {
        if (!base.skills.some((b: any) => b.skillId === patch.skillApproval.skillId)) throw new NotFoundException('Skill não atribuída');
        snapshot.skills = base.skills.map((b: any) => ({ ...b, ...(b.skillId === patch.skillApproval.skillId ? patch.skillApproval : {}) }));
      }
      if (patch.operationalContext !== undefined && patch.operationalContext !== base.operationalContext) snapshot.operationalContextUpdatedAt = new Date().toISOString();
      await this.validate(db, org, id, snapshot);
      return this.writeDraft(db, agent, snapshot, createdById);
    });
  }

  private async validate(db: Prisma.TransactionClient, org: string, id: string, snapshot: any) {
    for (const field of ['name', 'kind', 'capabilities', 'modelId', 'systemPrompt', 'temperature', 'maxTokens', 'canRespondDirectly', 'isActive']) {
      if (snapshot[field] == null) throw new BadRequestException(`${field} não pode ser nulo`);
    }
    if (!Array.isArray(snapshot.skills)) throw new BadRequestException('Skills devem ser uma lista');
    const ids = snapshot.skills.map((s: any) => s.skillId);
    if (new Set(ids).size !== ids.length || await db.aiSkill.count({ where: { id: { in: ids }, organizationId: org, deletedAt: null } }) !== ids.length) throw new BadRequestException('Skills inválidas para esta organização');
    let parent = snapshot.parentAgentId;
    const visited = new Set([id]);
    while (parent) {
      if (visited.has(parent)) throw new BadRequestException('Hierarquia cíclica');
      visited.add(parent);
      const row = await db.aiAgent.findFirst({ where: { id: parent, organizationId: org, deletedAt: null } });
      if (!row) throw new BadRequestException('Chefe não encontrado nesta organização');
      parent = row.parentAgentId;
    }
  }

  private async writeDraft(db: Prisma.TransactionClient, agent: any, snapshot: any, createdById?: string) {
    if (agent.draftRevisionId) return db.aiAgentRevision.update({ where: { id: agent.draftRevisionId }, data: { snapshot } });
    const last = await db.aiAgentRevision.aggregate({ where: { agentId: agent.id }, _max: { version: true } });
    const draft = await db.aiAgentRevision.create({ data: { agentId: agent.id, organizationId: agent.organizationId, version: (last._max.version ?? 0) + 1, status: 'DRAFT', snapshot, createdById } });
    await db.aiAgent.update({ where: { id: agent.id }, data: { draftRevisionId: draft.id } });
    return draft;
  }

  async publish(org: string, id: string, note?: string) {
    return this.locked(org, id, async (db, agent) => {
      if (!agent.draftRevision) throw new BadRequestException('Nenhum rascunho para publicar');
      const snapshot = agent.draftRevision.snapshot;
      await this.validate(db, org, id, snapshot);
      if (agent.publishedRevisionId) await db.aiAgentRevision.update({ where: { id: agent.publishedRevisionId }, data: { status: 'ARCHIVED' } });
      const revision = await db.aiAgentRevision.update({ where: { id: agent.draftRevisionId }, data: { status: 'PUBLISHED', publishedAt: new Date(), note } });
      const data: any = Object.fromEntries(SNAPSHOT_FIELDS.map(key => [key, snapshot[key]]));
      data.modelParams = data.modelParams ?? Prisma.DbNull;
      data.enabledBuiltinTools = data.enabledBuiltinTools ?? Prisma.DbNull;
      await db.aiAgent.update({ where: { id }, data: { ...data, publishedRevisionId: revision.id, draftRevisionId: null } });
      await db.aiAgentSkill.deleteMany({ where: { agentId: id } });
      if (snapshot.skills.length) await db.aiAgentSkill.createMany({ data: snapshot.skills.map((s: any) => ({ agentId: id, skillId: s.skillId, requiresApproval: s.requiresApproval })) });
      return revision;
    });
  }

  async restore(org: string, id: string, version: number, user?: string) {
    return this.locked(org, id, async (db, agent) => {
      const source = await db.aiAgentRevision.findFirst({ where: { organizationId: org, agentId: id, version, status: { not: 'DRAFT' } } });
      if (!source) throw new NotFoundException('Versão não encontrada');
      await this.validate(db, org, id, source.snapshot);
      // A restauração sempre cria um novo DRAFT; mantém a revisão publicada.
      if (agent.draftRevisionId) await db.aiAgentRevision.delete({ where: { id: agent.draftRevisionId } });
      return this.writeDraft(db, { ...agent, draftRevisionId: null }, source.snapshot, user);
    });
  }

  async diff(org: string, id: string, from: number, to: number) {
    const revisions = await this.list(org, id);
    const a = revisions.find(r => r.version === from), b = revisions.find(r => r.version === to);
    if (!a || !b) throw new NotFoundException('Versão não encontrada');
    return revisionDiff(a.snapshot, b.snapshot);
  }
}

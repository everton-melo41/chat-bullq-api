import { AiAgentGroupKind, Prisma } from '@prisma/client';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { IsArray, IsNotEmpty, IsOptional, IsString, ArrayUnique, MaxLength, ArrayMaxSize, IsEnum, ValidateIf } from 'class-validator';

export class MoveAgentGroupDto {
  @ValidateIf((_object, value) => value !== null) @IsString() @IsNotEmpty() groupId!: string | null;
}

export class SaveAgentGroupDto {
  @IsOptional() @IsEnum(AiAgentGroupKind) kind?: AiAgentGroupKind;
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsString() @IsNotEmpty() initialAgentId!: string;
  @IsArray() @ArrayUnique() @ArrayMaxSize(100) @IsString({ each: true }) memberIds!: string[];
}

@Injectable()
export class AgentGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string) {
    return this.prisma.aiAgentGroup.findMany({ where: { organizationId }, orderBy: { name: 'asc' },
      include: { members: { orderBy: { order: 'asc' }, include: { agent: { select: { id: true, name: true, isActive: true, publishedRevisionId: true, deletedAt: true } } } } } });
  }

  async save(organizationId: string, dto: SaveAgentGroupDto, id?: string) {
    if (!dto.name.trim() || !dto.memberIds.includes(dto.initialAgentId) || new Set(dto.memberIds).size !== dto.memberIds.length) {
      throw new BadRequestException('O agente inicial deve ser membro do grupo; membros não podem se repetir');
    }
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
      if (id) {
        await tx.$queryRaw`SELECT id FROM ai_agent_groups WHERE id = ${id} AND organization_id = ${organizationId} FOR UPDATE`;
        if (!await tx.aiAgentGroup.findFirst({ where: { id, organizationId } })) throw new NotFoundException('Grupo não encontrado');
      }
      const agents = await tx.aiAgent.count({ where: { id: { in: dto.memberIds }, organizationId, deletedAt: null } });
      if (agents !== dto.memberIds.length) throw new BadRequestException('Membros devem pertencer à organização');
      const data = { ...(dto.kind ? { kind: dto.kind } : {}), name: dto.name.trim(), description: dto.description?.trim() || null, initialAgentId: dto.initialAgentId };
      const group = id ? await tx.aiAgentGroup.update({ where: { id }, data }) : await tx.aiAgentGroup.create({ data: { ...data, organizationId } });
      if (!id) for (const agentId of dto.memberIds) await this.detachSources(tx, organizationId, agentId, group.id);
      await tx.aiAgentGroupMember.deleteMany({ where: { groupId: group.id } });
      await tx.aiAgentGroupMember.createMany({ data: dto.memberIds.map((agentId, order) => ({ groupId: group.id, agentId, order })) });
      return group;
    });
  }

  /** Serializa alterações de matérias da organização para evitar movimentos parciais. */
  async move(organizationId: string, agentId: string, groupId: string | null) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
      const agent = await tx.aiAgent.findFirst({ where: { id: agentId, organizationId, deletedAt: null } });
      if (!agent) throw new NotFoundException('Agente não encontrado');
      const target = groupId ? await tx.aiAgentGroup.findFirst({ where: { id: groupId, organizationId }, include: { members: true } }) : null;
      if (groupId && !target) throw new NotFoundException('Matéria não encontrada');
      await this.detachSources(tx, organizationId, agentId, groupId);
      if (target && !target.members.some(member => member.agentId === agentId)) {
        const order = Math.max(-1, ...target.members.map(member => member.order)) + 1;
        await tx.aiAgentGroupMember.create({ data: { groupId: target.id, agentId, order } });
      }
      return { agentId, groupId };
    });
  }

  private async detachSources(tx: Prisma.TransactionClient, organizationId: string, agentId: string, groupId: string | null) {
    const sources = await tx.aiAgentGroup.findMany({
      where: { organizationId, members: { some: { agentId } }, ...(groupId ? { id: { not: groupId } } : {}) },
      include: { members: true },
    });
    for (const source of sources) {
      if (source.initialAgentId === agentId && source.members.length > 1) {
        throw new BadRequestException('Escolha outro agente inicial na matéria de origem antes de mover');
      }
    }
    for (const source of sources) {
      await tx.aiAgentGroupMember.deleteMany({ where: { groupId: source.id, agentId } });
      if (source.members.length === 1) await tx.aiAgentGroup.delete({ where: { id: source.id } });
    }
  }

  /** Exclui a matéria; os agentes continuam existindo, "sem matéria". */
  async remove(organizationId: string, id: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
      const group = await tx.aiAgentGroup.findFirst({ where: { id, organizationId } });
      if (!group) throw new NotFoundException('Matéria não encontrada');
      await tx.aiAgentGroupMember.deleteMany({ where: { groupId: id } });
      await tx.aiAgentGroup.delete({ where: { id } });
      return { deleted: true };
    });
  }
}

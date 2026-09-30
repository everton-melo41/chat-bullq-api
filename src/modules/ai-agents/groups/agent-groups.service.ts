import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { IsArray, IsNotEmpty, IsOptional, IsString, ArrayUnique, MaxLength, ArrayMaxSize } from 'class-validator';

export class SaveAgentGroupDto {
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
      if (id) {
        await tx.$queryRaw`SELECT id FROM ai_agent_groups WHERE id = ${id} AND organization_id = ${organizationId} FOR UPDATE`;
        if (!await tx.aiAgentGroup.findFirst({ where: { id, organizationId } })) throw new NotFoundException('Grupo não encontrado');
      }
      const agents = await tx.aiAgent.count({ where: { id: { in: dto.memberIds }, organizationId, deletedAt: null } });
      if (agents !== dto.memberIds.length) throw new BadRequestException('Membros devem pertencer à organização');
      const data = { name: dto.name.trim(), description: dto.description?.trim() || null, initialAgentId: dto.initialAgentId };
      const group = id ? await tx.aiAgentGroup.update({ where: { id }, data }) : await tx.aiAgentGroup.create({ data: { ...data, organizationId } });
      await tx.aiAgentGroupMember.deleteMany({ where: { groupId: group.id } });
      await tx.aiAgentGroupMember.createMany({ data: dto.memberIds.map((agentId, order) => ({ groupId: group.id, agentId, order })) });
      return group;
    });
  }

  /** Exclui a matéria; os agentes continuam existindo, "sem matéria". */
  async remove(organizationId: string, id: string) {
    const group = await this.prisma.aiAgentGroup.findFirst({ where: { id, organizationId } });
    if (!group) throw new NotFoundException('Matéria não encontrada');
    await this.prisma.$transaction([
      this.prisma.aiAgentGroupMember.deleteMany({ where: { groupId: id } }),
      this.prisma.aiAgentGroup.delete({ where: { id } }),
    ]);
    return { deleted: true };
  }
}

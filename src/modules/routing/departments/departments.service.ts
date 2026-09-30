import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { DepartmentsRepository } from './departments.repository';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

@Injectable()
export class DepartmentsService {
  constructor(private readonly repository: DepartmentsRepository) {}

  async create(orgId: string, dto: CreateDepartmentDto) {
    if (dto.channelId && !await this.repository.validateChannel(dto.channelId, orgId)) {
      throw new BadRequestException('Canal inválido para esta organização');
    }
    if (dto.isDefault) {
      await this.repository.clearDefaultForOrg(orgId);
    }
    return this.repository.create({
      name: dto.name,
      ...(dto.channelId ? { channel: { connect: { id: dto.channelId } } } : {}),
      description: dto.description,
      distributionRule: dto.distributionRule,
      isDefault: dto.isDefault ?? false,
      organization: { connect: { id: orgId } },
    });
  }

  async findAll(orgId: string) {
    return this.repository.findByOrg(orgId);
  }

  async findOne(id: string, orgId: string) {
    const dept = await this.repository.findById(id);
    if (!dept || dept.organizationId !== orgId) {
      throw new NotFoundException('Department not found');
    }
    return dept;
  }

  async update(id: string, orgId: string, dto: UpdateDepartmentDto) {
    await this.findOne(id, orgId);
    if (dto.channelId && !await this.repository.validateChannel(dto.channelId, orgId)) {
      throw new BadRequestException('Canal inválido para esta organização');
    }
    if (dto.isDefault) {
      await this.repository.clearDefaultForOrg(orgId, id);
    }
    if (dto.channelId !== undefined) await this.repository.changeChannel(id, dto.channelId);
    return this.repository.update(id, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.distributionRule !== undefined && { distributionRule: dto.distributionRule }),
      ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
    });
  }

  async remove(id: string, orgId: string) {
    await this.findOne(id, orgId);
    await this.repository.changeChannel(id, null);
    return this.repository.softDelete(id);
  }

  async addAgent(departmentId: string, orgId: string, userId: string) {
    await this.findOne(departmentId, orgId);
    const membership = await this.repository.findMembership(userId, orgId);
    if (!membership) {
      throw new BadRequestException('User is not a member of this organization');
    }
    const existing = await this.repository.findDepartmentAgentByUser(
      departmentId,
      orgId,
      userId,
    );
    if (existing) {
      throw new ConflictException('Agent already in this department');
    }
    return this.repository.addAgent(departmentId, membership.id);
  }

  async removeAgent(departmentId: string, orgId: string, agentUserId: string) {
    await this.findOne(departmentId, orgId);
    const membership = await this.repository.findMembership(agentUserId, orgId);
    if (!membership) {
      throw new NotFoundException('Agent not found in organization');
    }
    const result = await this.repository.removeAgent(departmentId, membership.id);
    if (result.count === 0) {
      throw new NotFoundException('Agent is not assigned to this department');
    }
    return { removed: true };
  }

  async findAgents(departmentId: string, orgId: string) {
    await this.findOne(departmentId, orgId);
    return this.repository.findAgents(departmentId);
  }
}

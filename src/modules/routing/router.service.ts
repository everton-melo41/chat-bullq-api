import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ConversationFsmService } from '../messaging/conversations/conversation-fsm.service';

@Injectable()
export class RouterService {
  /** Round-robin cursor per organization + department */
  private readonly rrIndex = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: ConversationFsmService,
  ) {}

  async assignConversation(
    conversationId: string,
    organizationId: string,
    actorId?: string,
  ): Promise<{ departmentId: string; assignedToId: string }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    // Keep routing inside the conversation's immutable channel. Prefer its
    // current/default department; org-wide departments remain compatible.
    const channel = await this.prisma.channel.findUnique({
      where: { id: conversation.channelId }, select: { defaultDepartmentId: true },
    });
    const preferredId = conversation.departmentId ?? channel?.defaultDepartmentId;
    const department = (preferredId ? await this.prisma.department.findFirst({
      where: { id: preferredId, organizationId, deletedAt: null,
        OR: [{ channelId: conversation.channelId }, { channelId: null }] },
    }) : null) ?? await this.prisma.department.findFirst({
      where: { organizationId, deletedAt: null, channelId: conversation.channelId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }) ?? await this.prisma.department.findFirst({
      where: { organizationId, deletedAt: null, channelId: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (!department) {
      throw new BadRequestException('No department configured for this organization');
    }

    let agents = await this.prisma.departmentAgent.findMany({
      where: {
        departmentId: department.id,
        isActive: true,
        userOrganization: {
          organizationId,
          agentStatus: AgentStatus.ONLINE,
        },
      },
      include: { userOrganization: true },
      orderBy: { id: 'asc' },
    });

    if (agents.length === 0) {
      agents = await this.prisma.departmentAgent.findMany({
        where: {
          departmentId: department.id,
          isActive: true,
          userOrganization: { organizationId },
        },
        include: { userOrganization: true },
        orderBy: { id: 'asc' },
      });
    }

    if (agents.length === 0) {
      throw new BadRequestException('No active agents in the routing department');
    }

    const key = `${organizationId}:${department.id}`;
    const idx = this.rrIndex.get(key) ?? 0;
    const pick = agents[idx % agents.length];
    this.rrIndex.set(key, idx + 1);

    const assignedToId = pick.userOrganization.userId;

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { departmentId: department.id },
    });

    await this.fsm.assign(conversationId, assignedToId, actorId);

    return { departmentId: department.id, assignedToId };
  }
}

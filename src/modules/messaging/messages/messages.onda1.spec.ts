import { ForbiddenException } from '@nestjs/common';
import { MessagesService } from './messages.service';

describe('Customer engagement window metadata', () => {
  function setup() {
    const lastInboundAt = new Date('2026-09-30T10:00:00Z');
    const service = Object.assign(Object.create(MessagesService.prototype), {
      prisma: {
        conversation: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org', channelId: 'channel' }) },
        message: { findFirst: jest.fn().mockResolvedValue({ createdAt: lastInboundAt }) },
      },
      repository: { findByConversation: jest.fn().mockResolvedValue({ messages: [{ direction: 'OUTBOUND' }], total: 80 }) },
      channelAccess: { assertChannelAccess: jest.fn() },
      segmentRead: { groupSiblingIds: jest.fn().mockResolvedValue(null) },
    });
    return { service, lastInboundAt };
  }
  it('returns the actual latest customer timestamp even when the page contains only outbound messages', async () => {
    const { service, lastInboundAt } = setup();
    const result = await service.findByConversation('conv', 'org', 1, 50, new Set(['channel']));
    expect(result.lastInboundAt).toBe(lastInboundAt);
    expect(service.prisma.message.findFirst).toHaveBeenCalledWith({ where: { conversationId: 'conv', direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    expect(result.messages).toEqual([{ direction: 'OUTBOUND' }]);
  });
  it('returns null when the customer has never sent a message', async () => {
    const { service } = setup(); service.prisma.message.findFirst.mockResolvedValue(null);
    expect((await service.findByConversation('conv', 'org', 1, 50, 'ALL')).lastInboundAt).toBeNull();
  });
  it('checks organization and channel access before reading customer activity', async () => {
    const { service } = setup();
    await expect(service.findByConversation('conv', 'other-org', 1, 50, 'ALL')).rejects.toBeInstanceOf(ForbiddenException);
    service.channelAccess.assertChannelAccess.mockImplementation(() => { throw new ForbiddenException(); });
    await expect(service.findByConversation('conv', 'org', 1, 50, new Set())).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.prisma.message.findFirst).not.toHaveBeenCalled();
  });
});

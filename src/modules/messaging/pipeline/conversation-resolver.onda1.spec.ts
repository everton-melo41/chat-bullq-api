import { ConversationResolverService } from './conversation-resolver.service';

describe('Inbound default department', () => {
  it.each([undefined, { externalThreadId: 'thread', subject: 'Assunto' }])('assigns the channels default on new inbound conversations (%j)', async options => {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'conv' }) },
      channel: { findUnique: jest.fn().mockResolvedValue({ defaultDepartmentId: 'department' }) },
      conversationAuditLog: { create: jest.fn() },
    };
    const service = new ConversationResolverService(prisma as any, { withLock: async (_key: string, work: () => Promise<unknown>) => work() } as any);
    await service.resolve('org', 'channel', 'contact', false, options);
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ channelId: 'channel', departmentId: 'department' }) });
  });
  it('does not move an existing conversation to a new default department or channel', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv', status: 'OPEN', isGroup: false }), update: jest.fn() }, channel: { findUnique: jest.fn() } };
    const service = new ConversationResolverService(prisma as any, {} as any);
    await service.resolve('org', 'channel', 'contact');
    expect(prisma.channel.findUnique).not.toHaveBeenCalled(); expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});

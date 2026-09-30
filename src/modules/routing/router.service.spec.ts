import { RouterService } from './router.service';

describe('Routing inside the conversation channel', () => {
  it('retains the conversation department if it is general or on the same channel', async () => {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv', channelId: 'channel', departmentId: 'dept' }), update: jest.fn() },
      channel: { findUnique: jest.fn().mockResolvedValue({ defaultDepartmentId: 'default' }) },
      department: { findFirst: jest.fn().mockResolvedValue({ id: 'dept' }) },
      departmentAgent: { findMany: jest.fn().mockResolvedValue([{ userOrganization: { userId: 'user' } }]) },
    };
    const service = new RouterService(prisma as any, { assign: jest.fn() } as any);
    expect(await service.assignConversation('conv', 'org')).toEqual({ departmentId: 'dept', assignedToId: 'user' });
    expect(prisma.department.findFirst).toHaveBeenCalledWith({ where: { id: 'dept', organizationId: 'org', deletedAt: null, OR: [{ channelId: 'channel' }, { channelId: null }] } });
  });
  it('falls back only to departments in this channel or general ones', async () => {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv', channelId: 'channel', departmentId: null }), update: jest.fn() },
      channel: { findUnique: jest.fn().mockResolvedValue({ defaultDepartmentId: null }) },
      department: { findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'general' }) },
      departmentAgent: { findMany: jest.fn().mockResolvedValue([{ userOrganization: { userId: 'user' } }]) },
    };
    const service = new RouterService(prisma as any, { assign: jest.fn() } as any);
    await service.assignConversation('conv', 'org');
    expect(prisma.department.findFirst.mock.calls.map(([query]) => query.where.channelId)).toEqual(['channel', null]);
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv' }, data: { departmentId: 'general' } });
  });
});

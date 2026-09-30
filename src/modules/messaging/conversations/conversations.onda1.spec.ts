import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { CreateInternalNoteDto } from './dto/create-internal-note.dto';
import { validate } from 'class-validator';

function setup() {
  const conversation = { id: 'conv', organizationId: 'org', channelId: 'channel', status: 'OPEN' };
  const prisma = {
    department: { findFirst: jest.fn().mockResolvedValue({ id: 'department', channelId: 'channel' }) },
    internalNote: {
      findMany: jest.fn().mockResolvedValue([{ id: 'note', authorId: 'me', content: 'Equipe', conversationId: 'conv' }]),
      create: jest.fn().mockResolvedValue({ id: 'note' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'me', name: 'Maria' }]) },
  };
  const service = Object.assign(Object.create(ConversationsService.prototype), {
    prisma, repository: { findById: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
    channelAccess: { assertChannelAccess: jest.fn((access, channel) => { if (access !== 'ALL' && !access.includes(channel)) throw new ForbiddenException(); }) },
    attachProjects: jest.fn(), refreshAvatar: jest.fn(), broadcastUpdate: jest.fn(),
    realtimeGateway: { emitToConversation: jest.fn() }, fsm: { assign: jest.fn(), transition: jest.fn() },
  });
  return { service, prisma, conversation };
}

describe('Conversation departments and internal notes', () => {
  it.each(['other-channel', 'missing'])('rejects invalid department %s before changing assignee/status', async target => {
    const { service, prisma } = setup();
    prisma.department.findFirst.mockResolvedValue(target === 'missing' ? null : { channelId: target });
    await expect(service.update('conv', 'org', { departmentId: 'department', assignedToId: 'user', status: 'CLOSED' }, 'me', ['channel'])).rejects.toBeInstanceOf(BadRequestException);
    expect(service.fsm.assign).not.toHaveBeenCalled(); expect(service.fsm.transition).not.toHaveBeenCalled(); expect(service.repository.update).not.toHaveBeenCalled();
    expect(prisma.department.findFirst).toHaveBeenCalledWith({ where: { id: 'department', organizationId: 'org', deletedAt: null } });
  });
  it.each(['channel', null])('accepts same-channel and general departments (%s)', async channelId => {
    const { service, prisma } = setup(); prisma.department.findFirst.mockResolvedValue({ id: 'department', channelId });
    await service.update('conv', 'org', { departmentId: 'department' }, 'me', ['channel']);
    expect(service.repository.update).toHaveBeenCalledWith('conv', { department: { connect: { id: 'department' } } });
  });
  it('lists chronological notes with author and scopes them to the conversation', async () => {
    const { service, prisma } = setup();
    expect(await service.listNotes('conv', 'org', ['channel'])).toEqual([expect.objectContaining({ author: { id: 'me', name: 'Maria' } })]);
    expect(prisma.internalNote.findMany).toHaveBeenCalledWith({ where: { conversationId: 'conv' }, orderBy: { createdAt: 'asc' } });
  });
  it.each(['listNotes', 'createNote', 'deleteNote'])('enforces org and channel access for %s', async operation => {
    const { service, prisma } = setup();
    const call = (org: string, access: string[]) => operation === 'listNotes' ? service.listNotes('conv', org, access) : operation === 'createNote' ? service.createNote('conv', org, 'me', 'Equipe', access) : service.deleteNote('conv', org, 'me', 'note', access);
    await expect(call('other-org', ['channel'])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call('org', [])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.internalNote.create).not.toHaveBeenCalled(); expect(prisma.internalNote.findMany).not.toHaveBeenCalled(); expect(prisma.internalNote.deleteMany).not.toHaveBeenCalled();
  });
  it('creates an internal note and emits only to the conversation room', async () => {
    const { service, prisma } = setup(); await service.createNote('conv', 'org', 'me', '  Equipe  ', ['channel']);
    expect(prisma.internalNote.create).toHaveBeenCalledWith({ data: { conversationId: 'conv', authorId: 'me', content: 'Equipe' } });
    expect(service.realtimeGateway.emitToConversation).toHaveBeenCalledWith('conv', 'note:changed', { conversationId: 'conv', noteId: 'note' });
  });
  it('can delete only the authors own note on the current conversation', async () => {
    const { service, prisma } = setup();
    await service.deleteNote('conv', 'org', 'me', 'note', ['channel']);
    expect(prisma.internalNote.deleteMany).toHaveBeenCalledWith({ where: { id: 'note', conversationId: 'conv', authorId: 'me' } });
    prisma.internalNote.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.deleteNote('conv', 'org', 'me', 'another-author-note', ['channel'])).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects empty and oversized notes', async () => {
    const { service } = setup();
    for (const content of ['   ', 'x'.repeat(20001)]) {
      await expect(service.createNote('conv', 'org', 'me', content, ['channel'])).rejects.toBeInstanceOf(BadRequestException);
      expect(await validate(Object.assign(new CreateInternalNoteDto(), { content }))).not.toHaveLength(0);
    }
  });
});

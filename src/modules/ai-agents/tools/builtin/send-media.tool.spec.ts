import { SendMediaTool } from './send-media.tool';

function fixture() {
  let saved: any = null;
  const prisma: any = {
    agentMedia: { findFirst: jest.fn().mockResolvedValue({ id: 'media', name: 'Vídeo', kind: 'VIDEO', url: '/video', mimeType: 'video/mp4', fileName: 'video.mp4' }) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'phone' }) },
    message: { findUnique: jest.fn(async () => saved), create: jest.fn(async ({ data }) => (saved = data)) },
    aiAgent: { findUnique: jest.fn().mockResolvedValue({ name: 'Agente' }) },
    conversation: { update: jest.fn() },
  };
  const queue: any = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
  const realtime: any = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const tool = new SendMediaTool(prisma, realtime, queue);
  const ctx: any = { runId: 'run', agentId: 'agent', organizationId: 'org', conversationId: 'conv', contactId: 'contact', channelId: 'channel' };
  return { tool, prisma, queue, ctx, saved: () => saved };
}
describe('sendMedia: recuperação de enqueue', () => {
  it('reenfileira QUEUED após falha do Redis com o mesmo jobId sem dois-pontos', async () => {
    const f = fixture();
    f.queue.add.mockRejectedValueOnce(new Error('Redis offline')).mockResolvedValue({});
    await expect(f.tool.execute({ mediaId: 'media' }, f.ctx)).rejects.toThrow('Redis offline');
    const result = await f.tool.execute({ mediaId: 'media', legenda: 'Outra legenda' }, f.ctx);
    expect(f.prisma.message.create).toHaveBeenCalledTimes(1);
    expect(f.queue.add).toHaveBeenCalledTimes(2);
    expect(f.queue.add.mock.calls[1]).toEqual(f.queue.add.mock.calls[0]);
    expect(f.queue.add.mock.calls[0][2].jobId).not.toContain(':');
    expect(result.output).toMatchObject({ ok: true, alreadySent: false, status: 'QUEUED' });
  });
  it('não duplica job existente nem chama QUEUED de enviado', async () => {
    const f = fixture(); await f.tool.execute({ mediaId: 'media' }, f.ctx);
    f.queue.getJob.mockResolvedValue({ id: 'job' });
    expect((await f.tool.execute({ mediaId: 'media' }, f.ctx)).output).toMatchObject({ alreadySent: false });
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });
  it.each(['SENT', 'DELIVERED', 'READ', 'FAILED'])('não reenfileira status %s', async status => {
    const f = fixture(); await f.tool.execute({ mediaId: 'media' }, f.ctx); f.saved().status = status;
    expect((await f.tool.execute({ mediaId: 'media' }, f.ctx)).output).toMatchObject({ alreadySent: status !== 'FAILED', ok: status !== 'FAILED' });
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });
  it('não acessa mídia de outra organização', async () => {
    const f = fixture(); f.prisma.agentMedia.findFirst.mockResolvedValue(null);
    expect((await f.tool.execute({ mediaId: 'foreign' }, f.ctx)).output).toMatchObject({ ok: false });
    expect(f.prisma.agentMedia.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', organizationId: 'org' } });
    expect(f.queue.add).not.toHaveBeenCalled();
  });
});

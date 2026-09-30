import { HandoffToAgentTool, handoffLimit } from './handoff-to-agent.tool';

const ctx = { organizationId: 'org', conversationId: 'conv', channelId: 'channel', contactId: 'contact', agentId: 'a', runId: 'run', triggerMessageId: 'inbound', chainDepth: 0 };
const input = { agentId: 'b', motivo: 'Análise de saúde', briefing: 'Cliente informou sua idade e benefício.' };
function fixture() {
  const members = ['a', 'b'].map(agentId => ({ agentId, agent: { id: agentId, name: agentId, publishedRevision: { snapshot: { entryQuestion: null } } } }));
  const prisma: any = {
    $queryRaw: jest.fn(),
    conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv', activeAgentId: 'a', channel: { aiAgentGroupId: 'group' } }), update: jest.fn() },
    aiAgentRun: { findFirst: jest.fn().mockResolvedValue({ revision: { snapshot: { enabledBuiltinTools: ['handoffToAgent'] } } }) },
    aiAgentGroupMember: { findMany: jest.fn().mockResolvedValue(members) },
    aiAgentHandoff: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), create: jest.fn(async ({ data }) => data) },
    message: { create: jest.fn(async ({ data }) => data), findUnique: jest.fn() },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'phone' }) },
    internalNote: { create: jest.fn() }, conversationAuditLog: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn(work => work(prisma));
  const queue = { add: jest.fn() };
  const realtime = { emitToConversation: jest.fn(), emitToChannel: jest.fn() };
  return { tool: new HandoffToAgentTool(prisma, realtime as any, queue as any), prisma, members, queue };
}

describe('handoffToAgent', () => {
  it('troca agente, registra briefing e continua imediatamente sem pergunta', async () => {
    const { tool, prisma, queue } = fixture();
    expect(await tool.execute(input, ctx)).toMatchObject({ finalAction: 'DELEGATED', output: { ok: true, waitForInbound: false } });
    expect(prisma.aiAgentHandoff.create).toHaveBeenCalledWith({ data: expect.objectContaining({ fromAgentId: 'a', toAgentId: 'b', briefing: input.briefing, triggerMessageId: 'inbound' }) });
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv' }, data: { activeAgentId: 'b' } });
    expect(queue.add).not.toHaveBeenCalled();
  });
  it.each([undefined, 'Qual sua renda?'])('envia uma pergunta publicada ou explícita e espera inbound (%s)', async explicit => {
    const { tool, prisma, members, queue } = fixture();
    members[1].agent.publishedRevision.snapshot.entryQuestion = 'Qual sua idade?' as any;
    const result = await tool.execute({ ...input, ...(explicit ? { entryQuestion: explicit } : {}) }, ctx);
    expect(result).toMatchObject({ output: { waitForInbound: true }, finalAction: 'DELEGATED' });
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('send-outbound', expect.objectContaining({ message: { type: 'TEXT', content: { text: explicit ?? 'Qual sua idade?' } } }), expect.objectContaining({ jobId: expect.any(String) }));
  });
  it('não envia segunda mensagem no run', async () => {
    const { tool, prisma } = fixture();
    expect(await tool.execute({ ...input, entryQuestion: 'Qual sua idade?' }, { ...ctx, alreadyReplied: true })).toMatchObject({ output: { ok: false } });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
  });
  it('revalida organização, grupo, atividade e publicação de ambos membros', async () => {
    const { tool, prisma } = fixture();
    prisma.aiAgentGroupMember.findMany.mockResolvedValue([]);
    expect(await tool.execute(input, ctx)).toMatchObject({ output: { ok: false } });
    expect(prisma.aiAgentGroupMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ groupId: 'group', group: { organizationId: 'org' }, agent: { organizationId: 'org', isActive: true, deletedAt: null, publishedRevisionId: { not: null } } }) }));
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
  it('respeita enabledBuiltinTools da revisão fixada no run', async () => {
    const { tool, prisma } = fixture();
    prisma.aiAgentRun.findFirst.mockResolvedValue({ revision: { snapshot: { enabledBuiltinTools: [] } } });
    expect(await tool.execute(input, ctx)).toMatchObject({ output: { ok: false } });
    expect(prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
  });
  it.each(['sem grupo', 'IA pausada', 'agente trocado'])('recusa contexto inválido: %s', async scenario => {
    const { tool, prisma } = fixture();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv', activeAgentId: scenario === 'agente trocado' ? 'other' : 'a', aiEnabled: scenario !== 'IA pausada', channel: { aiAgentGroupId: scenario === 'sem grupo' ? null : 'group' } });
    expect(await tool.execute(input, ctx)).toMatchObject({ output: { ok: false } });
    expect(prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
  });
  it.each(['janela', 'profundidade', 'inbound', 'ping-pong'])('pausa IA e cria nota humana ao atingir %s', async limit => {
    const { tool, prisma } = fixture();
    if (limit === 'janela') prisma.aiAgentHandoff.findMany.mockResolvedValue(Array(5).fill({ fromAgentId: 'x', toAgentId: 'y' }));
    if (limit === 'ping-pong') prisma.aiAgentHandoff.findMany.mockResolvedValue([{ fromAgentId: 'a', toAgentId: 'b' }, { fromAgentId: 'b', toAgentId: 'a' }]);
    if (limit === 'inbound') prisma.aiAgentHandoff.count.mockResolvedValue(3);
    expect(await tool.execute(input, { ...ctx, chainDepth: limit === 'profundidade' ? 3 : 0 })).toMatchObject({ finalAction: 'TRANSFERRED_TO_HUMAN', output: { paused: true } });
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv' }, data: { aiEnabled: false } });
    expect(prisma.internalNote.create).toHaveBeenCalledTimes(1);
    expect(prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
  });
  it('retry reutiliza handoff e mensagem com jobId estável', async () => {
    const { tool, prisma, queue } = fixture();
    prisma.aiAgentHandoff.findUnique.mockResolvedValue({ id: 'receipt', toAgentId: 'b', entryQuestion: 'Idade?' });
    prisma.message.findUnique.mockResolvedValue({ id: 'receipt', status: 'QUEUED', content: { text: 'Idade?' } });
    await tool.execute(input, ctx);
    expect(prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ jobId: 'handoff-receipt' }));
  });
  it('pausa e deixa nota quando o envio da pergunta falha após persistir a troca', async () => {
    const { tool, prisma, queue } = fixture();
    queue.add.mockRejectedValue(new Error('queue unavailable') as never);
    expect(await tool.execute({ ...input, entryQuestion: 'Idade?' }, ctx)).toMatchObject({ finalAction: 'TRANSFERRED_TO_HUMAN', output: { paused: true } });
    expect(prisma.internalNote.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).toHaveBeenLastCalledWith({ where: { id: 'conv' }, data: { aiEnabled: false } });
  });
  it('não reenfileira uma pergunta já enviada ao repetir o handoff', async () => {
    const { tool, prisma, queue } = fixture();
    prisma.aiAgentHandoff.findUnique.mockResolvedValue({ id: 'receipt', toAgentId: 'b', entryQuestion: 'Idade?' });
    prisma.message.findUnique.mockResolvedValue({ id: 'receipt', status: 'SENT', content: { text: 'Idade?' } });
    await tool.execute(input, ctx);
    expect(queue.add).not.toHaveBeenCalled();
  });
  it('permite uma volta A → B → A, mas bloqueia nova inversão', () => {
    expect(handoffLimit([{ fromAgentId: 'a', toAgentId: 'b' }], 'b', 'a')).toBeNull();
    expect(handoffLimit([{ fromAgentId: 'a', toAgentId: 'b' }, { fromAgentId: 'b', toAgentId: 'a' }], 'a', 'b')).toContain('ping-pong');
  });
});

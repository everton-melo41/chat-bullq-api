import { Prisma } from '@prisma/client';
import { StudioActionsService, contactFields } from './studio-actions.service';
import { TagConversationTool } from './tag-conversation.tool';
import { AddTagTool, AssignConversationTool, CreateInternalSummaryTool, MovePipelineCardTool, UpdateContactFieldsTool } from './studio-actions.tools';
import { TransferToHumanTool } from './transfer-to-human.tool';
import { ToolRegistry } from '../tool-registry.service';

const ctx = { organizationId: 'org', channelId: 'channel', conversationId: 'conv', contactId: 'contact', agentId: 'agent', runId: 'run' };
function setup() {
  const conversation = { id: 'conv', ...ctx, assignedToId: null, departmentId: null, status: 'OPEN', aiEnabled: true, activeAgentId: 'agent' };
  const receipts = new Map();
  const tx: any = {
    $queryRaw: jest.fn(),
    aiActionReceipt: { findUnique: jest.fn(({ where }) => receipts.get(where.id)), create: jest.fn(({ data }) => { receipts.set(data.id, data); return data; }) },
    conversation: { findUniqueOrThrow: jest.fn(async () => conversation), update: jest.fn(async ({ data }) => ({ ...conversation, ...data })) },
    internalNote: { create: jest.fn(async ({ data }) => ({ id: 'note', ...data })) },
    department: { findFirst: jest.fn(async () => ({ id: 'dept' })) },
    contact: { findUniqueOrThrow: jest.fn(async () => ({ name: 'Original', email: null, metadata: { existing: 'kept' } })), update: jest.fn() },
    conversationAuditLog: { create: jest.fn() },
    pipelineStage: { findFirst: jest.fn(async () => ({ id: 'stage' })) },
    card: { findFirst: jest.fn(async () => null) },
  };
  const prisma: any = {
    aiAgentRun: { findFirst: jest.fn(async () => ({ id: 'run' })) },
    conversation: { findFirst: jest.fn(async () => conversation) },
    $transaction: jest.fn(async callback => callback(tx)),
  };
  const access: any = { listEligibleAgents: jest.fn(async () => [{ id: 'user' }]) };
  const outbox: any = { enqueue: jest.fn() };
  const realtime: any = { emitToConversation: jest.fn(), emitToChannel: jest.fn() };
  const pipelines: any = { moveCard: jest.fn(async () => ({ id: 'card' })), createCard: jest.fn(async () => ({ id: 'card' })) };
  const tags: any = { execute: jest.fn(async () => ({ output: { ok: true, applied: ['tag'] } })) };
  const service = new StudioActionsService(prisma, access, outbox, realtime, pipelines, tags);
  return { service, prisma, tx, access, outbox, realtime, pipelines, conversation, tags };
}

describe('LOTE A: notas, atribuição, transferência e contato', () => {
  it('recusa organização/contexto incompatíveis antes de escrever', async () => {
    const s = setup(); s.prisma.aiAgentRun.findFirst.mockResolvedValue(null);
    await expect(s.service.execute('createInternalSummary', { content: 'resumo' }, ctx)).rejects.toThrow();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.prisma.aiAgentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org', conversationId: 'conv', agentId: 'agent' }) }));
  });
  it('cria resumo com autoria de IA e não duplica em retry', async () => {
    const s = setup();
    const args = { content: 'Resumo do cliente' };
    const first = await s.service.execute('createInternalSummary', args, ctx);
    expect(await s.service.execute('createInternalSummary', args, ctx)).toEqual(first);
    expect(s.tx.internalNote.create).toHaveBeenCalledTimes(1);
    expect(s.tx.internalNote.create.mock.calls[0][0].data).toMatchObject({ authorId: null, agentId: 'agent', agentRunId: 'run', generatedByAi: true });
    expect(s.realtime.emitToConversation).toHaveBeenCalledWith('conv', 'note:changed', expect.anything());
  });
  it('transferência sem humano pausa IA, limpa agente, cria nota e emite mudança de status', async () => {
    const s = setup();
    await s.service.execute('transferToHuman', { reason: 'Solicitou humano', summary: 'Resumo' }, ctx, 'approver');
    expect(s.tx.conversation.update.mock.calls[0][0].data).toMatchObject({ aiEnabled: false, activeAgentId: null, status: 'PENDING' });
    expect(s.tx.internalNote.create.mock.calls[0][0].data).toMatchObject({ authorId: 'approver', content: 'Solicitou humano\n\nResumo' });
    expect(s.outbox.enqueue).toHaveBeenCalledWith(s.tx, 'CONVERSATION_STATUS_CHANGED', expect.objectContaining({ toStatus: 'PENDING' }));
  });
  it('atribui usuário elegível, abre conversa e emite assigned sem duplicar em retry', async () => {
    const s = setup(); s.conversation.status = 'PENDING';
    await s.service.execute('assignConversation', { userId: 'user' }, ctx);
    await s.service.execute('assignConversation', { userId: 'user' }, ctx);
    expect(s.tx.conversation.update).toHaveBeenCalledTimes(1);
    expect(s.tx.conversation.update.mock.calls[0][0].data).toMatchObject({ assignedToId: 'user', departmentId: null, status: 'OPEN' });
    expect(s.realtime.emitToChannel).toHaveBeenCalledWith('channel', 'conversation:assigned', expect.objectContaining({ assigneeId: 'user' }));
  });
  it('valida acesso do aprovador ao canal', async () => {
    const s = setup();
    await expect(s.service.assertApprover(ctx, 'other')).rejects.toThrow('Aprovador');
    await expect(s.service.assertApprover(ctx, 'user')).resolves.toBeUndefined();
  });
  it('não publica eventos quando transação falha', async () => {
    const s = setup(); s.tx.aiActionReceipt.create.mockRejectedValue(new Error('rollback'));
    await expect(s.service.execute('createInternalSummary', { content: 'Resumo' }, ctx)).rejects.toThrow('rollback');
    expect(s.realtime.emitToConversation).not.toHaveBeenCalled();
  });
  it('recusa usuário sem acesso ao número', async () => {
    const s = setup(); s.access.listEligibleAgents.mockResolvedValue([]);
    await expect(s.service.execute('assignConversation', { userId: 'other' }, ctx)).rejects.toThrow('Usuário');
    expect(s.tx.conversation.update).not.toHaveBeenCalled();
  });
  it.each(['assignConversation', 'transferToHuman'])('%s limita departamento à organização e canal/global', async action => {
    const s = setup();
    await s.service.execute(action, { departmentId: 'dept', reason: 'Humano solicitado' }, ctx);
    expect(s.tx.department.findFirst.mock.calls[0][0].where).toEqual({ id: 'dept', organizationId: 'org', deletedAt: null, OR: [{ channelId: null }, { channelId: 'channel' }] });
    expect(s.tx.conversation.update.mock.calls[0][0].data).toMatchObject({ departmentId: 'dept', assignedToId: null, status: 'PENDING' });
  });
  it('recusa departamento de outro número e destinos simultâneos', async () => {
    const s = setup(); s.tx.department.findFirst.mockResolvedValue(null);
    await expect(s.service.execute('assignConversation', { departmentId: 'other' }, ctx)).rejects.toThrow('Departamento');
    await expect(s.service.execute('assignConversation', { userId: 'user', departmentId: 'dept' }, ctx)).rejects.toThrow('OU');
  });
  it('mescla metadata, preserva nome vazio e registra auditoria uma vez', async () => {
    const s = setup(); const input = { fields: { name: ' ', email: 'A@B.com', cpf: '529.982.247-25', cidade: 'Porto Velho' } };
    await s.service.execute('updateContactFields', input, ctx);
    await s.service.execute('updateContactFields', { fields: { cidade: 'Porto Velho', cpf: '529.982.247-25', email: 'A@B.com', name: ' ' } }, ctx);
    expect(s.tx.contact.update.mock.calls[0][0].data).toEqual({ email: 'a@b.com', metadata: { existing: 'kept', cpf: '52998224725', cidade: 'Porto Velho' } });
    expect(s.tx.conversationAuditLog.create).toHaveBeenCalledTimes(1);
  });
  it.each([{ cpf: '11111111111' }, { cpf: '52998224724' }, { email: 'invalid' }, { dataNascimento: '2025-02-29' }, { dataNascimento: '30/09/2000' }, { admin: 'true' }])('recusa campos inválidos %j', input => {
    expect(() => contactFields(input)).toThrow();
  });
  it('aceita data real e CPF válido', () => expect(contactFields({ dataNascimento: '2000-02-29', cpf: '52998224725' })).toEqual({ dataNascimento: '2000-02-29', cpf: '52998224725' }));
});

describe('LOTE A: pipeline', () => {
  it('cria card ausente uma vez e usa transação compartilhada', async () => {
    const s = setup(); const input = { pipelineId: 'pipe', stageId: 'stage' };
    await s.service.execute('movePipelineCard', input, ctx);
    await s.service.execute('movePipelineCard', input, ctx);
    expect(s.pipelines.createCard).toHaveBeenCalledTimes(1);
    expect(s.pipelines.createCard).toHaveBeenCalledWith('pipe', 'org', { stageId: 'stage', conversationId: 'conv' }, s.tx, expect.any(Array));
  });
  it('reusa método genérico para mover card existente', async () => {
    const s = setup(); s.tx.card.findFirst.mockResolvedValue({ id: 'card', stageId: 'old' });
    await s.service.execute('movePipelineCard', { pipelineId: 'pipe', stageId: 'stage' }, ctx);
    expect(s.pipelines.moveCard).toHaveBeenCalledWith('card', 'org', { toStageId: 'stage', toIndex: 0 }, s.tx, expect.any(Array));
    expect(s.pipelines.createCard).not.toHaveBeenCalled();
  });
  it('rejeita etapa fora do pipeline/organização', async () => {
    const s = setup(); s.tx.pipelineStage.findFirst.mockResolvedValue(null);
    await expect(s.service.execute('movePipelineCard', { pipelineId: 'pipe', stageId: 'other' }, ctx)).rejects.toThrow();
    expect(s.pipelines.createCard).not.toHaveBeenCalled();
  });
});

describe('LOTE A: addTag', () => {
  function tagSetup() {
    const tx: any = { conversationTag: { create: jest.fn() } };
    const prisma: any = { tag: { findMany: jest.fn(async () => [{ id: 'tag', name: 'existing' }]), create: jest.fn() }, $transaction: jest.fn(async fn => fn(tx)) };
    const outbox: any = { enqueue: jest.fn() };
    const tag = new TagConversationTool(prisma, outbox);
    const tool = { execute: (input: Record<string, unknown>, context: typeof ctx) => tag.execute({ ...input, existingOnly: true }, context) };
    return { tx, prisma, outbox, tool };
  }
  it('retry da ação usa recibo e não reaplica a etiqueta', async () => {
    const s = setup();
    await new AddTagTool(s.service).execute({ tagId: 'tag' }, ctx);
    await new AddTagTool(s.service).execute({ tagId: 'tag' }, ctx);
    expect(s.tags.execute).toHaveBeenCalledTimes(1);
    expect(s.tags.execute).toHaveBeenCalledWith({ tagId: 'tag', existingOnly: true }, ctx, s.tx);
  });
  it('prefere ID, limita organização e reusa outbox', async () => {
    const s = tagSetup();
    await s.tool.execute({ tagId: 'tag', name: 'ignored' }, ctx);
    expect(s.prisma.tag.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org', id: 'tag' } }));
    expect(s.prisma.tag.create).not.toHaveBeenCalled();
    expect(s.outbox.enqueue).toHaveBeenCalledWith(s.tx, 'TAG_ADDED', expect.objectContaining({ tagId: 'tag' }));
  });
  it('nome existente preserva maiúsculas e transação compartilhada só emite para vínculo novo', async () => {
    const s = tagSetup();
    const tx: any = { tag: s.prisma.tag, conversationTag: { createMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }) } };
    const tag = new TagConversationTool(s.prisma, s.outbox);
    await tag.execute({ name: 'Cliente VIP', existingOnly: true }, ctx, tx);
    await tag.execute({ name: 'Cliente VIP', existingOnly: true }, ctx, tx);
    expect(s.prisma.tag.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org', name: { in: ['Cliente VIP'] } });
    expect(s.outbox.enqueue).toHaveBeenCalledTimes(1);
  });
  it('não cria nome desconhecido', async () => {
    const s = tagSetup(); s.prisma.tag.findMany.mockResolvedValue([]);
    expect((await s.tool.execute({ name: 'missing' }, ctx)).output).toMatchObject({ ok: false });
    expect(s.prisma.tag.create).not.toHaveBeenCalled();
  });
  it('retry de etiqueta já aplicada não duplica outbox', async () => {
    const s = tagSetup();
    await s.tool.execute({ tagId: 'tag' }, ctx);
    s.tx.conversationTag.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '6' }));
    await s.tool.execute({ tagId: 'tag' }, ctx);
    expect(s.outbox.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('LOTE A: transferência direta/aprovada e catálogo', () => {
  it.each([true, false])('respeita política de aprovação %s', async requiresApproval => {
    const prisma: any = { aiAgent: { findUniqueOrThrow: jest.fn(async () => ({ modelParams: { transferRequiresApproval: requiresApproval } })) } };
    const actions: any = { assertContext: jest.fn(), execute: jest.fn(async () => ({ output: { ok: true } })) };
    const pending: any = { create: jest.fn(async () => ({ id: 'pending' })) };
    const tool = new TransferToHumanTool(prisma, actions, { emitToConversation: jest.fn() } as any, pending);
    await tool.execute({ reason: 'Pediu humano', userId: 'user' }, ctx);
    expect(pending.create).toHaveBeenCalledTimes(requiresApproval ? 1 : 0);
    expect(actions.execute).toHaveBeenCalledTimes(requiresApproval ? 0 : 1);
    if (requiresApproval) expect(pending.create.mock.calls[0][0].args.userId).toBe('user');
  });
  it('expõe as cinco ações para ambos os tipos, com descrição e registro real', () => {
    const actions = {} as any;
    const tools = [new AddTagTool(actions), new CreateInternalSummaryTool(actions), new UpdateContactFieldsTool(actions), new MovePipelineCardTool(actions), new AssignConversationTool(actions)];
    const dummy = Array.from({ length: 16 }, (_, i) => ({ name: 'dummy' + i, description: 'test', parameters: {} }));
    const registry = new (ToolRegistry as any)({ get: () => '' }, ...tools, ...dummy) as ToolRegistry;
    for (const kind of ['ORCHESTRATOR', 'WORKER'] as const) {
      const definitions = registry.getLlmDefinitionsForKind(kind, 'agent');
      for (const tool of tools) {
        expect(registry.get(tool.name)).toBe(tool);
        expect(definitions).toContainEqual(expect.objectContaining({ name: tool.name, description: tool.description }));
      }
    }
  });
});

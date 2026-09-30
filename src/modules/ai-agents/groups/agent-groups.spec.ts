import { AgentGroupsService } from './agent-groups.service';
import { AgentRouterService } from '../router/agent-router.service';
import { agentSnapshot } from '../agents/agent-snapshot';
import { PromptBuilderService } from '../runner/prompt-builder.service';

const conversation: any = { id: 'conv', organizationId: 'org', channelId: 'channel', activeAgentId: null };
describe('roteamento de grupos', () => {
  function fixture(group: string | null = 'group') {
    const prisma: any = {
      channel: { findUnique: jest.fn().mockResolvedValue({ aiAgentGroupId: group, aiEnabled: true }) },
      aiAgentGroup: { findFirst: jest.fn().mockResolvedValue({ initialAgentId: 'initial' }) },
      aiAgent: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: 'initial', name: 'Triagem' }), findUnique: jest.fn().mockResolvedValue({ id: 'active', name: 'Especialista' }) },
      aiAgentChannel: { findFirst: jest.fn().mockResolvedValue({ agent: { id: 'legacy', name: 'Legado' } }) },
      organization: { findUnique: jest.fn().mockResolvedValue({ id: 'org', aiEnabled: true }) },
    };
    const classifier = { classify: jest.fn().mockResolvedValue({ skippedOrchestrator: false }) };
    return { prisma, classifier, router: new AgentRouterService(prisma, classifier as any, {} as any) };
  }
  it('usa inicial antes de classificar, sem precisar de AiAgentChannel', async () => {
    const { router, classifier, prisma } = fixture();
    expect(await router.selectAgent(conversation, 'oi')).toMatchObject({ agentId: 'initial' });
    expect(await router.shouldHandle(conversation)).toEqual({ handle: true });
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(prisma.aiAgentChannel.findFirst).not.toHaveBeenCalled();
  });
  it('palavra-chave de ativação escolhe o agente no início da conversa, ignorando acento e caixa', async () => {
    const { router, prisma } = fixture();
    prisma.aiAgent.findMany.mockResolvedValue([
      { id: 'renda', name: 'Renda', publishedRevision: { snapshot: { modelParams: { activationKeywords: ['auxílio acidente'] } } } },
      { id: 'bpc', name: 'BPC', publishedRevision: { snapshot: { modelParams: { activationKeywords: ['BPC', 'LOAS'] } } } },
    ]);
    expect(await router.selectAgent(conversation, 'Olá! Vi o anúncio do loas, quero saber mais')).toMatchObject({ agentId: 'bpc' });
    expect(await router.selectAgent(conversation, 'Sobre AUXILIO-ACIDENTE')).toMatchObject({ agentId: 'renda' });
    expect(await router.selectAgent(conversation, 'Quero um bpcx qualquer')).toMatchObject({ agentId: 'initial' });
  });
  it('preserva agente ativo', async () => {
    const { router, classifier } = fixture();
    expect(await router.selectAgent({ ...conversation, activeAgentId: 'active' }, 'oi')).toMatchObject({ agentId: 'active' });
    expect(classifier.classify).not.toHaveBeenCalled();
  });
  it('grupo com inicial indisponível não escapa para classificador ou orquestrador', async () => {
    const { router, prisma, classifier } = fixture();
    prisma.aiAgent.findFirst.mockResolvedValue(null);
    expect(await router.selectAgent(conversation, 'oi')).toBeNull();
    expect(await router.shouldHandle(conversation)).toMatchObject({ handle: false });
    expect(classifier.classify).not.toHaveBeenCalled();
  });
  it('mantém classificador e fallback em canal sem grupo', async () => {
    const { router, classifier } = fixture(null);
    expect(await router.selectAgent(conversation, 'oi')).toMatchObject({ agentId: 'legacy' });
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });
});

describe('edição de grupos', () => {
  const dto = { name: 'Escritório', initialAgentId: 'a', memberIds: ['a', 'b'] };
  function fixture() {
    const prisma: any = { $queryRaw: jest.fn(), aiAgent: { count: jest.fn().mockResolvedValue(2) },
      aiAgentGroup: { findFirst: jest.fn().mockResolvedValue({ id: 'g' }), create: jest.fn().mockResolvedValue({ id: 'g' }), update: jest.fn().mockResolvedValue({ id: 'g' }) },
      aiAgentGroupMember: { deleteMany: jest.fn(), createMany: jest.fn() } };
    prisma.$transaction = jest.fn(work => work(prisma));
    return { prisma, service: new AgentGroupsService(prisma) };
  }
  it('salva membros em ordem e verifica organização', async () => {
    const { service, prisma } = fixture();
    await service.save('org', dto);
    expect(prisma.aiAgent.count).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] }, organizationId: 'org', deletedAt: null } });
    expect(prisma.aiAgentGroupMember.createMany).toHaveBeenCalledWith({ data: [{ groupId: 'g', agentId: 'a', order: 0 }, { groupId: 'g', agentId: 'b', order: 1 }] });
  });
  it('recusa inicial fora dos membros', async () => {
    const { service } = fixture();
    await expect(service.save('org', { ...dto, initialAgentId: 'c' })).rejects.toThrow('inicial');
  });
  it('recusa membros de outra organização e grupo inacessível', async () => {
    const { service, prisma } = fixture();
    prisma.aiAgent.count.mockResolvedValue(1);
    await expect(service.save('org', dto)).rejects.toThrow('organização');
    prisma.aiAgentGroup.findFirst.mockResolvedValue(null);
    await expect(service.save('org', dto, 'foreign')).rejects.toThrow('não encontrado');
    expect(prisma.aiAgentGroupMember.deleteMany).not.toHaveBeenCalled();
  });
});

describe('contexto recebido e revisão', () => {
  it('inclui pergunta de entrada no snapshot', () => {
    expect(agentSnapshot({ entryQuestion: 'Qual sua idade?' })).toMatchObject({ entryQuestion: 'Qual sua idade?' });
  });
  it('prompt lê briefing e informa que a pergunta já foi feita', () => {
    const messages = new PromptBuilderService().buildMessages({
      organization: { name: 'Escritório', aiTimezone: 'America/Sao_Paulo' }, agent: { name: 'Saúde', kind: 'WORKER', systemPrompt: 'Analise saúde.' },
      channel: { name: 'Número', type: 'WHATSAPP' }, contact: { name: 'Ana' }, conversation: {}, recentMessages: [],
      memorySummary: null, memoryFacts: null, triggerMessage: { content: { text: 'Tenho 50 anos' }, direction: 'INBOUND', type: 'TEXT' },
      receivedHandoff: { reason: 'Análise', briefing: 'Cliente procura benefício.', entryQuestion: 'Qual sua idade?' },
      handoffTargets: [{ id: 'renda', name: 'Renda' }],
    } as any);
    const text = JSON.stringify(messages);
    expect(text).toContain('Contexto recebido do agente anterior');
    expect(text).toContain('Cliente procura benefício.');
    expect(text).toContain('JÁ FOI FEITA');
    expect(text).toContain('Qual sua idade?');
    expect(text).toContain('renda');
  });
});

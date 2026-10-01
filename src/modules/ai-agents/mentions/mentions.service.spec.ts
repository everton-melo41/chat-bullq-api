import { MentionsService, parseMentions } from './mentions.service';

function service() {
  const prisma: any = {
    aiAgent: { findMany: jest.fn(async ({ where }: any) => where.id.in.includes('ag1') ? [{ id: 'ag1', name: 'Auxílio-doença' }] : []) },
    tag: { findMany: jest.fn(async ({ where }: any) => where.id.in.includes('tg1') ? [{ id: 'tg1', name: 'Aguardando documentos' }] : []) },
    department: { findMany: jest.fn(async () => []) },
    pipelineStage: { findMany: jest.fn(async ({ where }: any) => where.id.in.includes('st1') ? [{ id: 'st1', name: 'Qualificado', pipelineId: 'pl1' }] : []) },
    agentMedia: { findMany: jest.fn(async ({ where }: any) => where.id.in.includes('md1') ? [{ id: 'md1', name: 'Vídeo BPC', kind: 'VIDEO' }] : []) },
  };
  return { svc: new MentionsService(prisma), prisma };
}

describe('menções no prompt', () => {
  it('extrai tipo, id e rótulo', () => {
    expect(parseMentions('passe para @[Auxílio-doença](agent:ag1) e @[resumo](action:summary)')).toEqual([
      { raw: '@[Auxílio-doença](agent:ag1)', label: 'Auxílio-doença', type: 'agent', id: 'ag1' },
      { raw: '@[resumo](action:summary)', label: 'resumo', type: 'action', id: 'summary' },
    ]);
  });

  it('compila cada menção numa ferramenta com id fixo, fora do alcance do modelo', async () => {
    const { svc } = service();
    const out = await svc.compile('org', 'Se incapaz, @[Auxílio-doença](agent:ag1). Aplique @[Aguardando documentos](tag:tg1) e @[Qualificado](stage:st1).');
    const byBuiltin = Object.fromEntries(out.bindings.map(b => [b.builtin, b]));
    expect(byBuiltin.handoffToAgent.fixedArgs).toEqual({ agentId: 'ag1' });
    expect(byBuiltin.addTag.fixedArgs).toEqual({ tagId: 'tg1' });
    expect(byBuiltin.movePipelineCard.fixedArgs).toEqual({ pipelineId: 'pl1', stageId: 'st1' });
    // o id nunca aparece como parâmetro que o modelo possa preencher
    expect(JSON.stringify(byBuiltin.handoffToAgent.definition.parameters)).not.toContain('agentId');
    expect(out.text).toContain(`Auxílio-doença (ferramenta ${byBuiltin.handoffToAgent.toolName})`);
    expect(out.text).not.toContain('agent:ag1');
    expect(out.invalid).toEqual([]);
  });

  it('menção de mídia vira envio com id fixo', async () => {
    const { svc } = service();
    const out = await svc.compile('org', 'Envie @[Vídeo BPC](media:md1).');
    expect(out.bindings[0]).toMatchObject({ builtin: 'sendMedia', fixedArgs: { mediaId: 'md1' }, toolName: expect.stringMatching(/^media_enviar_video_bpc_[a-f0-9]{10}$/) });
    expect(out.bindings[0].definition.description).toContain('o vídeo');
  });

  it('marca como inválida a menção a registro apagado e tira o token do texto', async () => {
    const { svc } = service();
    const out = await svc.compile('org', 'Use @[Apagado](tag:naoexiste) e @[coisa](action:naoexiste).');
    expect(out.invalid.map(m => m.label)).toEqual(['Apagado', 'coisa']);
    expect(out.bindings).toEqual([]);
    expect(out.text).toBe('Use Apagado e coisa.');
  });

  it('prompt sem menção não consulta o banco', async () => {
    const { svc, prisma } = service();
    const out = await svc.compile('org', 'Prompt comum.');
    expect(out).toEqual({ text: 'Prompt comum.', bindings: [], invalid: [] });
    expect(prisma.aiAgent.findMany).not.toHaveBeenCalled();
  });
});

describe('identidade das ferramentas', () => {
  it('mantém etapas homônimas de funis diferentes e nomes normalizados sem colisão', async () => {
    const { svc, prisma } = service();
    prisma.pipelineStage.findMany.mockResolvedValue([
      { id: 'st1', name: 'Qualificado', pipelineId: 'pl1' },
      { id: 'st2', name: 'Qualificado', pipelineId: 'pl2' },
      { id: 'st3', name: 'Qualificádo', pipelineId: 'pl3' },
    ]);
    const prompt = '@[Qualificado](stage:st1) @[Qualificado](stage:st2) @[Qualificádo](stage:st3) @[Qualificado](stage:st1)';
    const result = await svc.compile('org', prompt);
    expect(result.bindings).toHaveLength(3);
    expect(new Set(result.bindings.map(b => b.toolName)).size).toBe(3);
    expect(result.bindings.map(b => b.fixedArgs.pipelineId)).toEqual(['pl1', 'pl2', 'pl3']);
    expect((await svc.compile('org', prompt)).bindings).toEqual(result.bindings);
    expect(result.bindings.every(b => b.toolName.length <= 64)).toBe(true);
  });
  it('recusa colisão residual em vez de sobrescrever o destino', async () => {
    const { svc } = service();
    jest.spyOn(svc as any, 'bind').mockReturnValue({ toolName: 'colisao', builtin: 'addTag', fixedArgs: {}, definition: {} });
    await expect(svc.compile('org', '@[A](tag:a) @[B](tag:b)')).rejects.toThrow('Colisão');
  });
  it('mantém agente publicado fora da matéria como destino permitido', async () => {
    const { svc, prisma } = service();
    const result = await svc.compile('org', '@[Suporte](agent:ag1)');
    expect(result.bindings[0].fixedArgs).toEqual({ agentId: 'ag1' });
    expect(prisma.aiAgent.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['ag1'] }, organizationId: 'org', deletedAt: null, isActive: true, publishedRevisionId: { not: null } });
  });
});

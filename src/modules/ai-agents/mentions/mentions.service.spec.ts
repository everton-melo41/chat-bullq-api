import { MentionsService, parseMentions } from './mentions.service';

function service() {
  const prisma: any = {
    aiAgent: { findMany: jest.fn(async ({ where }: any) => where.id.in.includes('ag1') ? [{ id: 'ag1', name: 'Auxílio-doença' }] : []) },
    tag: { findMany: jest.fn(async ({ where }: any) => where.id.in.includes('tg1') ? [{ id: 'tg1', name: 'Aguardando documentos' }] : []) },
    department: { findMany: jest.fn(async () => []) },
    pipelineStage: { findMany: jest.fn(async ({ where }: any) => where.id.in.includes('st1') ? [{ id: 'st1', name: 'Qualificado', pipelineId: 'pl1' }] : []) },
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
    expect(out.text).toContain('Auxílio-doença (ferramenta passar_para_auxilio_doenca)');
    expect(out.text).not.toContain('agent:ag1');
    expect(out.invalid).toEqual([]);
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

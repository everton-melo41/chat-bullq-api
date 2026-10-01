import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AgentGroupsService, MoveAgentGroupDto, SaveAgentGroupDto } from './agent-groups.service';

function fixture() {
  const prisma: any = {
    $queryRaw: jest.fn(),
    aiAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'a' }) },
    aiAgentGroup: {
      findFirst: jest.fn().mockResolvedValue({ id: 'target', members: [{ agentId: 'b', order: 3 }] }),
      findMany: jest.fn().mockResolvedValue([{ id: 'source', initialAgentId: 'a', members: [{ agentId: 'a', order: 0 }] }]),
      delete: jest.fn(),
    },
    aiAgentGroupMember: { deleteMany: jest.fn(), create: jest.fn() },
  };
  prisma.$transaction = jest.fn(work => work(prisma));
  return { prisma, svc: new AgentGroupsService(prisma) };
}
describe('movimentação transacional de agente', () => {
  it('move único membro e exclui origem vazia numa transação', async () => {
    const f = fixture(); expect(await f.svc.move('org', 'a', 'target')).toEqual({ agentId: 'a', groupId: 'target' });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.prisma.$queryRaw).toHaveBeenCalled();
    expect(f.prisma.aiAgentGroupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 'source', agentId: 'a' } });
    expect(f.prisma.aiAgentGroup.delete).toHaveBeenCalledWith({ where: { id: 'source' } });
    expect(f.prisma.aiAgentGroupMember.create).toHaveBeenCalledWith({ data: { groupId: 'target', agentId: 'a', order: 4 } });
  });
  it('recusa saída do inicial com outros membros antes de qualquer mutação', async () => {
    const f = fixture(); f.prisma.aiAgentGroup.findMany.mockResolvedValue([{ id: 'source', initialAgentId: 'a', members: [{ agentId: 'a' }, { agentId: 'b' }] }]);
    await expect(f.svc.move('org', 'a', 'target')).rejects.toThrow('inicial');
    expect(f.prisma.aiAgentGroupMember.deleteMany).not.toHaveBeenCalled();
    expect(f.prisma.aiAgentGroupMember.create).not.toHaveBeenCalled();
  });
  it('remove vínculo de membro não inicial sem excluir matéria', async () => {
    const f = fixture(); f.prisma.aiAgentGroup.findMany.mockResolvedValue([{ id: 'source', initialAgentId: 'b', members: [{ agentId: 'a' }, { agentId: 'b' }] }]);
    await f.svc.move('org', 'a', null);
    expect(f.prisma.aiAgentGroupMember.deleteMany).toHaveBeenCalled();
    expect(f.prisma.aiAgentGroup.delete).not.toHaveBeenCalled();
    expect(f.prisma.aiAgentGroupMember.create).not.toHaveBeenCalled();
  });
  it('null retira o único agente e exclui matéria', async () => {
    const f = fixture(); await f.svc.move('org', 'a', null);
    expect(f.prisma.aiAgentGroup.delete).toHaveBeenCalled();
    expect(f.prisma.aiAgentGroupMember.create).not.toHaveBeenCalled();
  });
  it('destino já contém membro: não duplica e limpa origens antigas', async () => {
    const f = fixture(); f.prisma.aiAgentGroup.findFirst.mockResolvedValue({ id: 'target', members: [{ agentId: 'a' }] });
    await f.svc.move('org', 'a', 'target');
    expect(f.prisma.aiAgentGroupMember.create).not.toHaveBeenCalled();
    expect(f.prisma.aiAgentGroup.delete).toHaveBeenCalled();
  });
  it('recusa destino de outra organização antes de mutações', async () => {
    const f = fixture(); f.prisma.aiAgentGroup.findFirst.mockResolvedValue(null);
    await expect(f.svc.move('org', 'a', 'foreign')).rejects.toThrow('não encontrada');
    expect(f.prisma.aiAgentGroup.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'foreign', organizationId: 'org' } }));
    expect(f.prisma.aiAgentGroupMember.deleteMany).not.toHaveBeenCalled();
  });
  it('recusa agente de outra organização', async () => {
    const f = fixture(); f.prisma.aiAgent.findFirst.mockResolvedValue(null);
    await expect(f.svc.move('org', 'foreign', null)).rejects.toThrow('não encontrado');
    expect(f.prisma.aiAgent.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', organizationId: 'org', deletedAt: null } });
  });
  it('erro ao inserir destino rejeita a transação inteira', async () => {
    const f = fixture(); f.prisma.aiAgentGroupMember.create.mockRejectedValue(new Error('insert failed'));
    await expect(f.svc.move('org', 'a', 'target')).rejects.toThrow('insert failed');
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('exclusão de matéria usa a mesma trava organizacional da movimentação', async () => {
    const f = fixture();
    expect(await f.svc.remove('org', 'target')).toEqual({ deleted: true });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.prisma.$queryRaw).toHaveBeenCalled();
    expect(f.prisma.aiAgentGroup.findFirst).toHaveBeenCalledWith({ where: { id: 'target', organizationId: 'org' } });
    expect(f.prisma.aiAgentGroupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 'target' } });
  });
  it('DTO exige groupId explícito (string ou null)', async () => {
    for (const groupId of [null, 'target']) expect(await validate(plainToInstance(MoveAgentGroupDto, { groupId }))).toEqual([]);
    for (const body of [{}, { groupId: 1 }, { groupId: '' }]) expect((await validate(plainToInstance(MoveAgentGroupDto, body))).length).toBeGreaterThan(0);
  });
  it('DTO só aceita tipos TESE e SUPORTE', async () => {
    const base = { name: 'Andamentos', initialAgentId: 'a', memberIds: ['a'] };
    for (const kind of ['TESE', 'SUPORTE']) expect(await validate(plainToInstance(SaveAgentGroupDto, { ...base, kind }))).toEqual([]);
    expect((await validate(plainToInstance(SaveAgentGroupDto, { ...base, kind: 'OUTRO' }))).length).toBeGreaterThan(0);
  });
});

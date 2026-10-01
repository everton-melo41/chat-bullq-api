import { AiAgentRunnerService } from './agent-runner.service';

function fixture(waitForInbound = false) {
  const runner: any = Object.create(AiAgentRunnerService.prototype);
  const conversation = { id: 'conv', organizationId: 'org', channelId: 'channel', contactId: 'contact', activeAgentId: 'a', aiEnabled: true };
  const agents = ['a', 'b'].map(id => ({ id, name: id, organizationId: 'org', kind: 'WORKER', publishedRevisionId: `rev-${id}`, modelId: 'model' }));
  let releaseDestination!: () => void;
  const destination = new Promise<void>(resolve => { releaseDestination = resolve; });
  let calls = 0;
  const prisma = {
    conversation: { findUnique: jest.fn(async () => ({ ...conversation })), update: jest.fn(async ({ data }) => Object.assign(conversation, data)) },
    aiAgent: { findFirst: jest.fn(async ({ where }) => agents.find(a => a.id === where.id)) },
    aiAgentRevision: { findFirst: jest.fn(async ({ where }) => ({ id: where.id, snapshot: { skills: [], enabledBuiltinTools: ['handoffToAgent'] } })) },
    aiAgentRun: { create: jest.fn(async ({ data }) => ({ id: `run-${data.agentId}`, ...data })), update: jest.fn() },
    organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org' }) },
    channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({ aiAgentGroupId: 'group' }) },
    contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
    aiAgentMemory: { findUnique: jest.fn().mockResolvedValue(null) },
    aiAgentHandoff: { findFirst: jest.fn().mockResolvedValue(null) },
    aiAgentGroupMember: { findMany: jest.fn().mockResolvedValue(agents.map(agent => ({ agentId: agent.id, agent }))) },
  };
  let lockHeld = false;
  let tail = Promise.resolve();
  Object.assign(runner, { prisma,
    idempotency: { withLock: jest.fn((_key, work) => {
      const next = tail.then(async () => { lockHeld = true; try { await work(); } finally { lockHeld = false; } });
      tail = next.catch(() => {}); return next;
    }) },
    logger: { debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    agentRouter: { selectAgent: jest.fn().mockResolvedValue({ agentId: 'a' }) },
    catalogSync: { getCompactCatalog: jest.fn().mockResolvedValue([]) }, realtime: { emitToConversation: jest.fn() },
    loadConversationContext: jest.fn().mockResolvedValue([]), mediaUrlResolver: { resolveMany: jest.fn().mockResolvedValue(new Map()) },
    resolveToolsAndSkills: jest.fn().mockResolvedValue({ llmTools: [{ name: 'handoffToAgent' }], customSkillsByName: new Map(), skillInstructions: [] }),
    promptBuilder: { buildMessages: jest.fn(() => []) }, augmentSystemPromptWithLayers: jest.fn(), scheduleAfterRunJobs: jest.fn().mockResolvedValue(undefined),
    modelRouter: { selectModel: jest.fn(() => 'model') },
    llm: { complete: jest.fn(async () => {
      calls++;
      if (calls === 2) await destination;
      return { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
        stopReason: calls === 1 ? 'tool_use' : 'stop', message: calls === 1 ? { role: 'assistant', toolCalls: [{ id: 'call', name: 'handoffToAgent', arguments: { agentId: 'b' } }] } : { role: 'assistant', content: '' } };
    }) },
    executeToolCalls: jest.fn(async () => { conversation.activeAgentId = 'b'; return [{ toolName: 'handoffToAgent', toolCallId: 'call', finalAction: 'DELEGATED', output: { ok: true, waitForInbound } }]; }),
  });
  return { runner, prisma, input: { conversation, triggerMessage: { id: 'inbound', content: { text: 'oi' } } }, releaseDestination, isLocked: () => lockHeld };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
describe('continuação de grupos sob mutex', () => {
  it('inicia destino imediatamente e mantém mutex até terminar toda cadeia', async () => {
    const f = fixture();
    let finished = false;
    const work = f.runner.run(f.input).then(() => { finished = true; });
    await flush();
    expect(f.prisma.aiAgentRun.create).toHaveBeenCalledTimes(2);
    expect(f.isLocked()).toBe(true);
    expect(finished).toBe(false);
    expect(f.runner.executeToolCalls).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ chainDepth: 0 }), expect.any(Map), false, 'WORKER', ['handoffToAgent'], expect.any(Map));
    f.releaseDestination(); await work;
    expect(f.isLocked()).toBe(false);
  });
  it('pergunta de entrada termina cadeia sem iniciar destino', async () => {
    const f = fixture(true);
    await f.runner.run(f.input);
    expect(f.prisma.aiAgentRun.create).toHaveBeenCalledTimes(1);
    expect(f.runner.llm.complete).toHaveBeenCalledTimes(1);
  });
  it('serializa outro run enquanto destino está respondendo', async () => {
    const f = fixture();
    const first = f.runner.run(f.input); await flush();
    const second = f.runner.run(f.input); await flush();
    expect(f.prisma.aiAgentRun.create).toHaveBeenCalledTimes(2);
    f.releaseDestination(); await Promise.all([first, second]);
    expect(f.prisma.aiAgentRun.create).toHaveBeenCalledTimes(3);
  });
  it('retry do mesmo inbound não inicia destino que aguarda pergunta', async () => {
    const f = fixture(true);
    f.prisma.aiAgentHandoff.findFirst.mockResolvedValue({ entryQuestion: 'Idade?', toAgentId: 'a', triggerMessageId: 'inbound' } as never);
    await f.runner.run(f.input);
    expect(f.prisma.aiAgentRun.create).not.toHaveBeenCalled();
  });
  it('estado pausado é relido dentro da trava', async () => {
    const f = fixture(); f.input.conversation.aiEnabled = false;
    await f.runner.run(f.input);
    expect(f.prisma.aiAgentRun.create).not.toHaveBeenCalled();
  });
});

describe('recuperação de lote debounced', () => {
  it('persiste identidade e não cria nem executa outro run concluído no retry', async () => {
    const f = fixture(true);
    f.runner.llm.complete.mockResolvedValue({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'stop', message: { role: 'assistant', content: '' } });
    const runs = new Map<string, any>();
    (f.prisma.aiAgentRun as any).findUnique = jest.fn(async ({ where }) => runs.get(where.batchKey) ?? null);
    f.prisma.aiAgentRun.create.mockImplementation(async ({ data }: any) => {
      const run = { id: 'persisted', ...data }; runs.set(data.batchKey, run); return run;
    });
    f.prisma.aiAgentRun.update.mockImplementation(async ({ data }: any) => {
      const run = [...runs.values()][0]; Object.assign(run, data); return run;
    });
    const input = { ...f.input, batchId: 'inbound' };
    await f.runner.run(input);
    // O processo caiu depois da conclusão, antes de limpar due no Redis.
    await f.runner.run(input);
    expect(f.prisma.aiAgentRun.create).toHaveBeenCalledTimes(1);
    expect(f.prisma.aiAgentRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ batchKey: 'conv/inbound/0' }) }));
    expect(f.runner.llm.complete).toHaveBeenCalledTimes(1);
  });
  it('não consulta roteador nem LLM para resposta concluída', async () => {
    const f = fixture();
    (f.prisma.aiAgentRun as any).findUnique = jest.fn().mockResolvedValue({ id: 'old', status: 'COMPLETED', finalAction: 'REPLIED' });
    await f.runner.run({ ...f.input, batchId: 'inbound' });
    expect(f.runner.agentRouter.selectAgent).not.toHaveBeenCalled();
    expect(f.prisma.aiAgentRun.create).not.toHaveBeenCalled();
  });
  it('retoma run incompleto com mesmo id, agente, revisão e consumo anterior', async () => {
    const f = fixture();
    const previous = { id: 'old', agentId: 'a', revisionId: 'pinned', status: 'RUNNING', inputTokens: 10, outputTokens: 5, costUsd: 0.1 };
    (f.prisma.aiAgentRun as any).findUnique = jest.fn().mockResolvedValue(previous);
    f.prisma.aiAgentRun.update.mockImplementation(async ({ data }: any) => ({ ...previous, ...data }));
    f.runner.llm.complete.mockResolvedValue({ usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'stop', message: { role: 'assistant', content: '' } });
    await f.runner.run({ ...f.input, batchId: 'inbound' });
    expect(f.prisma.aiAgentRun.create).not.toHaveBeenCalled();
    expect(f.runner.agentRouter.selectAgent).not.toHaveBeenCalled();
    expect(f.prisma.aiAgentRevision.findFirst).toHaveBeenCalledWith({ where: { id: 'pinned', agentId: 'a', organizationId: 'org' } });
    expect(f.prisma.aiAgentRun.update).toHaveBeenLastCalledWith({ where: { id: 'old' }, data: expect.objectContaining({ status: 'COMPLETED', inputTokens: 12, outputTokens: 6, costUsd: 0.11 }) });
  });
  it('cadeia já concluída não repete delegação nem resposta de destino', async () => {
    const f = fixture();
    (f.prisma.aiAgentRun as any).findUnique = jest.fn(async ({ where }) => ({ id: where.batchKey, status: 'COMPLETED', finalAction: where.batchKey.endsWith('/0') ? 'DELEGATED' : 'REPLIED' }));
    await f.runner.run({ ...f.input, batchId: 'inbound' });
    expect(f.prisma.aiAgentRun.create).not.toHaveBeenCalled();
    expect(f.runner.llm.complete).not.toHaveBeenCalled();
    expect((f.prisma.aiAgentRun as any).findUnique).toHaveBeenCalledTimes(2);
  });
  it('novo inbound tem identidade independente', async () => {
    const f = fixture(true);
    (f.prisma.aiAgentRun as any).findUnique = jest.fn(async ({ where }) => where.batchKey === 'conv/inbound/0' ? { status: 'COMPLETED', finalAction: 'REPLIED' } : null);
    await f.runner.run({ ...f.input, batchId: 'inbound2', triggerMessage: { id: 'inbound2', content: { text: 'mais' } } });
    expect(f.prisma.aiAgentRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ batchKey: 'conv/inbound2/0' }) }));
  });
});

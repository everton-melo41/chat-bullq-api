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

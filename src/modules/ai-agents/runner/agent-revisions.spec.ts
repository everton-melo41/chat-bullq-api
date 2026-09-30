import { AiAgentRunnerService } from './agent-runner.service';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';

function runnerFixture() {
  const runner: any = Object.create(AiAgentRunnerService.prototype);
  const agent = { id: 'agent', organizationId: 'org', kind: 'WORKER', publishedRevisionId: 'published', draftRevisionId: 'draft', systemPrompt: 'unpublished', modelId: 'unpublished-model' };
  const snapshot = { kind: 'WORKER', systemPrompt: 'published prompt', modelId: 'published-model', modelParams: { routing: { alwaysPrimary: true } }, enabledBuiltinTools: [], skills: [{ skillId: 'published-skill', requiresApproval: true }] };
  const prisma = {
    aiAgent: { findFirst: jest.fn().mockResolvedValue(agent) },
    aiAgentRevision: { findFirst: jest.fn().mockResolvedValue({ id: 'published', snapshot }) },
    aiAgentRun: { create: jest.fn().mockResolvedValue({ id: 'run' }) },
    organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org' }) },
    channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({ type: 'WHATSAPP' }) },
    contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'contact' }) },
    conversation: { findUnique: jest.fn().mockImplementation(async () => input.conversation) },
    aiAgentHandoff: { findFirst: jest.fn().mockResolvedValue(null) },
    aiAgentMemory: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const stop = new Error('stop after collecting prompt');
  Object.assign(runner, {
    prisma,
    idempotency: { withLock: jest.fn(async (_key, work) => work()) },
    logger: { debug: jest.fn() },
    agentRouter: { selectAgent: jest.fn().mockResolvedValue({ agentId: 'agent' }) },
    catalogSync: { getCompactCatalog: jest.fn().mockResolvedValue([]) },
    realtime: { emitToConversation: jest.fn() },
    loadConversationContext: jest.fn().mockResolvedValue([]),
    resolveToolsAndSkills: jest.fn().mockResolvedValue({ llmTools: [], customSkillsByName: new Map(), skillInstructions: [] }),
    mediaUrlResolver: { resolveMany: jest.fn().mockResolvedValue(new Map()) },
    promptBuilder: { buildMessages: jest.fn(() => { throw stop; }) },
  });
  return { runner, prisma, agent, snapshot, stop };
}

const input: any = { conversation: { id: 'conv', organizationId: 'org', channelId: 'channel', contactId: 'contact' }, triggerMessage: { id: 'msg', content: { text: 'hello' } } };

describe('published runtime', () => {
  it('pins published snapshot for prompt, model, tools and run audit', async () => {
    const { runner, prisma, snapshot, stop } = runnerFixture();
    await expect(runner.run(input)).rejects.toThrow(stop);
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ revisionId: 'published', modelId: 'published-model' }) });
    expect(runner.promptBuilder.buildMessages).toHaveBeenCalledWith(expect.objectContaining({ agent: expect.objectContaining(snapshot) }));
    expect(runner.resolveToolsAndSkills).toHaveBeenCalledWith('agent', 'WORKER', [], snapshot.skills, 'org');
  });
  it('does not execute agents that have only a draft', async () => {
    const { runner, prisma, agent } = runnerFixture();
    agent.publishedRevisionId = null as any;
    await runner.run(input);
    expect(prisma.aiAgentRevision.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiAgentRun.create).not.toHaveBeenCalled();
  });
  it('uses pinned skill approval even if current agent bindings change', async () => {
    const executor: any = Object.create(HttpToolExecutorService.prototype);
    executor.prisma = { aiAgentSkill: { findUnique: jest.fn() } };
    executor.gateAsPendingAction = jest.fn().mockResolvedValue({ output: { pending: true } });
    const result = await executor.approvalGate({ id: 'skill', organizationId: 'org', name: 'action' }, {}, { organizationId: 'org', skillBindings: [{ skillId: 'skill', requiresApproval: true }] });
    expect(result).toEqual({ output: { pending: true } });
    expect(executor.prisma.aiAgentSkill.findUnique).not.toHaveBeenCalled();
    await expect(executor.approvalGate({ id: 'other', organizationId: 'org' }, {}, { organizationId: 'org', skillBindings: [] })).rejects.toThrow('no longer assigned');
  });
});

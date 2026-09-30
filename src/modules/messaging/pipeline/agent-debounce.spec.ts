import { DelayedError } from 'bullmq';
import { InboundMessageProcessor, agentDebounceMs } from './inbound-message.processor';
import { AiAgentRunnerService } from '../../ai-agents/runner/agent-runner.service';
import { PromptBuilderService } from '../../ai-agents/runner/prompt-builder.service';

/** Stateful queue/Redis double; no connection to Redis, DB or model provider. */
function setup() {
  const state: Record<string, Record<string, string>> = {};
  const jobs = new Map<string, any>();
  const messages: any[] = [];
  const redis = {
    hsetnx: jest.fn(async (k, f, v) => { state[k] ??= {}; if (!(f in state[k])) state[k][f] = v; }),
    hset: jest.fn(async (k, f, v) => { state[k] ??= {}; state[k][f] = v; }),
    hget: jest.fn(async (k, f) => state[k]?.[f] ?? null),
    hgetall: jest.fn(async k => ({ ...state[k] })),
    expire: jest.fn(), persist: jest.fn(),
    eval: jest.fn(async (_script, _count, k, value) => { if (state[k]?.due === value) delete state[k].due; }),
  };
  const queue = {
    client: Promise.resolve(redis),
    getJob: jest.fn(async id => jobs.get(id)),
    add: jest.fn(async (name, data, opts) => {
      const job: any = { name, data, opts, active: false, isActive: jest.fn(async () => job.active),
        remove: jest.fn(async () => { jobs.delete(opts.jobId); }),
        moveToDelayed: jest.fn(async (at: number) => { job.active = false; job.opts.delay = at - Date.now(); }),
      };
      jobs.set(opts.jobId, job); return job;
    }),
  };
  const prisma = {
    conversation: { findUnique: jest.fn(async () => ({ id: 'conv', organizationId: 'org', channelId: 'channel' })) },
    message: {
      findUnique: jest.fn(async ({ where }) => messages.find(m => m.id === where.id)),
      findFirst: jest.fn(async ({ where }) => where.direction === 'OUTBOUND' ? null : messages.at(-1)),
      findMany: jest.fn(async ({ take }) => [...messages].reverse().slice(0, take ?? messages.length)),
    },
  };
  const runner = Object.create(AiAgentRunnerService.prototype) as AiAgentRunnerService;
  Object.assign(runner, { prisma });
  const prompt = new PromptBuilderService() as any;
  const contexts: string[][] = [];
  const dependencies = {
    prisma, inboundQueue: queue,
    logger: { debug: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    idempotency: { withLock: jest.fn(async (_key, work) => work()) },
    agentRouter: { shouldHandle: jest.fn(async () => ({ handle: true })) },
    agentRunner: { run: jest.fn(async () => { contexts.push((await runner.loadConversationContext('conv')).reverse().map(m => prompt.extractText(m))); }) },
    transcription: { transcribe: jest.fn(async (): Promise<void> => undefined) },
    watchdog: { cancelCheck: jest.fn(async () => undefined) },
  };
  const processor = () => Object.assign(Object.create(InboundMessageProcessor.prototype), dependencies, { running: new Set(), followupNeeded: new Set() });
  const inbound = (id: string, type = 'TEXT', content: any = { text: id }, metadata = {}) => {
    messages.push({ id, conversationId: 'conv', direction: 'INBOUND', createdAt: new Date(), type, content, metadata });
    return { name: 'dispatch-ai', data: { conversationId: 'conv', messageId: id, organizationId: 'org', type } };
  };
  const fire = async (p: any) => {
    const job = [...jobs.values()][0]; job.active = true;
    await expect(p.process(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError);
    return job;
  };
  return { state, jobs, messages, queue, prisma, dependencies, processor, inbound, fire, contexts, runner };
}

describe('Durable customer message debounce', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-09-30T10:00:00Z')); delete process.env.AGENT_DEBOUNCE_MS; delete process.env.AGENT_DEBOUNCE_AUDIO_MS; });
  afterEach(() => jest.useRealTimers());

  it('three messages replace one pending job and produce one run with all three after a restart', async () => {
    const h = setup(); const p = h.processor();
    await p.process(h.inbound('m1', 'TEXT', { text: 'Olá' }));
    jest.advanceTimersByTime(2000);
    await p.process(h.inbound('m2', 'IMAGE', { caption: 'Este produto' }));
    jest.advanceTimersByTime(2000);
    await p.process(h.inbound('m3', 'TEXT', { text: 'Quanto custa?' }));
    expect(h.jobs.size).toBe(1);
    expect(new Set(h.queue.add.mock.calls.map(c => c[2].jobId)).size).toBe(1);
    expect(h.queue.add.mock.calls[0][2].jobId).not.toContain(':');
    expect(h.dependencies.agentRunner.run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(18000);
    await h.fire(h.processor()); // new worker instance, same durable queue
    expect(h.dependencies.agentRunner.run).toHaveBeenCalledTimes(1);
    expect(h.contexts).toEqual([['Olá', 'Este produto', 'Quanto custa?']]);
    await h.fire(h.processor()); // idle job must never produce another reply
    expect(h.dependencies.agentRunner.run).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('audio blocks an existing timer until transcription settles (failure=%s)', async failure => {
    const h = setup(); const p = h.processor();
    await p.process(h.inbound('text'));
    let finish!: () => void;
    const audio = h.inbound('audio', 'AUDIO', { text: '', caption: 'Pedido em áudio' });
    h.dependencies.transcription.transcribe.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = () => { if (failure) reject(new Error('transcription unavailable')); else { h.messages[1].metadata = { transcription: { text: 'Quero dois' } }; resolve(); } };
    }));
    const pending = p.process(audio);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    jest.advanceTimersByTime(30000);
    await h.fire(h.processor());
    expect(h.dependencies.agentRunner.run).not.toHaveBeenCalled();
    finish(); await pending;
    expect(Number(h.state['ai-debounce-conv'].due)).toBe(Date.now() + 25000);
    jest.advanceTimersByTime(24999);
    await h.fire(p);
    expect(h.dependencies.agentRunner.run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await h.fire(p);
    expect(h.dependencies.agentRunner.run).toHaveBeenCalledTimes(1);
    expect(h.contexts[0][1]).toContain('Pedido em áudio');
    expect(h.contexts[0][1]).toContain(failure ? 'áudio sem transcrição' : 'Quero dois');
  });

  it('keeps a durable follow-up when a new message arrives during a run', async () => {
    const h = setup(); const p = h.processor();
    await p.process(h.inbound('first'));
    h.dependencies.agentRunner.run.mockImplementationOnce(async () => { await p.process(h.inbound('followup')); });
    jest.advanceTimersByTime(18000); await h.fire(p);
    expect(Number(h.state['ai-debounce-conv'].due)).toBe(Date.now() + 18000);
    jest.advanceTimersByTime(18000); await h.fire(p);
    expect(h.dependencies.agentRunner.run).toHaveBeenCalledTimes(2);
  });

  it('retains the deadline on a failed run so the BullMQ retry can execute', async () => {
    const h = setup(); const p = h.processor();
    await p.process(h.inbound('m1')); jest.advanceTimersByTime(18000);
    h.dependencies.agentRunner.run.mockRejectedValueOnce(new Error('temporary'));
    const job = [...h.jobs.values()][0]; job.active = true;
    await expect(p.process(job, 'token')).rejects.toThrow('temporary');
    expect(h.state['ai-debounce-conv'].due).toBeDefined();
    await h.fire(p);
    expect(h.dependencies.agentRunner.run).toHaveBeenCalledTimes(2);
  });

  it('does not truncate an unanswered burst beyond the 30-message history limit', async () => {
    const h = setup(); for (let i = 0; i < 45; i++) { h.inbound(`m${i}`); jest.advanceTimersByTime(1); }
    expect(await h.runner.loadConversationContext('conv')).toHaveLength(45);
  });

  it('uses configurable valid windows and falls back on invalid values', () => {
    expect(agentDebounceMs()).toBe(18000); expect(agentDebounceMs(true)).toBe(25000);
    process.env.AGENT_DEBOUNCE_MS = '7000'; process.env.AGENT_DEBOUNCE_AUDIO_MS = '35000';
    expect(agentDebounceMs()).toBe(7000); expect(agentDebounceMs(true)).toBe(35000);
    process.env.AGENT_DEBOUNCE_MS = '-1'; expect(agentDebounceMs()).toBe(18000);
    delete process.env.AGENT_DEBOUNCE_MS; delete process.env.AGENT_DEBOUNCE_AUDIO_MS;
  });
});

describe('hasFreshAudioPending', () => {
  const { hasFreshAudioPending } = require('./inbound-message.processor');
  it('espera enquanto a transcrição é recente', () => {
    expect(hasFreshAudioPending({ 'audio-1': `pending-${1_000_000}` }, 1_000_000 + 60_000)).toBe(true);
  });
  it('ignora transcrição travada há mais de 3 minutos', () => {
    expect(hasFreshAudioPending({ 'audio-1': `pending-${1_000_000}` }, 1_000_000 + 181_000)).toBe(false);
  });
  it('não bloqueia com áudios já concluídos', () => {
    expect(hasFreshAudioPending({ 'audio-1': 'done', due: '123' })).toBe(false);
  });
});

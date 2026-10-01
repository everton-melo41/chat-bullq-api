import Redis from 'ioredis';
import { REDIS_CLIENT_TOKEN } from '../memory/short-term/redis.provider';
import { BadRequestException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm.types';
import { MentionsService } from './mentions.service';

export interface TestChatTurn { role: 'user' | 'assistant'; content: string }

/**
 * Chat de teste do estúdio. Usa o prompt (rascunho ou publicado) com as
 * menções compiladas e o modelo do agente, mas NÃO executa nenhuma ação:
 * as ferramentas que o agente chamaria voltam como "simuladas". Nada é
 * enviado a cliente. Apenas o consumo é registrado. O histórico vem do navegador (sem estado).
 */
@Injectable()
export class AgentTestChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly mentions: MentionsService,
    @Inject(REDIS_CLIENT_TOKEN) private readonly redis: Redis,
  ) {}

  usage(organizationId: string, agentId: string) {
    return this.prisma.aiAgentTestUsage.findMany({ where: { organizationId, agentId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async run(organizationId: string, agentId: string, history: TestChatTurn[], useDraft: boolean, userId?: string, sessionId?: string) {
    if (!Array.isArray(history) || !history.length) throw new BadRequestException('Envie ao menos uma mensagem');
    if (history.length > 100) throw new BadRequestException('Limite de 50 turnos por teste. Reinicie a conversa.');
    if (history.some(t => !t || !['user', 'assistant'].includes(t.role) || typeof t.content !== 'string' || t.content.length > 4000)) throw new BadRequestException('Histórico inválido');
    const agent = await this.prisma.aiAgent.findFirst({
      where: { id: agentId, organizationId, deletedAt: null },
      include: { draftRevision: true, publishedRevision: true },
    });
    if (!agent) throw new NotFoundException('Agente não encontrado');
    const source = (useDraft && agent.draftRevision?.snapshot) || agent.publishedRevision?.snapshot || agent;
    const snap = source as Record<string, any>;

    const compiled = await this.mentions.compile(organizationId, String(snap.systemPrompt ?? ''));
    const system = `${compiled.text}\n\nContexto: conversa de WhatsApp com um lead. Responda como mensagem de WhatsApp, curta e natural. Use as ferramentas indicadas no prompt quando for o momento.`;
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      ...history.map(t => ({ role: t.role, content: String(t.content ?? '').slice(0, 4000) }) as LlmMessage),
    ];

    // Reserva atômica: a cota inclui tentativas com falha e expira no próximo dia UTC.
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const expiry = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000);
    const allowed = await this.redis.eval(`
      local n = tonumber(redis.call('GET', KEYS[1]) or '0')
      if n >= 300 then return 0 end
      redis.call('INCR', KEYS[1])
      redis.call('EXPIREAT', KEYS[1], ARGV[1])
      return 1`, 1, `ai-test-daily:${organizationId}:${day}`, String(expiry));
    if (Number(allowed) !== 1) throw new HttpException('Limite diário de 300 turnos de teste da organização atingido', 429);
    const usage = await this.prisma.aiAgentTestUsage.create({ data: {
      organizationId, agentId, userId, sessionId, modelId: String(snap.modelId ?? agent.modelId),
    } });
    const started = Date.now();
    const res = await this.llm.complete({
      modelId: String(snap.modelId ?? agent.modelId),
      messages,
      tools: compiled.bindings.map(b => b.definition),
      maxTokens: Math.min(Number(snap.maxTokens ?? 1024), 2048),
      temperature: Number(snap.temperature ?? 0.7),
    }).catch(async error => {
      await this.prisma.aiAgentTestUsage.update({ where: { id: usage.id }, data: { status: 'FAILED' } });
      throw error;
    });
    await this.prisma.aiAgentTestUsage.update({ where: { id: usage.id }, data: {
      status: 'COMPLETED', inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd,
    } });

    const bindings = new Map(compiled.bindings.map(b => [b.toolName, b]));
    const actions = (res.message.toolCalls ?? []).map(call => {
      const b = bindings.get(call.name);
      return { tool: call.name, description: b?.definition.description ?? 'ferramenta desconhecida', args: call.arguments, simulated: true };
    });
    const handoff = (res.message.toolCalls ?? []).map(c => bindings.get(c.name)).find(b => b?.builtin === 'handoffToAgent');
    let handoffTo: { id: string; name: string } | null = null;
    if (handoff) {
      const target = await this.prisma.aiAgent.findFirst({ where: { id: String(handoff.fixedArgs.agentId), organizationId }, select: { id: true, name: true } });
      handoffTo = target;
    }
    const reply = typeof res.message.content === 'string'
      ? res.message.content
      : res.message.content.map(p => ('text' in p ? p.text : '')).join('');

    return {
      agent: { id: agent.id, name: agent.name },
      source: useDraft && agent.draftRevision ? 'rascunho' : 'publicado',
      reply: reply.trim(),
      actions,
      handoffTo,
      invalidMentions: compiled.invalid.map(m => m.label),
      ms: Date.now() - started,
      tokens: { input: res.usage.inputTokens, output: res.usage.outputTokens },
    };
  }
}

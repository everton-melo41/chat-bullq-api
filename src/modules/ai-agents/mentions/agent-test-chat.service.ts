import { KnowledgeService } from '../knowledge/knowledge.service';
import { knowledgeBinding, knowledgePrompt } from '../knowledge/knowledge.binding';
import Redis from 'ioredis';
import { REDIS_CLIENT_TOKEN } from '../memory/short-term/redis.provider';
import { BadRequestException, HttpException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm.types';
import { MentionsService } from './mentions.service';

export interface TestChatTurn { role: 'user' | 'assistant'; content: string }

/**
 * Chat de teste do estúdio. Usa o prompt (rascunho ou publicado) com as
 * menções compiladas e o modelo do agente, e executa apenas consultas à base de conhecimento:
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
    @Optional() private readonly knowledge?: KnowledgeService,
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
    const docs = this.knowledge ? await this.knowledge.linked(organizationId, agentId, true) : [];
    if (docs.length && !compiled.bindings.some(b => b.builtin === 'searchKnowledge')) compiled.bindings.push(knowledgeBinding);
    compiled.text += knowledgePrompt(docs);
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
    const bindings = new Map(compiled.bindings.map(b => [b.toolName, b]));
    const textOf = (c: LlmMessage['content']) => typeof c === 'string' ? c : c.map(p => ('text' in p ? p.text : '')).join('');
    const tokens = { input: 0, output: 0, cost: 0 };
    const actions: Array<{ tool: string; description: string; args: Record<string, unknown>; simulated: boolean; result?: unknown }> = [];
    let reply = '';
    let handoffTo: { id: string; name: string } | null = null;

    // Mesmo ciclo do runner: o modelo chama ferramentas, recebe o resultado e
    // continua até responder. Consulta à base roda de verdade (só leitura);
    // demais ações voltam simuladas. Passagem de agente encerra o turno aqui.
    try {
      for (let iteration = 0; iteration < 4; iteration++) {
        const res = await this.llm.complete({
          modelId: String(snap.modelId ?? agent.modelId),
          messages,
          tools: compiled.bindings.map(b => b.definition),
          maxTokens: Math.min(Number(snap.maxTokens ?? 1024), 2048),
          temperature: Number(snap.temperature ?? 0.7),
        });
        tokens.input += res.usage.inputTokens; tokens.output += res.usage.outputTokens; tokens.cost += res.usage.costUsd;
        const text = textOf(res.message.content).trim();
        if (text) reply = reply ? `${reply}\n${text}` : text;
        const calls = res.message.toolCalls ?? [];
        if (!calls.length) break;
        messages.push({ role: 'assistant', content: text, toolCalls: calls });
        for (const call of calls) {
          const b = bindings.get(call.name);
          let output: unknown;
          if (b?.builtin === 'searchKnowledge' && this.knowledge) {
            output = await this.knowledge.search(organizationId, agentId, call.arguments?.pergunta);
            actions.push({ tool: call.name, description: b.definition.description, args: call.arguments, simulated: false, result: output });
          } else {
            output = { ok: true, simulado: true };
            actions.push({ tool: call.name, description: b?.definition.description ?? 'ferramenta desconhecida', args: call.arguments, simulated: true });
            if (b?.builtin === 'handoffToAgent' && !handoffTo) {
              handoffTo = await this.prisma.aiAgent.findFirst({ where: { id: String(b.fixedArgs.agentId), organizationId }, select: { id: true, name: true } });
            }
          }
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(output) });
        }
        if (handoffTo) break;
      }
    } catch (error) {
      await this.prisma.aiAgentTestUsage.update({ where: { id: usage.id }, data: { status: 'FAILED', inputTokens: tokens.input, outputTokens: tokens.output, costUsd: tokens.cost } });
      throw error;
    }
    await this.prisma.aiAgentTestUsage.update({ where: { id: usage.id }, data: {
      status: 'COMPLETED', inputTokens: tokens.input, outputTokens: tokens.output, costUsd: tokens.cost,
    } });

    return {
      agent: { id: agent.id, name: agent.name },
      source: useDraft && agent.draftRevision ? 'rascunho' : 'publicado',
      reply: reply.trim(),
      actions,
      handoffTo,
      invalidMentions: compiled.invalid.map(m => m.label),
      ms: Date.now() - started,
      tokens: { input: tokens.input, output: tokens.output },
    };
  }
}

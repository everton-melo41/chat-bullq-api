import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm.types';
import { MentionsService } from './mentions.service';

export interface TestChatTurn { role: 'user' | 'assistant'; content: string }

/**
 * Chat de teste do estúdio. Usa o prompt (rascunho ou publicado) com as
 * menções compiladas e o modelo do agente, mas NÃO executa nenhuma ação:
 * as ferramentas que o agente chamaria voltam como "simuladas". Nada é
 * gravado nem enviado a cliente. O histórico vem do navegador (sem estado).
 */
@Injectable()
export class AgentTestChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly mentions: MentionsService,
  ) {}

  async run(organizationId: string, agentId: string, history: TestChatTurn[], useDraft: boolean) {
    if (!Array.isArray(history) || !history.length) throw new BadRequestException('Envie ao menos uma mensagem');
    if (history.length > 100) throw new BadRequestException('Limite de 50 turnos por teste. Reinicie a conversa.');
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

    const started = Date.now();
    const res = await this.llm.complete({
      modelId: String(snap.modelId ?? agent.modelId),
      messages,
      tools: compiled.bindings.map(b => b.definition),
      maxTokens: Math.min(Number(snap.maxTokens ?? 1024), 2048),
      temperature: Number(snap.temperature ?? 0.7),
    });

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

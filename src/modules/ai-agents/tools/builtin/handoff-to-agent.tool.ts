import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

export const MAX_HANDOFF_DEPTH = 3;
export function handoffLimit(history: { fromAgentId: string | null; toAgentId: string }[], from: string, to: string, depth = 0): string | null {
  if (depth >= MAX_HANDOFF_DEPTH) return 'Profundidade máxima da cadeia por mensagem atingida';
  if (history.length >= 5) return 'Limite de 5 transferências em 30 minutos atingido';
  const chain = [...history, { fromAgentId: from, toAgentId: to }];
  let returns = 0;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    if (a.fromAgentId === b.toAgentId && a.toAgentId === b.fromAgentId &&
      ((a.fromAgentId === from && a.toAgentId === to) || (a.fromAgentId === to && a.toAgentId === from))) returns++;
  }
  return returns > 1 ? 'Transferências repetidas entre os mesmos agentes (ping-pong)' : null;
}

@Injectable()
export class HandoffToAgentTool implements AiTool {
  readonly name = 'handoffToAgent';
  readonly description = 'Passa a conversa para outro membro do grupo atual. Informe motivo e briefing. O destino inicia imediatamente, ou, se houver pergunta de entrada explícita ou padrão, esta ação envia UMA pergunta e aguarda o cliente. Não use replyToConversation antes do handoff.';
  readonly parameters = { type: 'object', additionalProperties: false, required: ['agentId', 'motivo', 'briefing'], properties: {
    agentId: { type: 'string' }, motivo: { type: 'string', minLength: 1, maxLength: 300 },
    briefing: { type: 'string', minLength: 1, maxLength: 4000 }, entryQuestion: { type: 'string', maxLength: 2000 },
  } };
  constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const fail = (error: string): ToolResult => ({ output: { ok: false, error } });
    if (typeof input.agentId !== 'string' || !input.agentId.trim() || input.agentId === ctx.agentId) return fail('Destino inválido');
    if (typeof input.motivo !== 'string' || !input.motivo.trim() || input.motivo.length > 300 ||
      typeof input.briefing !== 'string' || !input.briefing.trim() || input.briefing.length > 4000 ||
      (input.entryQuestion !== undefined && (typeof input.entryQuestion !== 'string' || input.entryQuestion.length > 2000))) return fail('Motivo, briefing ou pergunta inválidos');
    const targetId = input.agentId;
    const handoffId = createHash('sha256').update(`handoff:${ctx.runId}`).digest('hex');
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${ctx.conversationId} FOR UPDATE`;
      const conv = await tx.conversation.findFirst({ where: { id: ctx.conversationId, organizationId: ctx.organizationId,
        channelId: ctx.channelId, contactId: ctx.contactId, deletedAt: null }, include: { channel: true } });
      if (!conv || conv.aiEnabled === false || (!ctx.viaMention && !conv.channel.aiAgentGroupId)) return { error: 'Conversa sem grupo ou IA pausada' };
      const run = await tx.aiAgentRun.findFirst({ where: { id: ctx.runId, agentId: ctx.agentId, conversationId: ctx.conversationId, organizationId: ctx.organizationId }, include: { revision: true } });
      const enabled = (run?.revision?.snapshot as any)?.enabledBuiltinTools;
      if (!run?.revision || (!ctx.viaMention && enabled != null && !enabled.includes(this.name))) return { error: 'Ação não habilitada na revisão deste run' };
      const previous = await tx.aiAgentHandoff.findUnique({ where: { id: handoffId } });
      if (previous) {
        const message = await tx.message.findUnique({ where: { id: handoffId } });
        return { handoff: previous, message };
      }
      if (conv.activeAgentId !== ctx.agentId) return { error: 'O agente atual mudou' };
      const direct = ctx.viaMention ? await tx.aiAgent.findFirst({ where: { id: String(targetId), organizationId: ctx.organizationId, isActive: true, deletedAt: null, publishedRevisionId: { not: null } }, include: { publishedRevision: true } }) : null;
      if (ctx.viaMention && (!direct?.publishedRevision || direct.id === ctx.agentId)) return { error: 'Agente mencionado inexistente, inativo ou não publicado' };
      const members = ctx.viaMention ? [] as any[] : await tx.aiAgentGroupMember.findMany({ where: { groupId: conv.channel.aiAgentGroupId!,
        group: { organizationId: ctx.organizationId }, agentId: { in: [ctx.agentId, targetId] },
        agent: { organizationId: ctx.organizationId, isActive: true, deletedAt: null, publishedRevisionId: { not: null } } },
        include: { agent: { include: { publishedRevision: true } } } });
      const target = ctx.viaMention ? direct : members.find(m => m.agentId === targetId)?.agent;
      if ((!ctx.viaMention && members.length !== 2) || !target?.publishedRevision) return { error: 'Origem e destino devem ser membros ativos e publicados do mesmo grupo da conversa' };
      const history = await tx.aiAgentHandoff.findMany({ where: { conversationId: ctx.conversationId, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } }, orderBy: { createdAt: 'asc' } });
      const inboundHandoffs = ctx.triggerMessageId ? await tx.aiAgentHandoff.count({
        where: { conversationId: ctx.conversationId, triggerMessageId: ctx.triggerMessageId },
      }) : 0;
      const reason = handoffLimit(history, ctx.agentId, targetId, Math.max(ctx.chainDepth ?? 0, inboundHandoffs));
      if (reason) {
        await tx.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false } });
        await tx.internalNote.create({ data: { conversationId: conv.id, content: `IA pausada para revisão humana: ${reason}.`, generatedByAi: true, agentId: ctx.agentId, agentRunId: ctx.runId } });
        return { paused: reason };
      }
      const entryQuestion = (input.entryQuestion as string | undefined)?.trim() || (target.publishedRevision.snapshot as any).entryQuestion?.trim() || null;
      if (entryQuestion && ctx.alreadyReplied) return { error: 'Uma mensagem já foi enviada neste run. Faça o handoff com pergunta em um novo turno.' };
      const contactChannel = entryQuestion ? await tx.contactChannel.findFirst({ where: { contactId: ctx.contactId, channelId: ctx.channelId } }) : null;
      if (entryQuestion && !contactChannel?.externalId) return { error: 'Contato sem endereço neste canal' };
      const handoff = await tx.aiAgentHandoff.create({ data: { id: handoffId, conversationId: conv.id, fromAgentId: ctx.agentId,
        toAgentId: targetId, reason: input.motivo as string, briefing: input.briefing as string, entryQuestion, triggerMessageId: ctx.triggerMessageId } });
      const message = entryQuestion ? await tx.message.create({ data: { id: handoffId, conversationId: conv.id,
        direction: 'OUTBOUND', type: 'TEXT', content: { text: entryQuestion }, status: 'QUEUED',
        senderName: members.find(m => m.agentId === ctx.agentId)?.agent.name ?? 'AI',
        metadata: { aiAgentId: ctx.agentId, runId: ctx.runId, handoffTransition: true } } }) : null;
      await tx.conversation.update({ where: { id: conv.id }, data: { activeAgentId: targetId, ...(message ? { lastMessageAt: new Date() } : {}) } });
      await tx.conversationAuditLog.create({ data: { conversationId: conv.id, action: 'AI_DELEGATED', metadata: { fromAgentId: ctx.agentId, toAgentId: targetId, groupId: conv.channel.aiAgentGroupId, runId: ctx.runId, waitForInbound: !!entryQuestion } } });
      return { handoff, message };
    });
    if ('error' in result) return fail(result.error!);
    if ('paused' in result) {
      this.realtime.emitToConversation(ctx.conversationId, 'note:changed', { conversationId: ctx.conversationId });
      return { output: { ok: false, paused: true, error: result.paused }, finalAction: 'TRANSFERRED_TO_HUMAN' };
    }
    const { handoff, message } = result;
    if (message && ['QUEUED', 'FAILED'].includes(message.status)) {
      const contactChannel = await this.prisma.contactChannel.findFirst({ where: { contactId: ctx.contactId, channelId: ctx.channelId } });
      try {
        await this.outboundQueue.add('send-outbound', { messageId: message.id, channelId: ctx.channelId,
        contactExternalId: contactChannel!.externalId, message: { type: 'TEXT', content: message.content } },
        { jobId: `handoff-${handoff.id}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86400 }, removeOnFail: false });
      } catch {
        // A troca já foi persistida. Não deixe o agente anterior responder após
        // falha no enqueue, nem inicie o destino antes de a pergunta chegar.
        await this.prisma.$transaction(async tx => {
          await tx.conversation.update({ where: { id: ctx.conversationId }, data: { aiEnabled: false } });
          await tx.internalNote.create({ data: { conversationId: ctx.conversationId,
            content: 'IA pausada: não foi possível confirmar o envio da pergunta de entrada. Verifique a mensagem e a fila antes de retomar.',
            generatedByAi: true, agentId: ctx.agentId, agentRunId: ctx.runId } });
        });
        this.realtime.emitToConversation(ctx.conversationId, 'note:changed', { conversationId: ctx.conversationId });
        return { output: { ok: false, paused: true, error: 'Falha ao enfileirar pergunta de entrada' }, finalAction: 'TRANSFERRED_TO_HUMAN' };
      }
      this.realtime.emitToChannel(ctx.channelId, 'message:new', { message, conversationId: ctx.conversationId, contactId: ctx.contactId });
      this.realtime.emitToConversation(ctx.conversationId, 'message:new', { message });
    }
    this.realtime.emitToConversation(ctx.conversationId, 'conversation:ai-delegated', { conversationId: ctx.conversationId, toAgentId: handoff.toAgentId });
    return { output: { ok: true, waitForInbound: !!handoff.entryQuestion, delegatedTo: { agentId: handoff.toAgentId } }, finalAction: 'DELEGATED' };
  }
}

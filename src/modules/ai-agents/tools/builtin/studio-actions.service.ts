import { TagConversationTool } from './tag-conversation.tool';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AutomationTrigger, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../../database/prisma.service';
import { ChannelAccessService } from '../../../iam/channel-access/channel-access.service';
import { OutboxService } from '../../../automations/outbox/outbox.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { PipelinesService } from '../../../pipelines/pipelines.service';
import { ToolContext, ToolResult } from '../tool.types';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === 'object') return JSON.stringify(Object.keys(value).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  return JSON.stringify(value);
}

export function contactFields(input: Record<string, unknown>) {
  const allowed = ['name', 'email', 'cpf', 'dataNascimento', 'cidade', 'uf', 'profissao', 'beneficioPretendido', 'observacoes'];
  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.includes(key) || typeof raw !== 'string') throw new BadRequestException('Campo inválido: ' + key);
    const value = raw.trim();
    if (key === 'name' && !value) continue;
    if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new BadRequestException('E-mail inválido');
    if (key === 'dataNascimento' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value > new Date().toISOString().slice(0, 10))) throw new BadRequestException('Data inválida; use YYYY-MM-DD');
    if (key === 'cpf') {
      if (!/^[\d.\-\s]+$/.test(value)) throw new BadRequestException('CPF inválido');
      const cpf = value.replace(/\D/g, '');
      const valid = /^\d{11}$/.test(cpf) && !/^(\d)\1{10}$/.test(cpf) && [9, 10].every(n => {
        const sum = [...cpf.slice(0, n)].reduce((total, digit, i) => total + Number(digit) * (n + 1 - i), 0);
        return ((sum * 10) % 11) % 10 === Number(cpf[n]);
      });
      if (!valid) throw new BadRequestException('CPF inválido');
      fields[key] = cpf;
    } else fields[key] = key === 'email' ? value.toLowerCase() : value;
  }
  return fields;
}

@Injectable()
export class StudioActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeGateway,
    private readonly pipelines: PipelinesService,
    private readonly tags: TagConversationTool,
  ) {}

  async assertContext(ctx: ToolContext) {
    const run = await this.prisma.aiAgentRun.findFirst({ where: {
      id: ctx.runId, agentId: ctx.agentId, organizationId: ctx.organizationId,
      conversationId: ctx.conversationId,
      agent: { organizationId: ctx.organizationId, isActive: true, deletedAt: null },
    } });
    const conversation = await this.prisma.conversation.findFirst({ where: {
      id: ctx.conversationId, organizationId: ctx.organizationId, channelId: ctx.channelId,
      contactId: ctx.contactId, deletedAt: null,
      channel: { organizationId: ctx.organizationId, deletedAt: null },
      contact: { organizationId: ctx.organizationId, deletedAt: null },
    } });
    if (!run || !conversation) throw new ForbiddenException('Contexto da ação inválido');
    return conversation;
  }

  async assertApprover(ctx: ToolContext, userId: string) {
    const eligible = await this.access.listEligibleAgents(ctx.organizationId, ctx.channelId);
    if (!eligible.some(user => user.id === userId)) throw new ForbiddenException('Aprovador sem acesso ao canal');
  }

  async execute(action: string, input: Record<string, unknown>, ctx: ToolContext, approvedBy?: string): Promise<ToolResult> {
    await this.assertContext(ctx);
    const id = createHash('sha256').update(canonical([ctx.runId, action, input])).digest('hex');
    const events: Array<() => void> = [];
    const result = await this.prisma.$transaction(async tx => {
      // Serialize all writes for this conversation, including simultaneous retries.
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${ctx.conversationId} FOR UPDATE`;
      const receipt = await tx.aiActionReceipt.findUnique({ where: { id } });
      if (receipt) return receipt.result;
      const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } });
      let output: Record<string, unknown> = { ok: true };
      const note = async (content: unknown) => {
        if (typeof content !== 'string' || !content.trim() || content.length > 10000) throw new BadRequestException('Conteúdo da nota inválido');
        const row = await tx.internalNote.create({ data: {
          conversationId: ctx.conversationId, content: content.trim(),
          authorId: approvedBy ?? null, agentId: ctx.agentId, agentRunId: ctx.runId, generatedByAi: true,
        } });
        events.push(() => this.realtime.emitToConversation(ctx.conversationId, 'note:changed', { conversationId: ctx.conversationId, noteId: row.id }));
        return row.id;
      };
      if (action === 'addTag') {
        const result = await this.tags.execute({ ...input, existingOnly: true }, ctx, tx);
        output = result.output as Record<string, unknown>;
        if (output.ok === false) throw new BadRequestException(String(output.error));
      } else if (action === 'createInternalSummary') {
        output.noteId = await note(input.content);
      } else if (action === 'updateContactFields') {
        if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) throw new BadRequestException('fields obrigatório');
        const fields = contactFields(input.fields as Record<string, unknown>);
        // Contacts can be shared by conversations on different channels.
        await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${ctx.contactId} FOR UPDATE`;
        const contact = await tx.contact.findUniqueOrThrow({ where: { id: ctx.contactId } });
        const { name, email, ...extra } = fields;
        await tx.contact.update({ where: { id: ctx.contactId }, data: {
          ...(name ? { name } : {}), ...(email ? { email } : {}),
          metadata: { ...(contact.metadata as Prisma.JsonObject), ...extra },
        } });
        await tx.conversationAuditLog.create({ data: {
          conversationId: ctx.conversationId, action: 'CONTACT_UPDATED_BY_AI',
          metadata: { agentId: ctx.agentId, agentRunId: ctx.runId, contactId: ctx.contactId,
            before: { name: contact.name, email: contact.email, metadata: contact.metadata }, fields },
        } });
      } else if (action === 'movePipelineCard') {
        const pipelineId = String(input.pipelineId ?? '');
        const stageId = String(input.stageId ?? '');
        const stage = await tx.pipelineStage.findFirst({ where: { id: stageId, pipelineId, pipeline: { organizationId: ctx.organizationId } } });
        if (!stage) throw new BadRequestException('Pipeline/etapa inválidos');
        const card = await tx.card.findFirst({ where: { pipelineId, conversationId: ctx.conversationId, organizationId: ctx.organizationId } });
        const moved = card
          ? card.stageId === stageId ? card : await this.pipelines.moveCard(card.id, ctx.organizationId, { toStageId: stageId, toIndex: 0 }, tx, events)
          : await this.pipelines.createCard(pipelineId, ctx.organizationId, { stageId, conversationId: ctx.conversationId }, tx, events);
        output.cardId = moved?.id;
      } else if (action === 'assignConversation' || action === 'transferToHuman') {
        if (input.userId && input.departmentId) throw new BadRequestException('Escolha usuário OU departamento');
        if (action === 'assignConversation' && !input.userId && !input.departmentId) throw new BadRequestException('Destino obrigatório');
        let assignedToId = input.departmentId ? null : input.userId ? String(input.userId) : conversation.assignedToId;
        let departmentId = input.userId ? null : input.departmentId ? String(input.departmentId) : conversation.departmentId;
        if (assignedToId) {
          const eligible = await this.access.listEligibleAgents(ctx.organizationId, ctx.channelId);
          if (!eligible.some(user => user.id === assignedToId)) {
            if (input.userId) throw new ForbiddenException('Usuário sem acesso ao canal');
            assignedToId = null;
          }
        }
        if (departmentId) {
          const department = await tx.department.findFirst({ where: {
            id: departmentId, organizationId: ctx.organizationId, deletedAt: null,
            OR: [{ channelId: null }, { channelId: ctx.channelId }],
          } });
          if (!department) {
            if (input.departmentId) throw new ForbiddenException('Departamento fora do canal');
            departmentId = null;
          }
        }
        const status = assignedToId ? 'OPEN' : 'PENDING';
        const updated = await tx.conversation.update({ where: { id: ctx.conversationId }, data: {
          assignedToId, departmentId, status,
          ...(conversation.status === 'CLOSED' ? { closedAt: null, reopenedAt: new Date(), reopenedCount: { increment: 1 } } : {}),
          ...(action === 'transferToHuman' ? { aiEnabled: false, activeAgentId: null, aiDisabledAt: new Date(), aiDisabledBy: approvedBy ?? ctx.agentId } : {}),
        } });
        const base = { organizationId: ctx.organizationId, conversationId: ctx.conversationId, contactId: ctx.contactId, channelId: ctx.channelId, actorId: approvedBy ?? ctx.agentId };
        if (assignedToId !== conversation.assignedToId || departmentId !== conversation.departmentId) {
          await this.outbox.enqueue(tx, AutomationTrigger.CONVERSATION_ASSIGNED, { ...base, fromAssigneeId: conversation.assignedToId, toAssigneeId: assignedToId, departmentId });
          await tx.conversationAuditLog.create({ data: { conversationId: ctx.conversationId, action: 'ASSIGNED', actorId: approvedBy, fromValue: conversation.assignedToId, toValue: assignedToId, metadata: { agentId: ctx.agentId, agentRunId: ctx.runId, departmentId } } });
          events.push(() => this.broadcast(ctx, 'conversation:assigned', { conversationId: ctx.conversationId, assigneeId: assignedToId, departmentId }));
        }
        if (status !== conversation.status) {
          await this.outbox.enqueue(tx, AutomationTrigger.CONVERSATION_STATUS_CHANGED, { ...base, fromStatus: conversation.status, toStatus: status });
          await tx.conversationAuditLog.create({ data: { conversationId: ctx.conversationId, action: 'STATUS_CHANGED', actorId: approvedBy, fromValue: conversation.status, toValue: status, metadata: { agentId: ctx.agentId, agentRunId: ctx.runId } } });
        }
        if (action === 'transferToHuman') {
          if (typeof input.reason !== 'string' || input.reason.trim().length < 3) throw new BadRequestException('Motivo obrigatório');
          output.noteId = await note([input.reason, input.summary].filter(Boolean).join('\n\n'));
        }
        events.push(() => this.broadcast(ctx, 'conversation:updated', { conversation: updated }));
      } else throw new BadRequestException('Ação desconhecida');
      await tx.aiActionReceipt.create({ data: { id, agentRunId: ctx.runId, action, result: output as Prisma.InputJsonValue } });
      return output;
    });
    events.forEach(emit => emit());
    return { output: result, ...(action === 'transferToHuman' ? { finalAction: 'TRANSFERRED_TO_HUMAN' as const } : {}) };
  }

  private broadcast(ctx: ToolContext, event: string, payload: unknown) {
    this.realtime.emitToConversation(ctx.conversationId, event, payload);
    this.realtime.emitToChannel(ctx.channelId, event, payload);
  }
}

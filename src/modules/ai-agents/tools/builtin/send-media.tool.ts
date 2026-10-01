import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MessageContentType, MessageDirection, MessageStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Envia uma mídia da biblioteca (vídeo, imagem, áudio, documento) ao lead.
 * Só é exposta via menção @[Nome](media:id): o id vem fixo da compilação.
 * Idempotente por run + mídia, para um retry não mandar o arquivo duas vezes.
 */
@Injectable()
export class SendMediaTool implements AiTool {
  readonly name = 'sendMedia';
  readonly description = 'Envia ao lead uma mídia da biblioteca do escritório.';
  readonly parameters = { type: 'object', additionalProperties: false, required: ['mediaId'], properties: { mediaId: { type: 'string' }, legenda: { type: 'string', maxLength: 1000 } } };

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const media = await this.prisma.agentMedia.findFirst({ where: { id: String(input.mediaId), organizationId: ctx.organizationId } });
    if (!media) return { output: { ok: false, error: 'Mídia não encontrada na biblioteca' } };
    const contactChannel = await this.prisma.contactChannel.findFirst({ where: { contactId: ctx.contactId, channelId: ctx.channelId } });
    if (!contactChannel?.externalId) return { output: { ok: false, error: 'Contato sem endereço neste número' } };

    const id = createHash('sha256').update(`media:${ctx.runId}:${media.id}`).digest('hex').slice(0, 25);
    const existing = await this.prisma.message.findUnique({ where: { id } });
    const jobId = `agent-media-${id}`;
    if (existing) {
      if (existing.status === MessageStatus.QUEUED && !await this.outboundQueue.getJob(jobId)) {
        await this.outboundQueue.add('send-outbound', {
          messageId: id, channelId: ctx.channelId, contactExternalId: contactChannel.externalId,
          message: { type: existing.type, content: existing.content },
        }, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: false });
      }
      return { output: { ok: existing.status !== MessageStatus.FAILED, messageId: id,
        alreadySent: [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ].includes(existing.status as any),
        status: existing.status } };
    }

    const type = MessageContentType[media.kind as keyof typeof MessageContentType] ?? MessageContentType.DOCUMENT;
    const caption = String(input.legenda ?? '').trim() || media.caption || undefined;
    const content = { mediaUrl: media.url, mimeType: media.mimeType, fileName: media.fileName, ...(caption && type !== MessageContentType.AUDIO ? { caption } : {}) };
    const agent = await this.prisma.aiAgent.findUnique({ where: { id: ctx.agentId }, select: { name: true } });

    const message = await this.prisma.message.create({
      data: {
        id, conversationId: ctx.conversationId, direction: MessageDirection.OUTBOUND, type, content,
        status: MessageStatus.QUEUED, senderName: agent?.name ?? 'AI', metadata: { aiAgentId: ctx.agentId, runId: ctx.runId, agentMediaId: media.id },
      },
    });
    await this.prisma.conversation.update({ where: { id: ctx.conversationId }, data: { lastMessageAt: new Date() } });
    this.realtime.emitToChannel(ctx.channelId, 'message:new', { message, conversationId: ctx.conversationId, contactId: ctx.contactId });
    this.realtime.emitToConversation(ctx.conversationId, 'message:new', { message });
    await this.outboundQueue.add('send-outbound', {
      messageId: message.id, channelId: ctx.channelId, contactExternalId: contactChannel.externalId, message: { type, content },
    }, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: false });

    return { output: { ok: true, messageId: message.id, enviado: media.name } };
  }
}

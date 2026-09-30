import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrgRole } from '@prisma/client';
import { CurrentOrg, Roles } from '../../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { PrismaService } from '../../../database/prisma.service';
import { UploadsService } from '../../messaging/messages/uploads.service';

function kindOf(mime: string): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}

/**
 * Biblioteca de mídias dos agentes: vídeos, imagens, áudios e documentos que
 * um agente envia quando o prompt cita @[Nome](media:id).
 */
@Controller('ai-agents/media')
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
export class AgentMediaController {
  constructor(private readonly prisma: PrismaService, private readonly uploads: UploadsService) {}

  @Get()
  list(@CurrentOrg('id') organizationId: string) {
    return this.prisma.agentMedia.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' } });
  }

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UploadsService.MAX_MEDIA_BYTES } }))
  async upload(
    @CurrentOrg('id') organizationId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname?: string } | undefined,
    @Body() body: { name?: string; caption?: string },
  ) {
    if (!file) throw new BadRequestException('Envie um arquivo.');
    const name = String(body?.name ?? '').trim() || (file.originalname ?? 'arquivo').replace(/\.[^.]+$/, '');
    if (name.length > 80) throw new BadRequestException('O nome pode ter no máximo 80 caracteres.');
    if (await this.prisma.agentMedia.findFirst({ where: { organizationId, name } })) {
      throw new BadRequestException(`Já existe uma mídia chamada "${name}". Use outro nome.`);
    }
    const saved = await this.uploads.saveMedia(file);
    return this.prisma.agentMedia.create({
      data: {
        organizationId, name, kind: kindOf(saved.mimeType), url: saved.url, mimeType: saved.mimeType,
        fileName: saved.filename, size: saved.size, caption: String(body?.caption ?? '').trim().slice(0, 1000) || null,
      },
    });
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  async remove(@CurrentOrg('id') organizationId: string, @Param('id') id: string) {
    const { count } = await this.prisma.agentMedia.deleteMany({ where: { id, organizationId } });
    if (!count) throw new NotFoundException('Mídia não encontrada');
    return { deleted: true };
  }
}

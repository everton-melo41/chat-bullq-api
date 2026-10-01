import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrgRole, KnowledgeSourceType } from '@prisma/client';
import { CurrentOrg, Roles } from '../../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { KnowledgeService } from './knowledge.service';
import pdfParse = require('pdf-parse/lib/pdf-parse.js');

@Controller('ai-agents')
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}
  @Get('knowledge') list(@CurrentOrg('id') org: string) { return this.knowledge.list(org); }
  @Post('knowledge')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  async create(@CurrentOrg('id') org: string, @Body() body: { title?: unknown; content?: unknown }, @UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    if (!file) return this.knowledge.create(org, body?.title, body?.content);
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    const type: KnowledgeSourceType | undefined = ext === 'md' ? 'MARKDOWN' : ext === 'txt' ? 'TEXT' : ext === 'pdf' ? 'PDF' : undefined;
    if (!type) throw new BadRequestException('Envie Markdown (.md), TXT ou PDF.');
    let content: string;
    try { content = type === 'PDF' ? (await pdfParse(file.buffer)).text : new TextDecoder('utf-8', { fatal: true }).decode(file.buffer); }
    catch { throw new BadRequestException('Não foi possível extrair texto do arquivo. Use PDF com texto selecionável ou UTF-8.'); }
    return this.knowledge.create(org, body?.title, content, type, file.originalname);
  }
  @Put('knowledge/:id') @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  update(@CurrentOrg('id') org: string, @Param('id') id: string, @Body() body: { title?: unknown; content?: unknown }) { return this.knowledge.update(org, id, body?.title, body?.content); }
  @Delete('knowledge/:id') @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  remove(@CurrentOrg('id') org: string, @Param('id') id: string) { return this.knowledge.remove(org, id); }
  @Get(':id/knowledge') linked(@CurrentOrg('id') org: string, @Param('id') id: string) { return this.knowledge.linked(org, id); }
  @Put(':id/knowledge') @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  link(@CurrentOrg('id') org: string, @Param('id') id: string, @Body() body: { documentIds?: unknown }) { return this.knowledge.link(org, id, body?.documentIds); }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { ToolsCatalogService } from './tools.service';
import { SkillsCatalogService } from './skills.service';
import { UpsertToolDto } from './dto/upsert-tool.dto';
import { UpsertSkillDto } from './dto/upsert-skill.dto';
import { CurrentOrg, CurrentUser, Roles } from '../../../common/decorators';
import {
  JwtAuthGuard,
  OrgGuard,
  RolesGuard,
} from '../../../common/guards';

@ApiTags('AI Catalog (Tools + Skills)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('ai-catalog')
export class AiCatalogController {
  constructor(
    private readonly tools: ToolsCatalogService,
    private readonly skills: SkillsCatalogService,
  ) {}

  // ── Tools ────────────────────────────────────────────────────────

  @Get('tools')
  @ApiOperation({ summary: 'Lista tools (built-in + custom da org)' })
  listTools(@CurrentOrg('id') orgId: string) {
    return this.tools.list(orgId);
  }

  @Get('tools/:id')
  findTool(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.tools.findOne(orgId, id);
  }

  @Post('tools')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Cria tool customizada (HTTP)' })
  createTool(
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpsertToolDto,
  ) {
    return this.tools.create(orgId, dto);
  }

  @Patch('tools/:id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  updateTool(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() dto: UpsertToolDto,
  ) {
    return this.tools.update(orgId, id, dto);
  }

  @Delete('tools/:id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  removeTool(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.tools.softDelete(orgId, id);
  }

  // ── Skills ───────────────────────────────────────────────────────

  @Get('skills')
  @ApiOperation({ summary: 'Lista skills da org' })
  listSkills(@CurrentOrg('id') orgId: string) {
    return this.skills.list(orgId);
  }

  @Get('skills/:id')
  findSkill(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.skills.findOne(orgId, id);
  }

  @Get('skills/:id/versions')
  @ApiOperation({ summary: 'Histórico de versões da skill' })
  listSkillVersions(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
  ) {
    return this.skills.listVersions(orgId, id);
  }

  @Post('skills')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  createSkill(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpsertSkillDto,
  ) {
    return this.skills.create(orgId, dto, userId);
  }

  @Patch('skills/:id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  updateSkill(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpsertSkillDto,
  ) {
    return this.skills.update(orgId, id, dto, userId);
  }

  @Delete('skills/:id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  removeSkill(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.skills.softDelete(orgId, id);
  }

  // ── Agent ↔ skills/tools ────────────────────────────────────────

  @Put('agents/:agentId/skills')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Substitui o conjunto de skills atribuídas ao agent' })
  setAgentSkills(
    @CurrentOrg('id') orgId: string,
    @Param('agentId') agentId: string,
    @Body() body: { skillIds: string[] },
    @CurrentUser('id') userId: string,
  ) {
    return this.skills.setAgentSkills(orgId, agentId, body.skillIds ?? [], userId);
  }

}

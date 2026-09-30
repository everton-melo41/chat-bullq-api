import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { CurrentOrg, Roles } from '../../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { AgentGroupsService, SaveAgentGroupDto } from './agent-groups.service';

@Controller('ai-agent-groups')
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
export class AgentGroupsController {
  constructor(private readonly service: AgentGroupsService) {}
  @Get()
  list(@CurrentOrg('id') org: string) { return this.service.list(org); }
  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  create(@CurrentOrg('id') org: string, @Body() dto: SaveAgentGroupDto) { return this.service.save(org, dto); }
  @Put(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  update(@CurrentOrg('id') org: string, @Param('id') id: string, @Body() dto: SaveAgentGroupDto) { return this.service.save(org, dto, id); }
  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  remove(@CurrentOrg('id') org: string, @Param('id') id: string) { return this.service.remove(org, id); }
}

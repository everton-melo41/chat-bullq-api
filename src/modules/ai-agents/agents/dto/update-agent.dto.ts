import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CreateAgentDto } from './create-agent.dto';

class AgentSkillBindingDto {
  @IsString() skillId!: string;
  @IsBoolean() requiresApproval!: boolean;
}

export class UpdateAgentDto extends PartialType(CreateAgentDto) {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgentSkillBindingDto)
  skills?: AgentSkillBindingDto[];
}

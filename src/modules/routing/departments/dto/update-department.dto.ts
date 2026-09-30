import { IsString, IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DistributionRule } from '@prisma/client';

export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  channelId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: DistributionRule })
  @IsOptional()
  @IsEnum(DistributionRule)
  distributionRule?: DistributionRule;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

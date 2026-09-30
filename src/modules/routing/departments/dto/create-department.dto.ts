import { IsString, IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DistributionRule } from '@prisma/client';

export class CreateDepartmentDto {
  @IsOptional()
  @IsString()
  channelId?: string | null;

  @ApiProperty()
  @IsString()
  name: string;

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

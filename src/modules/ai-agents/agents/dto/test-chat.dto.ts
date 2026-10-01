import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class TestChatTurnDto {
  @IsIn(['user', 'assistant']) role!: 'user' | 'assistant';
  @IsString() @MaxLength(4000) content!: string;
}
export class TestChatDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => TestChatTurnDto)
  messages!: TestChatTurnDto[];
  @IsOptional() @IsBoolean() useDraft?: boolean;
  @IsOptional() @IsString() @MaxLength(100) sessionId?: string;
}

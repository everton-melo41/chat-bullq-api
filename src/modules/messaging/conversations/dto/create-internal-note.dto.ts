import { IsString, MaxLength, Matches } from 'class-validator';
export class CreateInternalNoteDto {
  @IsString()
  @Matches(/\S/, { message: 'A nota não pode estar vazia' })
  @MaxLength(20000)
  content: string;
}

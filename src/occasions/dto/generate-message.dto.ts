import { IsIn, IsOptional } from 'class-validator';

export class GenerateMessageDto {
  @IsIn(['en', 'hi'])
  language: string;

  @IsOptional()
  @IsIn(['warm', 'playful', 'formal'])
  tone?: string;
}

import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateJournalEntryDto {
  @IsIn(['voice', 'video', 'text'])
  entry_type: string;

  /** R2 object key — required for voice/video, absent for text */
  @IsOptional()
  @IsString()
  media_key?: string;

  /** Required for text entries */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  text_content?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  duration_seconds?: number;

  @IsOptional()
  @IsIn(['happy', 'calm', 'thoughtful', 'missing', 'excited'])
  mood?: string;
}

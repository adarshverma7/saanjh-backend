import {
  IsString,
  IsIn,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsDateString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateEntryDto {
  @IsIn(['voice', 'video', 'text'])
  entry_type: string;

  /** R2 object key returned by POST .../upload-url — required for voice/video */
  @ValidateIf(o => o.entry_type !== 'text')
  @IsString()
  media_key?: string;

  /** Required for voice/video (1–20 s). Omitted for text (stored as NULL). */
  @ValidateIf(o => o.entry_type !== 'text')
  @IsInt()
  @Min(1)
  @Max(20)
  duration_seconds?: number;

  /** Text body — required for text entries, max 2000 chars */
  @ValidateIf(o => o.entry_type === 'text')
  @IsString()
  @MaxLength(2000)
  content?: string;

  @IsOptional()
  @IsIn(['happy', 'calm', 'thoughtful', 'missing', 'excited'])
  mood?: string;

  /** ISO 8601 timestamp. Defaults to server time if omitted. */
  @IsOptional()
  @IsDateString()
  recorded_at?: string;
}

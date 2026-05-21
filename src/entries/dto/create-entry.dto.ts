import {
  IsString,
  IsIn,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsDateString,
} from 'class-validator';

export class CreateEntryDto {
  /** R2 object key returned by POST .../upload-url */
  @IsString()
  media_key: string;

  @IsIn(['voice', 'video'])
  entry_type: string;

  @IsInt()
  @Min(1)
  @Max(20)
  duration_seconds: number;

  @IsOptional()
  @IsIn(['happy', 'calm', 'thoughtful', 'missing', 'excited'])
  mood?: string;

  /** ISO 8601 timestamp. Defaults to server time if omitted. */
  @IsOptional()
  @IsDateString()
  recorded_at?: string;
}

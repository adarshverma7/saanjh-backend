import {
  IsUUID,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsIn,
  IsDateString,
} from 'class-validator';

export class JournalConfirmUploadDto {
  @IsUUID()
  entry_id: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300) // Journal allows up to 5 minutes
  duration_seconds?: number;

  @IsOptional()
  @IsIn(['happy', 'calm', 'thoughtful', 'missing', 'excited'])
  mood?: string;

  @IsOptional()
  @IsDateString()
  recorded_at?: string;
}

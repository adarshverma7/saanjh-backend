import {
  IsUUID,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsIn,
  IsDateString,
} from 'class-validator';

export class ConfirmUploadDto {
  @IsUUID()
  entry_id: string;

  @IsInt()
  @Min(1)
  @Max(20)
  duration_seconds: number;

  @IsOptional()
  @IsIn(['happy', 'calm', 'thoughtful', 'missing', 'excited'])
  mood?: string;

  @IsOptional()
  @IsDateString()
  recorded_at?: string;
}

import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ConfirmStoryDto {
  @IsUUID()
  story_id: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;

  /** Playback length for video/audio stories. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  duration_seconds?: number;
}

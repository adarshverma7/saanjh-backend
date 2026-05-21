import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class JournalUploadUrlDto {
  @IsIn(['voice', 'video'])
  entry_type: string;

  @IsIn(['m4a', 'mp4'])
  file_extension: string;

  /**
   * No 20-second limit here — personal journal allows longer recordings
   * (max 5 minutes = 300 s, unlike the shared diary's 20 s cap).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  duration_seconds?: number;
}

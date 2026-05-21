import { IsIn, IsInt, Max, Min } from 'class-validator';

export class UploadUrlDto {
  @IsIn(['voice', 'video'])
  entry_type: string;

  @IsIn(['m4a', 'mp4'])
  file_extension: string;

  /** Max 20 seconds per the Saanjh product constraint */
  @IsInt()
  @Min(1)
  @Max(20)
  duration_seconds: number;

  /** 1 KB minimum, 10 MB maximum */
  @IsInt()
  @Min(1_000)
  @Max(10_000_000)
  file_size_bytes: number;
}

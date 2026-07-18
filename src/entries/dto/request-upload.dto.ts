import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestUploadDto {
  @IsIn(['voice', 'video'])
  entry_type: string;

  /** Client-generated idempotency key. Reused across retries to dedup uploads. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  client_msg_id?: string;
}

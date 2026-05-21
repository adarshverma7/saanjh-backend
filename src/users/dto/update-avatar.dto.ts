import { IsString } from 'class-validator';

export class UpdateAvatarDto {
  /** R2 object key returned by POST /onboarding/avatar/upload-url */
  @IsString()
  avatar_key: string;
}

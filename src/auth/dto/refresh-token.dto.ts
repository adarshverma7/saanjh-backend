import { IsString } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  refresh_token: string;

  @IsString()
  device_id: string;
}

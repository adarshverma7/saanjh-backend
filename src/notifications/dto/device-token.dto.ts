import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class DeviceTokenDto {
  @IsString()
  @IsNotEmpty()
  device_id: string;

  @IsString()
  @IsNotEmpty()
  fcm_token: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  app_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  platform?: string;
}

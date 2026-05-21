import {
  IsString,
  Matches,
  Length,
  IsOptional,
  IsIn,
} from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+91[6-9]\d{9}$/, {
    message: 'Phone must be a valid Indian mobile number in E.164 format',
  })
  phone: string;

  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'OTP must contain only digits' })
  otp: string;

  // Device info — required for session management
  @IsString()
  device_id: string;

  @IsOptional()
  @IsIn(['android', 'ios'])
  device_type?: string;

  @IsOptional()
  @IsString()
  app_version?: string;

  @IsOptional()
  @IsString()
  fcm_token?: string;
}

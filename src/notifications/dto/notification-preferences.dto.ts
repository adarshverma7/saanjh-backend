import { IsOptional, IsBoolean, IsString, Matches } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  new_entry?: boolean;

  @IsOptional()
  @IsBoolean()
  flicker_received?: boolean;

  @IsOptional()
  @IsBoolean()
  streak_reminder?: boolean;

  @IsOptional()
  @IsBoolean()
  occasion_reminders?: boolean;

  @IsOptional()
  @IsBoolean()
  morning_ritual?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  quiet_hours_start?: string;   // 'HH:MM' in IST

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  quiet_hours_end?: string;     // 'HH:MM' in IST
}

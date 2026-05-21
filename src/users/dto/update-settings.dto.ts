import {
  IsOptional,
  IsString,
  IsIn,
  IsBoolean,
  Matches,
} from 'class-validator';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class UpdateSettingsDto {
  // ── User fields ────────────────────────────────────────────────────────────
  @IsOptional()
  @IsIn(['en', 'hi'])
  language?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  // ── Notification preferences ───────────────────────────────────────────────
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
  @Matches(TIME_REGEX, { message: 'streak_reminder_time must be HH:MM' })
  streak_reminder_time?: string;

  @IsOptional()
  @IsBoolean()
  occasion_reminders?: boolean;

  @IsOptional()
  @IsBoolean()
  morning_ritual?: boolean;

  @IsOptional()
  @Matches(TIME_REGEX, { message: 'morning_ritual_time must be HH:MM' })
  morning_ritual_time?: string;

  @IsOptional()
  @Matches(TIME_REGEX, { message: 'quiet_hours_start must be HH:MM' })
  quiet_hours_start?: string;

  @IsOptional()
  @Matches(TIME_REGEX, { message: 'quiet_hours_end must be HH:MM' })
  quiet_hours_end?: string;
}

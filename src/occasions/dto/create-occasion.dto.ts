import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  IsDateString,
  IsBoolean,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export class CreateOccasionDto {
  @IsIn(['birthday', 'anniversary', 'diwali', 'eid', 'holi', 'raksha_bandhan', 'custom'])
  occasion_type: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  occasion_name?: string;

  @IsDateString()
  occasion_date: string;

  @IsBoolean()
  is_recurring: boolean;

  @IsInt()
  @Min(1)
  @Max(30)
  remind_days_before: number;
}

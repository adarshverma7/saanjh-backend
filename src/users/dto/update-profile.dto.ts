import {
  IsOptional,
  IsString,
  MaxLength,
  IsIn,
  IsDateString,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(['en', 'hi'])
  language?: string;

  @IsOptional()
  @IsDateString({}, { message: 'date_of_birth must be a valid date (YYYY-MM-DD)' })
  date_of_birth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;
}

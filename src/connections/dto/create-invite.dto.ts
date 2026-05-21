import {
  IsOptional,
  IsString,
  MaxLength,
  IsIn,
  Matches,
} from 'class-validator';

// E.164 format for Indian mobile numbers
const INDIAN_E164 = /^\+91[6-9]\d{9}$/;

export class CreateInviteDto {
  @IsOptional()
  @Matches(INDIAN_E164, {
    message: 'phone must be a valid Indian mobile number (+91XXXXXXXXXX)',
  })
  phone?: string;

  @IsIn(['parent_child', 'partners', 'siblings', 'friends'])
  relationship_type: string;

  @IsString()
  @MaxLength(100)
  connection_name: string;
}

import { IsString, Length, MaxLength } from 'class-validator';

export class AcceptInviteDto {
  @IsString()
  @Length(6, 12)
  invite_code: string;

  @IsString()
  @MaxLength(100)
  connection_name: string;
}

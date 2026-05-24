import { IsString, MaxLength, IsIn, Matches } from 'class-validator';

const E164 = /^\+[1-9]\d{6,14}$/;

export class ConnectDirectDto {
  @Matches(E164, { message: 'phone must be a valid E.164 number' })
  phone: string;

  @IsString()
  @MaxLength(100)
  connection_name: string;

  @IsIn(['parent_child', 'partners', 'siblings', 'friends'])
  relationship_type: string;
}

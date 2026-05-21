import { IsUUID, IsDateString } from 'class-validator';

export class PreviewBookDto {
  @IsUUID()
  connection_id: string;

  @IsDateString()
  date_from: string;

  @IsDateString()
  date_to: string;
}

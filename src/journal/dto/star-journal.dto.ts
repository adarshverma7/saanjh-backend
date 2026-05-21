import { IsBoolean } from 'class-validator';

export class StarJournalDto {
  @IsBoolean()
  is_starred: boolean;
}

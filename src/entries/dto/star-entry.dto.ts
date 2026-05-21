import { IsBoolean } from 'class-validator';

export class StarEntryDto {
  @IsBoolean()
  is_starred: boolean;
}

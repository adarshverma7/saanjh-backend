import { IsIn } from 'class-validator';

export class RequestUploadDto {
  @IsIn(['voice', 'video'])
  entry_type: string;
}

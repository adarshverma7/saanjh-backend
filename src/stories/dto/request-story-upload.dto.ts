import { IsIn } from 'class-validator';

export class RequestStoryUploadDto {
  @IsIn(['photo', 'video', 'audio'])
  media_type: string;
}

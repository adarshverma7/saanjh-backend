import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class ReactionDto {
  /** A single emoji grapheme (or short emoji sequence). */
  @IsString()
  @Length(1, 16)
  emoji: string;
}

export class PinEntryDto {
  @IsBoolean()
  is_pinned: boolean;
}

export class CaptionDto {
  /** Caption text; null/empty clears it. Media itself is never editable. */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string | null;
}

export class ForwardEntryDto {
  @IsUUID()
  to_connection_id: string;
}

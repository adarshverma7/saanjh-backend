import {
  IsUUID,
  IsIn,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ShippingAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  line1: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  pincode: string;
}

export class GiftRecipientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(15)
  phone: string;
}

export class CreateOrderDto {
  @IsUUID()
  connection_id: string;

  @IsIn(['self', 'gift'])
  order_type: string;

  @IsDateString()
  date_from: string;

  @IsDateString()
  date_to: string;

  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shipping_address: ShippingAddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => GiftRecipientDto)
  gift_recipient?: GiftRecipientDto;
}

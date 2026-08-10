import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** 1-based part number. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  part_number: number;

  /**
   * ETag returned by the storage for the uploaded part.
   * @example "\"9b2cf535f27731c974343645a3985328\""
   */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Uploaded parts with their ETags, as collected from each part PUT response. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}

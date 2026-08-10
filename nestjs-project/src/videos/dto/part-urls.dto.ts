import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_PART_URLS_BATCH_LIMIT } from '../videos.constants';

export class PartUrlsDto {
  /**
   * Part numbers to presign (1-based, max 100 per request).
   * @example [1, 2, 3]
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(VIDEO_PART_URLS_BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}

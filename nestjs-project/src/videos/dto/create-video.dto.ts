import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  VIDEO_ALLOWED_CONTENT_TYPES,
  VIDEO_ALLOWED_EXTENSIONS_PATTERN,
  VIDEO_MAX_FILE_SIZE_BYTES,
} from '../videos.constants';

export class CreateVideoDto {
  /** Video title. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  /** Optional video description. */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  /**
   * Original file name; the extension must be .mp4, .webm, .mov or .mkv.
   * @example "my-video.mp4"
   */
  @IsString()
  @MaxLength(255)
  @Matches(VIDEO_ALLOWED_EXTENSIONS_PATTERN, {
    message: 'file_name must end with .mp4, .webm, .mov or .mkv',
  })
  file_name: string;

  /**
   * File size in bytes (max 10 GiB).
   * @example 1048576
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_FILE_SIZE_BYTES)
  file_size: number;

  /**
   * Video MIME type.
   * @example "video/mp4"
   */
  @IsIn(VIDEO_ALLOWED_CONTENT_TYPES)
  content_type: string;
}

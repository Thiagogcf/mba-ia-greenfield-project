import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import { VideosService, PresignedPartUrl } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft in the current user channel and opens a direct-to-storage multipart upload session. The file bytes never pass through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft video created and upload session opened',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft'] },
        upload: {
          type: 'object',
          properties: {
            part_size: { type: 'number' },
            part_count: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (size/type/extension limits included)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<{
    id: string;
    public_id: string;
    title: string;
    status: string;
    upload: { part_size: number; part_count: number };
  }> {
    const { video, part_size, part_count } =
      await this.videosService.initiateUpload(user.sub, dto);
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      upload: { part_size, part_count },
    };
  }

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Presign upload part URLs',
    description:
      'Returns presigned URLs for the requested part numbers. The client PUTs each part directly to the object storage and collects the ETag response headers.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs generated',
    schema: {
      properties: {
        urls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'number' },
              url: { type: 'string' },
              expires_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part numbers out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for the current user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is not active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async partUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PartUrlsDto,
  ): Promise<{ urls: PresignedPartUrl[] }> {
    return { urls: await this.videosService.getPartUrls(id, user.sub, dto) };
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload on the object storage with the collected part ETags, transitions the video to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or uploaded parts mismatch',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for the current user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is not active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; public_id: string; status: string }> {
    const video = await this.videosService.completeUpload(id, user.sub, dto);
    return { id: video.id, public_id: video.public_id, status: video.status };
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload session on the object storage and deletes the draft video (undoes the pre-registration).',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for the current user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is not active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(id, user.sub);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a video (owner view)',
    description:
      'Returns the full video record for the owner, in any status — including processing progress and failure reason.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string', nullable: true },
        status: {
          type: 'string',
          enum: ['draft', 'processing', 'ready', 'failed'],
        },
        duration_seconds: { type: 'number', nullable: true },
        metadata: { type: 'object', nullable: true },
        failure_reason: { type: 'string', nullable: true },
        file_name: { type: 'string' },
        file_size: { type: 'number' },
        content_type: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for the current user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getById(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const video = await this.videosService.getOwnerVideo(id, user.sub);
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      description: video.description,
      status: video.status,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      failure_reason: video.failure_reason,
      file_name: video.file_name,
      file_size: video.file_size,
      content_type: video.content_type,
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video (public)',
    description:
      'Resolves the unique public URL and redirects (302) to a short-lived presigned storage URL. The player follows the redirect and issues Range requests directly against storage, which answers 206 Partial Content — playback never requires the full download.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned streaming URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video does not exist or is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.getStreamRedirect(publicId),
      statusCode: 302,
    };
  }

  @Public()
  @Get(':publicId/thumbnail')
  @Redirect()
  @ApiOperation({
    summary: 'Get a video thumbnail (public)',
    description:
      'Redirects (302) to a short-lived presigned URL of the thumbnail generated by the processing worker.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned thumbnail URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video does not exist or is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.getThumbnailRedirect(publicId),
      statusCode: 302,
    };
  }

  @Get(':publicId/download')
  @Redirect()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Download a video (authenticated)',
    description:
      'Redirects (302) to a short-lived presigned URL with content-disposition attachment carrying the original file name. Any logged-in user may download ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL (Location header)',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video does not exist or is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.getDownloadRedirect(publicId),
      statusCode: 302,
    };
  }
}

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumbersException,
  UploadNotActiveException,
  UploadPartsMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESS_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const S3_PART_MISMATCH_ERRORS = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
];

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: unknown; detail?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('public_id')
  );
}

export interface InitiatedUpload {
  video: Video;
  part_size: number;
  part_count: number;
}

export interface PresignedPartUrl {
  part_number: number;
  url: string;
  expires_at: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiatedUpload> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const extension = extname(dto.file_name).toLowerCase();
    const originalKey = `videos/${id}/original${extension}`;
    const uploadId = await this.storageService.createMultipartUpload(
      originalKey,
      dto.content_type,
    );

    try {
      const video = await this.saveNewVideo({
        id,
        channel_id: channel.id,
        title: dto.title,
        description: dto.description ?? null,
        file_name: dto.file_name,
        content_type: dto.content_type,
        file_size: dto.file_size,
        original_key: originalKey,
        s3_upload_id: uploadId,
      });
      return {
        video,
        part_size: this.config.uploadPartSize,
        part_count: this.partCountFor(video),
      };
    } catch (err) {
      await this.storageService
        .abortMultipartUpload(originalKey, uploadId)
        .catch(() => undefined);
      throw err;
    }
  }

  async getPartUrls(
    id: string,
    userId: string,
    dto: PartUrlsDto,
  ): Promise<PresignedPartUrl[]> {
    const video = await this.findOwnedVideo(id, userId);
    const uploadId = this.ensureUploadActive(video);

    const partCount = this.partCountFor(video);
    if (dto.part_numbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumbersException();
    }

    const expiresAt = new Date(
      Date.now() + this.config.presignPartTtl * 1000,
    ).toISOString();

    return Promise.all(
      dto.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.original_key,
          uploadId,
          partNumber,
        ),
        expires_at: expiresAt,
      })),
    );
  }

  async completeUpload(
    id: string,
    userId: string,
    dto: CompleteUploadDto,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(id, userId);
    const uploadId = this.ensureUploadActive(video);

    try {
      await this.storageService.completeMultipartUpload(
        video.original_key,
        uploadId,
        dto.parts,
      );
    } catch (err) {
      if (err instanceof Error && S3_PART_MISMATCH_ERRORS.includes(err.name)) {
        throw new UploadPartsMismatchException();
      }
      throw err;
    }

    video.status = VideoStatus.PROCESSING;
    video.s3_upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.processingQueue.add(
      VIDEO_PROCESS_JOB,
      { videoId: saved.id },
      VIDEO_PROCESS_JOB_OPTIONS,
    );

    return saved;
  }

  async abortUpload(id: string, userId: string): Promise<void> {
    const video = await this.findOwnedVideo(id, userId);
    const uploadId = this.ensureUploadActive(video);

    await this.storageService.abortMultipartUpload(
      video.original_key,
      uploadId,
    );
    await this.videoRepository.remove(video);
  }

  async getOwnerVideo(id: string, userId: string): Promise<Video> {
    return this.findOwnedVideo(id, userId);
  }

  async getStreamRedirect(publicId: string): Promise<string> {
    const video = await this.findPublicReady(publicId);
    return this.storageService.presignGetObject(
      video.original_key,
      this.config.presignStreamTtl,
    );
  }

  async getThumbnailRedirect(publicId: string): Promise<string> {
    const video = await this.findPublicReady(publicId);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    return this.storageService.presignGetObject(
      video.thumbnail_key,
      this.config.presignStreamTtl,
    );
  }

  async getDownloadRedirect(publicId: string): Promise<string> {
    const video = await this.findPublicReady(publicId);
    const safeFileName = video.file_name.replace(/"/g, '');
    return this.storageService.presignGetObject(
      video.original_key,
      this.config.presignDownloadTtl,
      `attachment; filename="${safeFileName}"`,
    );
  }

  private async findPublicReady(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async saveNewVideo(data: Partial<Video>): Promise<Video> {
    try {
      return await this.videoRepository.save(
        this.videoRepository.create({ ...data, public_id: generatePublicId() }),
      );
    } catch (err) {
      if (isPublicIdCollision(err)) {
        return this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            public_id: generatePublicId(),
          }),
        );
      }
      throw err;
    }
  }

  private partCountFor(video: Video): number {
    return Math.max(
      1,
      Math.ceil(video.file_size / this.config.uploadPartSize),
    );
  }

  private async findOwnedVideo(id: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private ensureUploadActive(video: Video): string {
    if (video.status !== VideoStatus.DRAFT || !video.s3_upload_id) {
      throw new UploadNotActiveException();
    }
    return video.s3_upload_id;
  }
}

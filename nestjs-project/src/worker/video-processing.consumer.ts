import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { extname, join } from 'path';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { FfmpegService, VideoProbeResult } from './ffmpeg.service';

export interface VideoProcessingJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      this.logger.warn(
        `Video ${job.data.videoId} no longer exists — skipping job`,
      );
      return;
    }
    if (video.status === VideoStatus.READY) {
      return;
    }

    const { probe, thumbnail } = await this.extractMedia(video);

    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    await this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    video.status = VideoStatus.READY;
    video.duration_seconds = probe.durationSeconds;
    video.metadata = probe.metadata;
    video.thumbnail_key = thumbnailKey;
    video.failure_reason = null;
    await this.videoRepository.save(video);
    this.logger.log(`Video ${video.id} processed successfully`);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }
    this.logger.error(
      `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
    await this.videoRepository.update(
      { id: job.data.videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: error.message },
    );
  }

  private async extractMedia(
    video: Video,
  ): Promise<{ probe: VideoProbeResult; thumbnail: Buffer }> {
    return this.ffmpegService.withTempDir(async (dir) => {
      const extension = extname(video.original_key) || '.mp4';
      const inputPath = join(dir, `original${extension}`);

      await this.ffmpegService.saveStreamToFile(
        await this.storageService.getObjectStream(video.original_key),
        inputPath,
      );

      const probe = await this.ffmpegService.probe(inputPath);
      const thumbnail = await this.ffmpegService.generateThumbnail(
        inputPath,
        join(dir, 'thumbnail.jpg'),
      );
      return { probe, thumbnail };
    });
  }
}

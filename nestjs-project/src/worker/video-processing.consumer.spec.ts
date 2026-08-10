import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Readable } from 'stream';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingConsumer } from './video-processing.consumer';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'vid-1',
    status: VideoStatus.PROCESSING,
    original_key: 'videos/vid-1/original.mp4',
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    failure_reason: null,
    ...overrides,
  });
}

function makeJob(
  overrides: Partial<Job<{ videoId: string }>> = {},
): Job<{ videoId: string }> {
  return {
    data: { videoId: 'vid-1' },
    attemptsMade: 3,
    opts: { attempts: 3 },
    ...overrides,
  } as Job<{ videoId: string }>;
}

describe('VideoProcessingConsumer', () => {
  let consumer: VideoProcessingConsumer;
  let videoRepository: {
    findOneBy: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let storageService: {
    getObjectStream: jest.Mock;
    putObject: jest.Mock;
  };
  let ffmpegService: {
    withTempDir: jest.Mock;
    saveStreamToFile: jest.Mock;
    probe: jest.Mock;
    generateThumbnail: jest.Mock;
  };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn(),
      save: jest.fn((video: Video) => Promise.resolve(video)),
      update: jest.fn().mockResolvedValue(undefined),
    };
    storageService = {
      getObjectStream: jest.fn().mockResolvedValue(Readable.from(['bytes'])),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpegService = {
      withTempDir: jest.fn((fn: (dir: string) => Promise<unknown>) =>
        fn('/tmp/fake'),
      ),
      saveStreamToFile: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn().mockResolvedValue({
        durationSeconds: 42,
        metadata: { width: 1920, height: 1080, codec: 'h264' },
      }),
      generateThumbnail: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingConsumer,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();

    consumer = module.get(VideoProcessingConsumer);
  });

  describe('process', () => {
    it('skips silently when the video no longer exists', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await consumer.process(makeJob());

      expect(ffmpegService.withTempDir).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('is idempotent for videos already ready', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );

      await consumer.process(makeJob());

      expect(ffmpegService.withTempDir).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('processes the video: metadata, thumbnail upload and ready transition', async () => {
      const video = makeVideo();
      videoRepository.findOneBy.mockResolvedValue(video);

      await consumer.process(makeJob());

      expect(storageService.getObjectStream).toHaveBeenCalledWith(
        'videos/vid-1/original.mp4',
      );
      expect(storageService.putObject).toHaveBeenCalledWith(
        'videos/vid-1/thumbnail.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe(VideoStatus.READY);
      expect(saved.duration_seconds).toBe(42);
      expect(saved.metadata).toEqual({
        width: 1920,
        height: 1080,
        codec: 'h264',
      });
      expect(saved.thumbnail_key).toBe('videos/vid-1/thumbnail.jpg');
    });
  });

  describe('onFailed', () => {
    it('does nothing while retries remain', async () => {
      await consumer.onFailed(
        makeJob({ attemptsMade: 1 }),
        new Error('transient'),
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('persists terminal failure with the reason on the final attempt', async () => {
      await consumer.onFailed(makeJob(), new Error('object missing'));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'vid-1', status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, failure_reason: 'object missing' },
      );
    });
  });
});

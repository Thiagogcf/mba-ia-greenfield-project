import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidPartNumbersException,
  UploadNotActiveException,
  UploadPartsMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import { VideosService } from './videos.service';

const PART_SIZE = 104857600;

function makeChannel(userId = 'user-1'): Channel {
  const channel = new Channel();
  channel.id = 'chan-1';
  channel.user_id = userId;
  return channel;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'vid-1',
    channel_id: 'chan-1',
    title: 'Video',
    description: null,
    status: VideoStatus.DRAFT,
    public_id: 'publicid001',
    file_name: 'video.mp4',
    content_type: 'video/mp4',
    file_size: 1024,
    original_key: 'videos/vid-1/original.mp4',
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    failure_reason: null,
    s3_upload_id: 'upload-1',
    created_at: new Date(),
    updated_at: new Date(),
    channel: makeChannel(),
    ...overrides,
  });
}

function makePublicIdCollisionError(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = 'Key (public_id)=(abc) already exists.';
  return err as QueryFailedError;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    remove: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((data: Partial<Video>) =>
        Object.assign(new Video(), data),
      ),
      save: jest.fn((video: Video) => Promise.resolve(video)),
      findOne: jest.fn(),
      remove: jest.fn(),
    };
    channelsService = { findByUserId: jest.fn() };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest.fn().mockResolvedValue('http://presigned-url'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: queue,
        },
        { provide: storageConfig.KEY, useValue: storageConfig() },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    const dto = {
      title: 'My video',
      file_name: 'movie.mp4',
      file_size: PART_SIZE * 2 + 1,
      content_type: 'video/mp4',
    };

    it('creates a draft with derived key, upload session and part math', async () => {
      channelsService.findByUserId.mockResolvedValue(makeChannel());

      const result = await service.initiateUpload('user-1', dto as any);

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/[0-9a-f-]{36}\/original\.mp4$/),
        'video/mp4',
      );
      const created = videoRepository.create.mock.calls[0][0] as Partial<Video>;
      expect(created.channel_id).toBe('chan-1');
      expect(created.s3_upload_id).toBe('upload-1');
      expect(created.public_id).toHaveLength(11);
      expect(result.part_size).toBe(PART_SIZE);
      expect(result.part_count).toBe(3);
    });

    it('throws ChannelNotFoundException when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload('user-1', dto as any),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('retries once with a fresh public_id on unique collision', async () => {
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.save
        .mockRejectedValueOnce(makePublicIdCollisionError())
        .mockImplementationOnce((video: Video) => Promise.resolve(video));

      await service.initiateUpload('user-1', dto as any);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const firstId = (videoRepository.create.mock.calls[0][0] as Video)
        .public_id;
      const secondId = (videoRepository.create.mock.calls[1][0] as Video)
        .public_id;
      expect(firstId).not.toBe(secondId);
    });

    it('aborts the storage session when persisting the draft fails', async () => {
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.save.mockRejectedValue(new Error('db down'));

      await expect(
        service.initiateUpload('user-1', dto as any),
      ).rejects.toThrow('db down');
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\//),
        'upload-1',
      );
    });
  });

  describe('getPartUrls', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getPartUrls('vid-1', 'user-1', { part_numbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws VideoNotFoundException for a video of another user', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ channel: makeChannel('someone-else') }),
      );

      await expect(
        service.getPartUrls('vid-1', 'user-1', { part_numbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws UploadNotActiveException outside draft status', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING, s3_upload_id: null }),
      );

      await expect(
        service.getPartUrls('vid-1', 'user-1', { part_numbers: [1] }),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
    });

    it('throws InvalidPartNumbersException for parts beyond part_count', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ file_size: PART_SIZE }),
      );

      await expect(
        service.getPartUrls('vid-1', 'user-1', { part_numbers: [2] }),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
    });

    it('returns presigned urls for the requested parts', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ file_size: PART_SIZE * 3 }),
      );

      const urls = await service.getPartUrls('vid-1', 'user-1', {
        part_numbers: [1, 3],
      });

      expect(urls).toHaveLength(2);
      expect(urls[0]).toMatchObject({
        part_number: 1,
        url: 'http://presigned-url',
      });
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/vid-1/original.mp4',
        'upload-1',
        3,
      );
    });
  });

  describe('completeUpload', () => {
    const dto = { parts: [{ part_number: 1, etag: '"abc"' }] };

    it('maps storage part errors to UploadPartsMismatchException', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      const s3Error = new Error('part mismatch');
      s3Error.name = 'InvalidPart';
      storageService.completeMultipartUpload.mockRejectedValue(s3Error);

      await expect(
        service.completeUpload('vid-1', 'user-1', dto as any),
      ).rejects.toBeInstanceOf(UploadPartsMismatchException);
    });

    it('rethrows unexpected storage errors untouched', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      storageService.completeMultipartUpload.mockRejectedValue(
        new Error('network down'),
      );

      await expect(
        service.completeUpload('vid-1', 'user-1', dto as any),
      ).rejects.toThrow('network down');
    });

    it('transitions to processing, clears the session and enqueues the job', async () => {
      const video = makeVideo();
      videoRepository.findOne.mockResolvedValue(video);

      const result = await service.completeUpload('vid-1', 'user-1', dto as any);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/vid-1/original.mp4',
        'upload-1',
        dto.parts,
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.s3_upload_id).toBeNull();
      expect(queue.add).toHaveBeenCalledWith(
        VIDEO_PROCESS_JOB,
        { videoId: 'vid-1' },
        expect.objectContaining({
          attempts: 3,
          backoff: expect.objectContaining({ type: 'exponential' }),
        }),
      );
    });
  });

  describe('abortUpload', () => {
    it('aborts the storage session and removes the draft', async () => {
      const video = makeVideo();
      videoRepository.findOne.mockResolvedValue(video);

      await service.abortUpload('vid-1', 'user-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/vid-1/original.mp4',
        'upload-1',
      );
      expect(videoRepository.remove).toHaveBeenCalledWith(video);
    });

    it('rejects abort outside draft status', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY, s3_upload_id: null }),
      );

      await expect(
        service.abortUpload('vid-1', 'user-1'),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
      expect(videoRepository.remove).not.toHaveBeenCalled();
    });
  });
});

import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB, MinIO and Redis)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let queue: Queue;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const queueConn = queueConfig();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRoot({
          connection: { host: queueConn.host, port: queueConn.port },
        }),
        VideosModule,
      ],
    }).compile();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const userRepository = dataSource.getRepository(User);
    const channelRepository = dataSource.getRepository(Channel);
    const user = await userRepository.save(
      userRepository.create({
        email: `vs_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `VS Channel ${counter}`,
        nickname: `vschan${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  it('initiateUpload pre-registers a draft with a real multipart session', async () => {
    const { userId, channelId } = await createUserWithChannel();

    const result = await service.initiateUpload(userId, {
      title: 'Integration draft',
      file_name: 'draft.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
    });

    const stored = await videoRepository.findOneByOrFail({
      id: result.video.id,
    });
    expect(stored.status).toBe(VideoStatus.DRAFT);
    expect(stored.channel_id).toBe(channelId);
    expect(stored.public_id).toHaveLength(11);
    expect(stored.s3_upload_id).toBeTruthy();
    expect(stored.original_key).toBe(`videos/${stored.id}/original.mp4`);
    expect(result.part_count).toBe(1);
  });

  it('completes a real upload through presigned part URLs and enqueues processing', async () => {
    const { userId } = await createUserWithChannel();
    const payload = Buffer.alloc(2048, 3);

    const { video } = await service.initiateUpload(userId, {
      title: 'Integration complete',
      file_name: 'complete.mp4',
      file_size: payload.length,
      content_type: 'video/mp4',
    });

    const [partUrl] = await service.getPartUrls(video.id, userId, {
      part_numbers: [1],
    });
    const putResponse = await fetch(partUrl.url, {
      method: 'PUT',
      body: payload,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag')!;

    const completed = await service.completeUpload(video.id, userId, {
      parts: [{ part_number: 1, etag }],
    });

    expect(completed.status).toBe(VideoStatus.PROCESSING);
    expect(completed.s3_upload_id).toBeNull();

    const counts = await queue.getJobCounts('waiting', 'active', 'completed');
    expect(counts.waiting + counts.active + counts.completed).toBeGreaterThan(
      0,
    );
  });

  it('abortUpload removes the draft and invalidates the storage session', async () => {
    const { userId } = await createUserWithChannel();
    const { video } = await service.initiateUpload(userId, {
      title: 'Integration abort',
      file_name: 'abort.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
    });

    await service.abortUpload(video.id, userId);

    expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();
    await expect(
      service.completeUpload(video.id, userId, {
        parts: [{ part_number: 1, etag: '"x"' }],
      }),
    ).rejects.toThrow();
  });
});

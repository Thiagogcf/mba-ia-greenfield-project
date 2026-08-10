import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Video Channel ${counter}`,
        nickname: `vidchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      channel_id: channel.id,
      title: 'Test video',
      public_id: `pub${`${counter}`.padStart(8, '0')}`,
      file_name: 'test.mp4',
      content_type: 'video/mp4',
      file_size: 1024,
      original_key: 'videos/x/original.mp4',
      ...overrides,
    });
  }

  it('should default status to draft and nullable fields to null', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.description).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.failure_reason).toBeNull();
    expect(found.s3_upload_id).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel, { public_id: 'dupePublic1' }),
    );

    await expect(
      videoRepository.save(buildVideo(channel, { public_id: 'dupePublic1' })),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-4000-8000-000000000000',
          title: 'Orphan video',
          public_id: 'orphanPub01',
          file_name: 'orphan.mp4',
          content_type: 'video/mp4',
          file_size: 1,
          original_key: 'videos/orphan/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should round-trip a 10GiB file_size through the bigint column as number', async () => {
    const channel = await createChannel();
    const tenGiB = 10737418240;
    const saved = await videoRepository.save(
      buildVideo(channel, { public_id: 'bigfilepub1', file_size: tenGiB }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.file_size).toBe(tenGiB);
    expect(typeof found.file_size).toBe('number');
  });

  it('should persist jsonb metadata written by processing', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel, {
        public_id: 'metapublic1',
        status: VideoStatus.READY,
        metadata: { width: 1920, height: 1080, codec: 'h264' },
        duration_seconds: 42,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual({
      width: 1920,
      height: 1080,
      codec: 'h264',
    });
    expect(found.duration_seconds).toBe(42);
    expect(found.status).toBe(VideoStatus.READY);
  });
});

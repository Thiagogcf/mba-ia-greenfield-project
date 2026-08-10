import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { generatePublicId } from '../src/videos/public-id.util';

describe('Videos delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;

  const VIDEO_BYTES = Buffer.alloc(4096, 42);

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageService = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let emailCounter = 0;
  async function registerConfirmAndLogin(): Promise<{
    token: string;
    email: string;
  }> {
    const email = `videos_delivery_${++emailCounter}@example.com`;
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return { token: res.body.access_token as string, email };
  }

  async function seedVideo(
    ownerEmail: string,
    status: VideoStatus,
  ): Promise<Video> {
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: ownerEmail });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });

    const videoRepository = dataSource.getRepository(Video);
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Delivery video',
        public_id: generatePublicId(),
        file_name: 'delivery.mp4',
        content_type: 'video/mp4',
        file_size: VIDEO_BYTES.length,
        original_key: `videos/seed-${status}-${emailCounter}/original.mp4`,
        thumbnail_key:
          status === VideoStatus.READY
            ? `videos/seed-${status}-${emailCounter}/thumbnail.jpg`
            : null,
        status,
      }),
    );

    if (status === VideoStatus.READY) {
      await storageService.putObject(
        video.original_key,
        VIDEO_BYTES,
        'video/mp4',
      );
      await storageService.putObject(
        video.thumbnail_key!,
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        'image/jpeg',
      );
    }
    return video;
  }

  it('streams anonymously via 302 redirect and Range/206 on the storage URL', async () => {
    const { email } = await registerConfirmAndLogin();
    const video = await seedVideo(email, VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .expect(302);
    const location = res.headers.location;
    expect(location).toContain('minio:9000');
    expect(location).toContain(video.original_key.split('/')[1]);

    const rangeResponse = await fetch(location, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-range')).toContain('bytes 0-99/');
    const body = Buffer.from(await rangeResponse.arrayBuffer());
    expect(body.length).toBe(100);
  });

  it('hides non-ready videos from the public stream endpoint', async () => {
    const { email } = await registerConfirmAndLogin();
    const video = await seedVideo(email, VideoStatus.PROCESSING);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .expect(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('serves the thumbnail publicly through a presigned redirect', async () => {
    const { email } = await registerConfirmAndLogin();
    const video = await seedVideo(email, VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/thumbnail`)
      .expect(302);

    const imageResponse = await fetch(res.headers.location);
    expect(imageResponse.status).toBe(200);
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it('requires authentication for download and bakes the attachment disposition', async () => {
    const { email, token } = await registerConfirmAndLogin();
    const video = await seedVideo(email, VideoStatus.READY);

    await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .expect(401);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(302);
    expect(res.headers.location).toContain('response-content-disposition=');

    const downloadResponse = await fetch(res.headers.location);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-disposition')).toContain(
      'attachment',
    );
    expect(downloadResponse.headers.get('content-disposition')).toContain(
      'delivery.mp4',
    );
  });

  it('returns the owner view with processing details and hides it from others', async () => {
    const owner = await registerConfirmAndLogin();
    const intruder = await registerConfirmAndLogin();
    const video = await seedVideo(owner.email, VideoStatus.PROCESSING);

    await request(app.getHttpServer()).get(`/videos/${video.id}`).expect(401);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(res.body).toMatchObject({
      id: video.id,
      public_id: video.public_id,
      status: 'processing',
      file_name: 'delivery.mp4',
      file_size: VIDEO_BYTES.length,
    });

    const hidden = await request(app.getHttpServer())
      .get(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${intruder.token}`)
      .expect(404);
    expect(hidden.body.error).toBe('VIDEO_NOT_FOUND');
  });
});

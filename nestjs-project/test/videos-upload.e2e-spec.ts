import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

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
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  let emailCounter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    const email = `videos_e2e_${++emailCounter}@example.com`;
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
    return res.body.access_token as string;
  }

  const validPayload = {
    title: 'E2E video',
    file_name: 'e2e.mp4',
    file_size: 2048,
    content_type: 'video/mp4',
  };

  async function initiateUpload(
    token: string,
  ): Promise<{ id: string; publicId: string; partCount: number }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload)
      .expect(201);
    return {
      id: res.body.id as string,
      publicId: res.body.public_id as string,
      partCount: res.body.upload.part_count as number,
    };
  }

  it('rejects unauthenticated upload initiation with 401', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validPayload)
      .expect(401);
  });

  it('rejects a file above the 10GiB limit with VALIDATION_ERROR', async () => {
    const token = await registerConfirmAndLogin();
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, file_size: 10737418241 })
      .expect(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects an unsupported content_type with VALIDATION_ERROR', async () => {
    const token = await registerConfirmAndLogin();
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, content_type: 'application/pdf' })
      .expect(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('runs the full upload flow: initiate → part-urls → direct PUT → complete', async () => {
    const token = await registerConfirmAndLogin();
    const { id, publicId, partCount } = await initiateUpload(token);
    expect(publicId).toHaveLength(11);
    expect(partCount).toBe(1);

    const partUrlsRes = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const partUrl = partUrlsRes.body.urls[0];
    expect(partUrl.part_number).toBe(1);
    expect(partUrl.url).toContain('minio:9000');

    const putResponse = await fetch(partUrl.url, {
      method: 'PUT',
      body: Buffer.alloc(validPayload.file_size, 1),
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag')!;

    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);
    expect(completeRes.body.status).toBe('processing');

    const again = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(409);
    expect(again.body.error).toBe('UPLOAD_NOT_ACTIVE');
  });

  it('hides videos of other users behind VIDEO_NOT_FOUND', async () => {
    const ownerToken = await registerConfirmAndLogin();
    const intruderToken = await registerConfirmAndLogin();
    const { id } = await initiateUpload(ownerToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ part_numbers: [1] })
      .expect(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('rejects part numbers beyond the upload part_count', async () => {
    const token = await registerConfirmAndLogin();
    const { id } = await initiateUpload(token);

    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [2] })
      .expect(400);
    expect(res.body.error).toBe('INVALID_PART_NUMBERS');
  });

  it('aborts an upload, undoing the pre-registration', async () => {
    const token = await registerConfirmAndLogin();
    const { id } = await initiateUpload(token);

    await request(app.getHttpServer())
      .delete(`/videos/${id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });
});

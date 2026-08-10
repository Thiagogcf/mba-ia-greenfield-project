process.env.UPLOAD_PART_SIZE = '5242880';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { promisify } from 'util';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { generatePublicId } from '../src/videos/public-id.util';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/videos/videos.constants';

const execFileAsync = promisify(execFile);
const PART_SIZE = 5242880;

describe('Videos pipeline (e2e — full flow with real worker, MinIO and Redis)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let tempDir: string;
  let videoBytes: Buffer;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pipeline-e2e-'));
    const fixturePath = join(tempDir, 'fixture.mp4');
    await execFileAsync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=12:size=1280x720:rate=30',
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      '-pix_fmt',
      'yuvj420p',
      '-y',
      fixturePath,
    ]);
    videoBytes = await readFile(fixturePath);
    expect(videoBytes.length).toBeGreaterThan(PART_SIZE);

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
  }, 60000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  let emailCounter = 0;
  async function registerConfirmAndLogin(): Promise<{
    token: string;
    email: string;
  }> {
    const email = `pipeline_${++emailCounter}@example.com`;
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

  async function pollVideo(
    id: string,
    token: string,
    doneStatuses: string[],
    timeoutMs: number,
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      if (doneStatuses.includes(res.body.status as string)) {
        return res.body as Record<string, any>;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for statuses [${doneStatuses.join(', ')}]; last was ${res.body.status}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  it('uploads a real multi-part video, waits for the worker and delivers it', async () => {
    const { token } = await registerConfirmAndLogin();

    const initiateRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Pipeline movie',
        description: 'Uploaded end-to-end by the pipeline spec',
        file_name: 'pipeline.mp4',
        file_size: videoBytes.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    const videoId = initiateRes.body.id as string;
    const publicId = initiateRes.body.public_id as string;
    const partCount = initiateRes.body.upload.part_count as number;
    expect(partCount).toBeGreaterThanOrEqual(2);

    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const partUrlsRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers })
      .expect(200);

    const parts: Array<{ part_number: number; etag: string }> = [];
    for (const { part_number, url } of partUrlsRes.body.urls as Array<{
      part_number: number;
      url: string;
    }>) {
      const start = (part_number - 1) * PART_SIZE;
      const chunk = new Uint8Array(
        videoBytes.subarray(start, start + PART_SIZE),
      );
      const putResponse = await fetch(url, { method: 'PUT', body: chunk });
      expect(putResponse.status).toBe(200);
      parts.push({ part_number, etag: putResponse.headers.get('etag')! });
    }

    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(200);
    expect(completeRes.body.status).toBe('processing');

    const processed = await pollVideo(
      videoId,
      token,
      ['ready', 'failed'],
      90000,
    );
    expect(processed.status).toBe('ready');
    expect(processed.duration_seconds).toBeGreaterThanOrEqual(10);
    expect(processed.duration_seconds).toBeLessThanOrEqual(14);
    expect(processed.metadata).toMatchObject({ width: 1280, height: 720 });

    const streamRes = await request(app.getHttpServer())
      .get(`/videos/${publicId}/stream`)
      .expect(302);
    const rangeResponse = await fetch(streamRes.headers.location, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(rangeResponse.status).toBe(206);
    expect(
      Buffer.from(await rangeResponse.arrayBuffer()).equals(
        videoBytes.subarray(0, 100),
      ),
    ).toBe(true);

    const thumbRes = await request(app.getHttpServer())
      .get(`/videos/${publicId}/thumbnail`)
      .expect(302);
    const thumbResponse = await fetch(thumbRes.headers.location);
    expect(thumbResponse.status).toBe(200);
    const thumbBytes = Buffer.from(await thumbResponse.arrayBuffer());
    expect(thumbBytes[0]).toBe(0xff);
    expect(thumbBytes[1]).toBe(0xd8);

    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${publicId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(302);
    const downloadResponse = await fetch(downloadRes.headers.location);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-disposition')).toContain(
      'attachment',
    );
  }, 180000);

  it('marks the video as failed with a reason when the original is missing', async () => {
    const { token, email } = await registerConfirmAndLogin();
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    const videoRepository = dataSource.getRepository(Video);
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Broken pipeline video',
        public_id: generatePublicId(),
        file_name: 'missing.mp4',
        content_type: 'video/mp4',
        file_size: 1024,
        original_key: 'videos/does-not-exist/original.mp4',
        status: VideoStatus.PROCESSING,
      }),
    );

    await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: video.id },
      { attempts: 2, backoff: { type: 'exponential', delay: 1000 } },
    );

    const failed = await pollVideo(video.id, token, ['failed'], 60000);
    expect(failed.status).toBe('failed');
    expect(failed.failure_reason).toBeTruthy();
  }, 90000);
});

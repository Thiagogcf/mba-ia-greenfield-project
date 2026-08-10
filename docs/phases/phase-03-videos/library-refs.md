---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-08-10T19:40:00-03:00"
  "bullmq":
    version: "^6.0.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-08-10T19:40:00-03:00"
  "ioredis":
    version: "^5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-08-10T19:40:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1107.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-10T19:40:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1107.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-10T19:40:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-10T19:37:03-0300"
---

# Library References — phase-03-videos

Cached Context7 excerpts for libraries decided in this phase. Refreshed by `/plan-resolve` when a new library is decided or when the cache is missing for an already-decided TD.

---

## @nestjs/bullmq

**Version line:** `^11.0.5` (peers: `@nestjs/core ^10 || ^11` — matches installed `@nestjs/core ^11.0.1`; `bullmq ^3 || ^4 || ^5 || ^6`).
**Decided in:** `phase-03-videos/TD-01` (Option A — BullMQ + Redis).
**Context7 ID:** `/nestjs/docs.nestjs.com` (Techniques → Queues, BullMQ variant).

### 1. Root connection + queue registration (async, config-driven per inherited conventions)

```typescript
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: { host: config.host, port: config.port },
  }),
});

BullModule.registerQueue({ name: 'video-processing' });
```

`registerQueueAsync({ name, useFactory })` exists for per-queue options; the queue `name` must stay outside the factory.

### 2. Producer (API side)

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideoQueueProducer {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}
```

### 3. Consumer (worker side)

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    // job.data carries the payload; job.updateProgress(n) is available
  }
}
```

`@Processor('name')` binds the consumer to the registered queue; the class extends `WorkerHost` and implements `process()`. Registering the processor class as a provider in the worker-side module is what activates consumption (TD-03: only the worker entrypoint's module graph includes it).

---

## bullmq

**Version line:** `^6.0.0` (current major; requires Node ≥14.17 — container runs Node 25; Redis ≥6.2 or Valkey).
**Decided in:** `phase-03-videos/TD-01` (Option A) and `phase-03-videos/TD-08` (failure policy).
**Context7 ID:** `/taskforcesh/bullmq`.

### 1. Job options — retries with exponential backoff (TD-08)

```typescript
await queue.add(
  'process-video',
  { videoId },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
);
```

Built-in `exponential` strategy computes `2^(attemptsMade-1) * delay` (optional jitter). With `attempts: 3` and `delay: 5000`: retries after ~5s and ~10s; after the 3rd failure the job lands in the `failed` set.

### 2. Worker lifecycle events

```typescript
worker.on('completed', (job: Job, returnvalue: any) => {});
worker.on('failed', (job: Job, error: Error) => {});
```

In `@nestjs/bullmq`, the same hooks are available via `@OnWorkerEvent('completed')` / `@OnWorkerEvent('failed')` methods on the `WorkerHost` class. The terminal `failed` event (when `job.attemptsMade === job.opts.attempts`) is where TD-08's `FAILED` + `failure_reason` persistence happens.

### 3. Semantics that constrain the design

- Delivery is at-least-once; stalled-job recovery can re-deliver — `process()` must be idempotent (TD-08: reprocessing a `READY` video is a safe no-op/overwrite).
- Redis must run with `maxmemory-policy=noeviction` to avoid silent job loss.
- BullMQ 6 no longer bundles a Redis client — `ioredis` became an optional peer ("bring your own client"); the project installs `ioredis@^5` explicitly as the companion dependency (verified at implementation, SI-03.5).

---

## @aws-sdk/client-s3

**Version line:** `^3.1107.0`.
**Decided in:** `phase-03-videos/TD-02` (multipart presigned upload) and `phase-03-videos/TD-07` (client configuration).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### 1. Client configuration for MinIO (TD-07)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

new S3Client({
  endpoint: config.endpoint,        // http://minio:9000 (internal)
  region: config.region,            // e.g. us-east-1 (MinIO accepts any)
  forcePathStyle: true,             // MinIO requirement — path-style addressing
  credentials: {
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
  },
});
```

`forcePathStyle` and `endpoint` are first-class `S3Client` constructor options. Two client instances are needed per TD-07: one on `S3_ENDPOINT` for server-side operations, one on `S3_PUBLIC_ENDPOINT` used exclusively as the signing base for presigned URLs (SigV4 covers the host).

### 2. Multipart lifecycle (TD-02)

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';

const { UploadId } = await s3.send(
  new CreateMultipartUploadCommand({ Bucket, Key, ContentType }),
);

// per part (client uploads via presigned URL; server only signs):
new UploadPartCommand({ Bucket, Key, UploadId, PartNumber });

await s3.send(
  new CompleteMultipartUploadCommand({
    Bucket,
    Key,
    UploadId,
    MultipartUpload: { Parts: [{ ETag, PartNumber }] },
  }),
);

await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

`CompleteMultipartUploadCommand` requires the ordered `{ ETag, PartNumber }` list collected from each part upload response (the client reads each part PUT's `ETag` response header). `ListPartsCommand({ Bucket, Key, UploadId })` allows server-side reconciliation of received parts.

### 3. Download headers via GetObject (TD-05)

`GetObjectCommand` accepts `ResponseContentDisposition` / `ResponseContentType`; they serialize as `response-content-disposition` / `response-content-type` query params and **require a signed request or presigned URL** (never anonymous) — exactly the TD-05 download shape:

```typescript
new GetObjectCommand({
  Bucket,
  Key,
  ResponseContentDisposition: `attachment; filename="${originalName}"`,
});
```

---

## @aws-sdk/s3-request-presigner

**Version line:** `^3.1107.0` (same release train as the client).
**Decided in:** `phase-03-videos/TD-02` (part URLs) and `phase-03-videos/TD-05` (streaming/download GET).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### 1. Presigning any command

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(publicS3Client, command, { expiresIn: 3600 });
```

- `expiresIn` is in seconds (default 900). Phase parameters: part URLs 3600 (1h, TD-02); streaming GET 21600 (6h, TD-05); download GET 900 (15min, TD-05).
- `getSignedUrl` runs the command through the client's middleware/serializer, so command inputs (`PartNumber`, `UploadId`, `ResponseContentDisposition`) are baked into the presigned URL as query params automatically.
- Sign with the client configured against `S3_PUBLIC_ENDPOINT` (TD-07 dual-endpoint rule) — the signature covers the host, so a URL signed for `minio:9000` is invalid if fetched via another host.

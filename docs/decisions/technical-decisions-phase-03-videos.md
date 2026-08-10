---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-10
scope_description: "Video upload and processing backbone: queue technology, 10GB upload strategy, worker execution model, FFmpeg invocation, streaming/download delivery, unique public URL, storage layout, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload orchestration, queue producer, streaming/download endpoints), the video worker (queue consumer + FFmpeg), and the new Compose infrastructure (object storage, queue).
- `next-frontend/` — no TD in this document: the video UI is explicitly out of Phase 03 scope (backend-only phase). The Cross-layer TDs below (TD-02, TD-05) define the contracts the frontend will consume when the video UI is built in a later phase.

_Decision provenance:_ decisions adopted from the recommendations under the autonomous-conduction mode agreed with the project owner on 2026-08-10; the owner reviews this document as final arbiter.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the message queue explicitly as "TBD" — this is the main open stack decision of the phase. The queue carries video-processing jobs from the API (producer) to the worker (consumer). Acceptance constraint: the queue must run as a real service in `compose.yaml` and be exercised by integration/e2e tests.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with an official NestJS wrapper. API registers a queue and adds jobs; the worker declares a `@Processor` class. Installed pair as of 2026-08: `@nestjs/bullmq` 11.0.5 (peer: NestJS ^10/^11) + `bullmq` 6.x.
- **Pros:** Official NestJS integration (documented in NestJS docs, same `11.x` versioning line as the rest of the stack). Retries with exponential backoff, delayed jobs, stalled-job recovery and per-job state are first-class. Worker reuses the same codebase/DI. Redis is a small, well-known Compose service, reusable for caching/rate-limit storage in later phases.
- **Cons:** Adds Redis as new infrastructure. At-least-once semantics require idempotent job handlers. Not a general-purpose broker — Node-only consumers (irrelevant here: the worker is Node).

### Option B: RabbitMQ (`@golevelup/nestjs-rabbitmq`)
- Dedicated AMQP broker; API publishes to an exchange, worker consumes with ack/nack and dead-letter exchanges. Current lib: `@golevelup/nestjs-rabbitmq` 9.0.2 (peer: NestJS ^11).
- **Pros:** Real broker semantics (ack/nack, DLQ, prefetch), language-agnostic — a future worker could be Go/Python. Management UI included. Battle-tested in media pipelines.
- **Cons:** Heavier service (Erlang runtime) and more configuration surface (exchanges, bindings, DLX). The NestJS integration is community-maintained, not official (`@nestjs/microservices` RMQ transport exists but is RPC-oriented, ill-suited for long-running job consumption). Retry/backoff must be assembled from DLX + TTL patterns instead of a per-job `attempts` declaration.

### Option C: pg-boss (PostgreSQL as queue)
- Job queue on top of the existing PostgreSQL using `SKIP LOCKED` (pg-boss 12.x, Node ≥22 — compatible with the project's Node 25 container).
- **Pros:** Zero new infrastructure; ACID guarantees; transactional enqueue with the video row update.
- **Cons:** Fails the phase's acceptance constraint of a queue as a visible, real Compose service — the "queue" would be invisible inside the app database. Couples job churn (polling, job table writes) to the primary OLTP database. Weaker ecosystem for job observability.

**Recommendation:** **Option A (BullMQ + Redis)** — the only option that combines an *official* NestJS integration (the project consistently prefers first-party `@nestjs/*` packages — see phase 02's `@nestjs/jwt` choice), first-class retry/backoff for the video-processing failure policy (TD-08), and a real queue service in Compose. RabbitMQ's interoperability advantage buys nothing while the single worker is Node, and pg-boss violates the visible-queue-infrastructure constraint.

**Decision:** A (BullMQ + Redis)

---

## TD-02: 10GB Upload Strategy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB file must reach object storage without the API ever holding the byte stream (routing the file through the API is an automatic-failure condition for the phase). The chosen handshake is a contract both for the backend now and for the future frontend upload UI. Piping uploads through the API (multer/stream proxy) is excluded upfront as inadequate: it puts every byte through Node, blocks the event loop budget, and doubles bandwidth.

**Options:**

### Option A: Single presigned PUT URL
- API issues one presigned `PutObject` URL; client PUTs the whole file directly to storage.
- **Pros:** Simplest possible handshake (1 URL, 1 request). No completion step.
- **Cons:** S3 hard limit — a single PUT accepts at most 5GB ([AWS S3 limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html)), so 10GB files are impossible. No parallelism, no resume: a failure at 99% restarts from zero.

### Option B: S3 Multipart Upload with presigned part URLs
- API calls `CreateMultipartUpload`, registers the video as draft (pré-cadastro), and hands the client presigned `UploadPart` URLs on demand; the client PUTs parts (5MB–5GB each, max 10,000 parts → up to 5TB) directly to storage and finishes via `CompleteMultipartUpload` with the collected ETags; `AbortMultipartUpload` covers cancellation/expiry.
- **Pros:** Bytes never touch the API — it only signs and orchestrates. Parts upload in parallel and retry individually (resume-per-part for free). Native to every S3-compatible store, including MinIO. Maps naturally onto the draft pre-registration requirement (draft row created at initiate).
- **Cons:** Client must orchestrate part splitting, ETag collection and completion. Abandoned multipart sessions must be aborted (lifecycle/cleanup policy).

### Option C: tus resumable-upload protocol (tusd)
- Standardized resumable protocol via a dedicated `tusd` server container writing to S3 (itself using multipart under the hood).
- **Pros:** Standardized resumability with ready-made client libs; offset-based resume simpler for flaky connections.
- **Cons:** A third-party server container in front of storage — extra infrastructure, auth integration via hooks, and another moving part to test. For an S3-compatible target it wraps the same multipart mechanics Option B uses directly.

**Recommendation:** **Option B (presigned multipart)** — the only option that reaches 10GB while keeping the API out of the byte path with zero additional infrastructure. Operational parameters (cross-component: config schema + docs + client contract): part size 100MiB (10GB → 100 parts, comfortably under the 10,000-part cap; ≥5MiB S3 minimum), presigned part URL TTL 1h, max declared file size 10GB enforced at initiate, orphaned drafts abortable via `AbortMultipartUpload`.

**Decision:** B (S3 Multipart Upload with presigned part URLs)

---

## TD-03: Worker Execution Model

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 architecture defines a Video Worker as a separate container consuming the queue. What must be decided is how that worker is built and deployed relative to the existing NestJS codebase — this shapes the Compose file, the repo layout, and code reuse (entities, config, storage service).

**Options:**

### Option A: Same codebase, separate container (dedicated Nest entrypoint)
- A second entrypoint (e.g., `src/worker/main.ts`) bootstraps a NestJS application context containing only the worker-side modules (queue consumer, TypeORM, storage). Compose runs a `video-worker` service from the same image as the API with a different command.
- **Pros:** Full reuse of entities, config validation, storage service and DI — zero duplication. Independent lifecycle/scaling per container (CPU-bound FFmpeg never competes with HTTP). One image to build; matches the existing bind-mount dev workflow.
- **Cons:** API and worker share one `package.json` (worker deps ship in the API image and vice versa). Requires discipline to keep worker-only modules out of the HTTP app graph.

### Option B: Separate package (`video-worker/` with own manifest)
- New standalone Node/NestJS package with its own dependencies and Dockerfile.
- **Pros:** Hard isolation of dependency surfaces; independently versioned.
- **Cons:** Duplicates or extracts-to-a-shared-lib the entities, config and storage code — a monorepo-tooling investment (workspaces) far beyond this phase's needs. Two builds, two node_modules, double maintenance for a single consumer.

### Option C: In-process processors (API container runs the consumer)
- The API app itself registers the queue processor.
- **Pros:** No new service.
- **Cons:** FFmpeg is CPU-bound — transcoding-adjacent work inside the API container directly violates "sem impacto na performance", and no real worker appears in Compose (acceptance-criteria failure).

**Recommendation:** **Option A** — maximum reuse with real process isolation, at the cost of a shared dependency manifest that is irrelevant at this scale. Matches the C4 diagram (separate Video Worker container) without introducing monorepo tooling.

**Decision:** A (same codebase, separate container with dedicated Nest entrypoint)

---

## TD-04: FFmpeg Distribution & Invocation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker extracts duration/metadata (ffprobe) and generates a thumbnail frame (ffmpeg). Two sub-questions: where the binaries come from, and how Node invokes them. Relevant landscape shift: `fluent-ffmpeg`, the historical Node wrapper, was [archived on 2025-05-22](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324) (read-only, no fixes) — wrapper libs are off the table.

**Options:**

### Option A: System FFmpeg via Docker image (apt) + direct `child_process` invocation
- Add `ffmpeg` to `Dockerfile.dev` (Debian package, ships `ffmpeg` + `ffprobe`). Node spawns the binaries with explicit args (`execFile`), parsing `ffprobe -print_format json` output.
- **Pros:** Deterministic distro-maintained build with security updates; one install shared by the worker container *and* the API container (integration/e2e tests exercise real processing inside the existing test container). No npm supply-chain/postinstall downloads. Direct args = full control, no unmaintained abstraction.
- **Cons:** Image grows (~200–300MB). Binaries absent outside Docker (irrelevant: the project rule is that everything runs in containers).

### Option B: `ffmpeg-static` + `ffprobe-static` npm binaries
- npm packages download pinned static binaries at install time; Node spawns them by exported path.
- **Pros:** Works wherever `npm install` runs, no Dockerfile change.
- **Cons:** `ffmpeg-static` latest (5.3.0) was published 2024-12 and lags FFmpeg releases; postinstall binary downloads are a known CI flakiness/supply-chain concern; per-arch binaries inflate `node_modules` in the bind mount.

**Recommendation:** **Option A** — the project already builds a dev image (`Dockerfile.dev`), so the distro package is one line, kept current by Debian, and automatically present in every container that runs tests. Direct `execFile` invocation with JSON ffprobe output avoids depending on an archived wrapper ecosystem.

**Decision:** A (system FFmpeg in the Docker image, direct child_process invocation)

---

## TD-05: Streaming & Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must work without downloading the whole file — in practice, HTTP Range requests answered with `206 Partial Content` so players can seek. Download must deliver the original file as an attachment. The decision is *who serves the bytes*: the API or the object storage. It is a contract with the future frontend player.

**Options:**

### Option A: API redirects (302) to a short-lived presigned GET URL
- `GET /videos/{publicId}/stream` validates state (`READY`) and redirects to a presigned `GetObject` URL; the player follows the redirect and issues Range requests directly against storage, which serves `206` natively. Download uses the same mechanism with `response-content-disposition: attachment` baked into the presigned URL.
- **Pros:** Bytes never traverse the API (consistent with TD-02's principle); storage handles Range/`206`, `ETag` and `Accept-Ranges` natively and efficiently. The public URL stays stable at the API level while the storage URL rotates. Trivially CDN-fronted later.
- **Cons:** Presigned URLs expire (TTL must comfortably exceed a viewing session); the storage endpoint must be reachable by the client, requiring an explicit public-endpoint configuration in dev (see TD-07).

### Option B: API proxy with Range passthrough
- The API receives the Range request, forwards it to storage (`GetObject` with `Range`), and pipes the stream back with `206`.
- **Pros:** Single stable URL; per-request authorization; storage completely hidden.
- **Cons:** Every played byte flows through Node — for video-sized payloads this consumes API bandwidth, sockets and event-loop budget, re-creating at read time exactly what TD-02 eliminated at write time.

### Option C: Public-read bucket with direct static URLs
- Objects are world-readable; the API just prints URLs.
- **Pros:** Zero signing logic.
- **Cons:** No access control at all — irreconcilable with Phase 04's video/channel management (visibility, unpublishing) and with revoking access to failed/removed videos.

**Recommendation:** **Option A** — keeps the API a control plane on both the write path (TD-02) and the read path, with native `206` semantics from storage. Streaming presign TTL 6h; download presign TTL 15min with `response-content-disposition: attachment; filename="<original>"`.

**Decision:** A (302 redirect to presigned GET; download via content-disposition presign)

---

## TD-06: Unique Public Video URL Identity

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a public, collision-free URL identifier, decoupled from the internal primary key. Constraint from the stack: the project compiles to CommonJS, and `nanoid` ≥4 is ESM-only (current latest 6.0.1) — it cannot be `require`d from the compiled Nest build.

**Options:**

### Option A: `nanoid@3` (last CommonJS major)
- Pin the 3.x line (CJS) and generate 11-char IDs with a custom alphabet.
- **Pros:** Battle-tested generator, tiny, uniform distribution handled by the lib.
- **Cons:** Permanently pinned to a legacy major that receives no feature work; a dependency added solely to avoid ~15 lines of code.

### Option B: Custom generator over Node `crypto` (no dependency)
- A small utility using `crypto.randomInt`/`randomBytes` to produce an 11-char base62 ID (~65 bits of entropy — YouTube-style), stored in a `UNIQUE` column; on the (astronomically rare) constraint violation, retry with a fresh ID.
- **Pros:** Zero dependencies, zero ESM/CJS friction, identical entropy properties, collision safety guaranteed by the database constraint rather than by probability alone.
- **Cons:** ~15 lines of first-party code to test and maintain (bias-free sampling must use `crypto.randomInt`, not naive modulo).

### Option C: Expose the entity UUID (primary key) in the URL
- Reuse the internal `uuid` PK as the public identifier.
- **Pros:** Nothing to build.
- **Cons:** 36-char URLs; couples the public contract to the internal key (cannot rotate/regenerate); aesthetically and practically unlike every video platform's short-ID convention.

**Recommendation:** **Option B** — a dependency-free 11-char base62 `publicId` with DB `UNIQUE` constraint and single-retry-on-collision policy; avoids pinning a legacy nanoid major for functionality `crypto` provides directly.

**Decision:** B (custom crypto-based 11-char base62 publicId, UNIQUE constraint, retry on collision)

---

## TD-07: Object Storage Layout & Access Configuration

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage *technology* is fixed by the project (S3-compatible; MinIO in local Docker). What needs deciding is how it is used: bucket/key organization, SDK, endpoint strategy for presigned URLs, and which MinIO image to pin — the latter made non-trivial by MinIO's 2025 retreat from community distribution (console features removed 2025-06; [community binaries/Docker images discontinued 2025-10](https://bizety.com/2025/12/06/minio-in-maintenance-mode-open-source-alternatives/), last image tag on Docker Hub: `RELEASE.2025-09-07T16-13-09Z`).

**Options:**

### Option A: Single bucket, per-video key prefixes
- One bucket (`streamtube-media`) with keys `videos/{videoId}/original{ext}` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** One bucket to bootstrap/configure (CORS, policies); a video's assets live under one prefix (cleanup = prefix delete); key structure carries ownership context.
- **Cons:** Cannot apply bucket-level policy differences between videos and thumbnails (irrelevant while both are presign-served).

### Option B: Separate buckets for videos and thumbnails
- `videos` + `thumbnails` buckets with per-bucket policies.
- **Pros:** Could make thumbnails public-read while videos stay private.
- **Cons:** Two bootstraps, two CORS configs, split cleanup for one video's assets — buying flexibility TD-05 doesn't need (thumbnails are also presign-delivered).

**Recommendation:** **Option A**, with the following cross-component configuration (config schema + `compose.yaml` + `.env.example`):
- **SDK:** `@aws-sdk/client-s3` v3 (3.1107.x) + `@aws-sdk/s3-request-presigner`, `forcePathStyle: true` (MinIO requirement).
- **Dual endpoint:** `S3_ENDPOINT` (internal, `http://minio:9000`, used for SDK operations from API/worker) and `S3_PUBLIC_ENDPOINT` (client-reachable, `http://localhost:9000` in dev, used as the signing base for presigned URLs — the SigV4 signature covers the host, so presigns must be generated against the endpoint the client will actually hit).
- **Image pin:** `minio/minio:RELEASE.2025-09-07T16-13-09Z` — the final community image; functionally complete S3 API for dev/test, swapped for real S3 in production. If the pin ever becomes unavailable, S3-compatible substitutes (e.g., Garage, SeaweedFS) can replace the Compose service without code changes — the SDK contract is the boundary.
- **Bucket bootstrap:** one-shot `minio/mc` init service in Compose (idempotent `mb --ignore-existing`), so neither API nor worker owns bucket creation.

**Decision:** A (single bucket with per-video prefixes, AWS SDK v3, dual-endpoint presign strategy, pinned MinIO image, mc bootstrap)

---

## TD-08: Video Status Lifecycle & Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is created before the file exists (draft at upload initiate) and must reflect processing progress and failure. The state machine is a cross-component contract: DB enum + API responses + worker transitions + future frontend rendering.

**Options:**

### Option A: Four states — `DRAFT → PROCESSING → READY | FAILED`
- `DRAFT` from initiate until the client completes the multipart upload; `PROCESSING` from completion (job enqueued) until the worker finishes; `READY` on success; `FAILED` terminal with a persisted `failure_reason`.
- **Pros:** Matches the plan's own wording ("rascunho → processando → pronto/erro"). Every state is server-observable (the server cannot distinguish "client is uploading parts" from "client walked away" — both are `DRAFT`). Fewest transitions to test.
- **Cons:** No distinct telemetry for "upload finished, job still queued" (observable via queue metrics instead).

### Option B: Six states — adds `UPLOADING` and `UPLOADED`
- Finer-grained progress reporting.
- **Pros:** More granular UI states for the future frontend.
- **Cons:** `UPLOADING` is not server-observable (part PUTs go straight to storage — the API never sees them); `UPLOADED` duplicates "PROCESSING minus queue lag". Extra transitions with no authoritative source of truth.

**Recommendation:** **Option A**, with this failure policy: BullMQ job `attempts: 3` with exponential backoff (base 5s); the video stays `PROCESSING` during retries; on final failure the worker sets `FAILED` + `failure_reason` and the job lands in the failed set for inspection; job handlers are idempotent (re-running a processing job for an already-`READY` video is a safe no-op / overwrite); the uploaded original is never auto-deleted on failure, enabling future manual reprocessing.

**Decision:** A (four states with retry/backoff and terminal FAILED + reason)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Background processing queue technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Cross-layer | 10GB upload strategy | S3 multipart with presigned part URLs | B (presigned multipart) |
| TD-03 | Repo-wide | Worker execution model | Same codebase, separate container | A (dedicated Nest entrypoint) |
| TD-04 | Backend | FFmpeg distribution & invocation | System FFmpeg in image + child_process | A (apt + execFile) |
| TD-05 | Cross-layer | Streaming & download delivery | 302 to presigned GET (+ content-disposition) | A (presigned redirect) |
| TD-06 | Backend | Unique public video URL identity | Custom crypto base62 publicId | B (crypto util + UNIQUE) |
| TD-07 | Backend | Storage layout & access configuration | Single bucket, dual endpoint, pinned MinIO | A (single bucket + prefixes) |
| TD-08 | Backend | Video status lifecycle & failure policy | 4 states + retries/backoff | A (DRAFT→PROCESSING→READY\|FAILED) |

---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-10T19:41:16-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-10T19:38:32-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-10T19:37:03-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-10T18:47:44-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video upload and processing backbone — direct-to-storage multipart upload of files up to 10GB with automatic draft pre-registration, queue-based asynchronous processing in a dedicated FFmpeg worker (duration, metadata and thumbnail extraction), collision-free public video URLs, and playback via streaming plus authenticated download.

---

## Step Implementations

### SI-03.1 — Dependências e Namespaces de Configuração (storage e fila)

**Description:** Instala as libs fixadas da fase e cria os namespaces de configuração `storage` e `queue` seguindo o padrão `registerAs` herdado da Fase 01, com schema Joi e `.env.example` atualizados.

**Technical actions:**

1. Instalar dependências de produção em nestjs-project: `@nestjs/bullmq@^11.0.5`, `bullmq@^6.0.0`, `@aws-sdk/client-s3@^3.1107.0`, `@aws-sdk/s3-request-presigner@^3.1107.0` (per `phase-03-videos/TD-01` e `phase-03-videos/TD-07`; versões conforme `library-refs.md`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://minio:9000`, per Revision 2026-08-10 de `phase-03-videos/TD-07`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY` (required), `S3_SECRET_KEY` (required), `S3_BUCKET` (default `streamtube-media`), `UPLOAD_PART_SIZE` (default `104857600`), `UPLOAD_MAX_FILE_SIZE` (default `10737418240`), `PRESIGN_PART_TTL` (default `3600`), `PRESIGN_STREAM_TTL` (default `21600`), `PRESIGN_DOWNLOAD_TTL` (default `900`) (per `phase-03-videos/TD-02`, `TD-05` e `TD-07`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-01`)
4. Atualizar `src/config/env.validation.ts` — adicionar as novas variáveis ao schema Joi (`S3_ACCESS_KEY`/`S3_SECRET_KEY` required, demais com default) — e atualizar `.env.example` e `.env` com os novos valores, documentando `S3_PUBLIC_ENDPOINT=http://localhost:9000` como alternativa comentada para browser no host e normalizando a linha `MAIL_FROM` para o formato quoted shell-safe já documentado no CLAUDE.md do backend

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation` | Integration: novas variáveis required/defaults | `src/config/env.validation.integration-spec.ts` (estender) |

**Dependencies:** none

**Acceptance criteria:**

- Aplicação sobe com as novas variáveis presentes; bootstrap sem `S3_ACCESS_KEY` falha com erro de validação Joi
- As quatro libs novas resolvem nas linhas de versão fixadas no `library-refs.md`
- `.env.example` documenta todas as variáveis novas com defaults compatíveis com os service names do Compose

---

### SI-03.2 — Infraestrutura no Compose: MinIO, Redis e FFmpeg

**Description:** Sobe o object storage e a fila como serviços reais no Docker Compose, com bootstrap idempotente do bucket e FFmpeg disponível na imagem de desenvolvimento compartilhada.

**Technical actions:**

1. Adicionar serviço `minio` ao `nestjs-project/compose.yaml` — imagem pinada `minio/minio:RELEASE.2025-09-07T16-13-09Z`, command `server /data --console-address ":9001"`, portas 9000/9001, volume nomeado, healthcheck HTTP em `/minio/health/live`, credenciais via env (per `phase-03-videos/TD-07`)
2. Adicionar serviço one-shot `createbuckets` — imagem `minio/mc`, `mb --ignore-existing` do bucket `streamtube-media`, `depends_on` minio healthy (per `phase-03-videos/TD-07`)
3. Adicionar serviço `redis` — imagem `redis:7-alpine`, command com `--maxmemory-policy noeviction`, healthcheck `redis-cli ping`, porta 6379 (per `phase-03-videos/TD-01` e semântica BullMQ em `library-refs.md` § bullmq)
4. Instalar `ffmpeg` no `Dockerfile.dev` via apt — binários `ffmpeg`/`ffprobe` presentes na imagem usada pela API (onde os testes rodam) e pelo worker (per `phase-03-videos/TD-04`)
5. Atualizar `depends_on` do `nestjs-api` para incluir `minio` e `redis` (condition healthy)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — nomes de bucket/credenciais alinhados entre `.env` e Compose

**Acceptance criteria:**

- `docker compose up -d` sobe `minio` e `redis` (healthy) e `createbuckets` finaliza deixando o bucket `streamtube-media` existente
- `docker compose exec nestjs-api ffmpeg -version` e `ffprobe -version` respondem na imagem reconstruída
- MinIO responde em `http://localhost:9000` no host e em `http://minio:9000` na rede do Compose

---

### SI-03.3 — Entidade Video, Migration e Módulo Base

**Description:** Cria a tabela de vídeos ligada ao canal com o ciclo de status e a identidade pública única, mais o esqueleto do módulo.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos e constraints do `### Data Model` (enum `videos_status_enum` default `'draft'`, `public_id` varchar(11) unique, `channel_id` FK via `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`, `metadata` jsonb, `file_size` bigint, timestamps)
2. Criar `src/videos/public-id.util.ts` — gerador de `public_id` base62 de 11 caracteres com `crypto.randomInt` (amostragem sem viés de módulo) (per `phase-03-videos/TD-06`)
3. Gerar migration via `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL gerado (tabela, tipo enum, unique de `public_id`, FK e index em `channel_id`)
4. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, registrado no `AppModule`
5. Estender `src/database/migrations.integration-spec.ts` — incluir `CreateVideos` na lista de migrations, `videos` em `MANAGED_TABLES` e `videos_status_enum` em `MANAGED_TYPES`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, FK, enum | `src/videos/entities/video.entity.integration-spec.ts` |
| `public-id.util` | Unit: comprimento, alfabeto base62, ausência de colisão em amostra | `src/videos/public-id.util.spec.ts` |
| `VideosModule` | Unit: compilação DI | `src/videos/videos.module.spec.ts` |
| migrations | Integration: aplica/reverte incluindo `CreateVideos` | `src/database/migrations.integration-spec.ts` (estender) |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, enum, unique de `public_id`, FK e index de `channel_id`
- Inserir dois vídeos com o mesmo `public_id` viola a unique constraint
- Vídeo recém-criado tem `status = 'draft'` por default
- Inserir vídeo com `channel_id` inexistente falha por violação de FK

---

### SI-03.4 — Módulo de Storage (clientes S3, presign e multipart)

**Description:** Serviço de object storage com os dois clientes S3 (operações internas e assinatura pública), operações do ciclo multipart e entrega presignada — a única fronteira do código com o storage.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` + `src/storage/storage.service.ts` — dois `S3Client` com `forcePathStyle: true`: interno (`S3_ENDPOINT`, operações do servidor) e público (`S3_PUBLIC_ENDPOINT`, usado exclusivamente como base de assinatura) (per `phase-03-videos/TD-07` e `library-refs.md` § @aws-sdk/client-s3)
2. Implementar operações multipart: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)` (TTL `PRESIGN_PART_TTL`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`, `library-refs.md` § @aws-sdk/s3-request-presigner)
3. Implementar entrega e IO do worker: `presignGetObject(key, ttl, contentDisposition?)`, `getObjectStream(key)`, `putObject(key, body, contentType)` (per `phase-03-videos/TD-05`)
4. Exportar `StorageService` via `StorageModule` e importá-lo no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real — roundtrip multipart via URLs presignadas, presign GET funcional, content-disposition presente | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação DI | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — SDK e config; SI-03.2 — MinIO real para os testes de integração

**Acceptance criteria:**

- Upload multipart de um objeto pequeno com PUTs nas URLs presignadas completa com sucesso e o objeto existe no bucket
- URL presignada de GET responde 200 dentro da rede do Compose; com content-disposition solicitado, o query string contém `response-content-disposition`
- Após abort da sessão multipart, completá-la falha (sessão inexistente no storage)

---

### SI-03.5 — Endpoints de Upload (initiate, part-urls, complete, abort)

**Description:** Orquestra o ciclo de upload direto ao storage: pré-cadastro do vídeo como rascunho, URLs presignadas por parte, conclusão com enfileiramento do processamento e abort — a API nunca recebe os bytes do arquivo.

**Technical actions:**

1. Criar DTOs `src/videos/dto/create-video.dto.ts`, `src/videos/dto/part-urls.dto.ts` e `src/videos/dto/complete-upload.dto.ts` — validações conforme `### API Contracts → Validation Rules — Videos module`
2. Adicionar exceções de domínio em `src/common/exceptions/domain.exception.ts` — `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `UploadNotActiveException` (409 `UPLOAD_NOT_ACTIVE`), `UploadPartsMismatchException` (400 `UPLOAD_PARTS_MISMATCH`), `InvalidPartNumbersException` (400 `INVALID_PART_NUMBERS`) — mapeadas pelo `DomainExceptionFilter` herdado (per `### Error Catalog`)
3. Registrar BullMQ: `BullModule.forRootAsync` com connection da factory `queue.config` no `AppModule` e `BullModule.registerQueue({ name: 'video-processing' })` no `VideosModule` (per `phase-03-videos/TD-01` e `library-refs.md` § @nestjs/bullmq)
4. Implementar `src/videos/videos.service.ts` — `initiateUpload` (row `draft` + `public_id` com retry-on-collision + `original_key` `videos/{id}/original{ext}` + `CreateMultipartUpload` + `s3_upload_id`), `getPartUrls` (dono + estado `draft` + faixa `1..part_count`, lote ≤ 100), `completeUpload` (complete no storage → transição `draft→processing` + job `video.process` com `attempts: 3`, backoff exponencial 5000ms), `abortUpload` (abort no storage + delete do rascunho) — regras do `### API Contracts` e `phase-03-videos/TD-02`/`TD-08`
5. Implementar `src/videos/videos.controller.ts` — `POST /videos`, `POST /videos/:id/upload/part-urls`, `POST /videos/:id/upload/complete`, `DELETE /videos/:id/upload` com `@CurrentUser` (canal 1:1 do usuário) e anotações Swagger (convenção herdada `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: branches (mock de repo/storage/queue) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: DB+MinIO+Redis reais — initiate cria draft com sessão multipart; complete transiciona e enfileira | `src/videos/videos.service.integration-spec.ts` |
| upload endpoints | E2E: contratos, validação, auth, 404/409/400 | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.1, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` autenticado com payload válido retorna `201` com `public_id`, `status: "draft"` e `upload.part_count` = ceil(`file_size`/`part_size`)
- `POST /videos` com `file_size` acima de 10 GiB retorna `400` com `errorCode: "VALIDATION_ERROR"`
- `POST /videos/{id}/upload/part-urls` sobre vídeo de outro usuário retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
- `POST /videos/{id}/upload/complete` com as partes corretas retorna `200` com `status: "processing"` e um job `video.process` aparece na fila `video-processing`
- `complete` em vídeo que não está `draft` retorna `409` com `errorCode: "UPLOAD_NOT_ACTIVE"`
- `DELETE /videos/{id}/upload` retorna `204`, aborta a sessão no storage e remove o rascunho do banco
- Qualquer endpoint de upload sem token retorna `401`

---

### SI-03.6 — Worker de Vídeo (entrypoint, consumer e FFmpeg)

**Description:** Container dedicado que consome a fila, extrai duração/metadados com ffprobe, gera o thumbnail com ffmpeg e aplica as transições de status com retry e falha terminal persistida.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` — módulo standalone com `ConfigModule` global, `TypeOrmModule.forRootAsync` (mesma factory `databaseConfig` herdada), `BullModule.forRootAsync` (connection `queue.config`) e `StorageModule`; e `src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule)` com `enableShutdownHooks` (per `phase-03-videos/TD-03`)
2. Criar `src/worker/ffmpeg.service.ts` — `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', tmpFile])` para duração/metadata (width, height, codec, bitrate, fps, container) e `execFile('ffmpeg', ['-ss','1','-i', tmpFile,'-frames:v','1','-vf','scale=1280:-2','-y', outFile])` para o thumbnail JPEG, operando sobre arquivo temporário baixado via `StorageService.getObjectStream` e removendo os temporários ao final (per `phase-03-videos/TD-04`)
3. Criar `src/worker/video-processing.consumer.ts` — `@Processor('video-processing')` extends `WorkerHost`: carrega o vídeo, no-op se já `ready` (idempotência), processa via `FfmpegService`, sobe o thumbnail (`thumbnail_key` `videos/{id}/thumbnail.jpg`), persiste `duration_seconds`/`metadata`/`status='ready'`; `@OnWorkerEvent('failed')` na tentativa final persiste `status='failed'` + `failure_reason` (per `phase-03-videos/TD-08` e `library-refs.md` § bullmq)
4. Adicionar scripts `start:worker` (`nest start --entryFile worker/main`) e `start:worker:dev` (variante `--watch`) ao `package.json`
5. Adicionar serviço `video-worker` ao `compose.yaml` — mesmo build/imagem da API, command `npm run start:worker:dev`, `depends_on` `db`/`redis`/`minio` healthy (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Unit: idempotência, transições, falha terminal (deps mockadas) | `src/worker/video-processing.consumer.spec.ts` |
| `FfmpegService` | Integration: ffmpeg/ffprobe reais sobre fixture gerada via lavfi — duração, metadata, thumbnail JPEG válido | `src/worker/ffmpeg.service.integration-spec.ts` |
| `WorkerModule` | Unit: compilação DI | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.2 — ffmpeg na imagem, redis/minio de pé; SI-03.5 — contrato do job e producer

**Acceptance criteria:**

- Com a stack de pé, um vídeo `processing` com original no storage termina `ready` com `duration_seconds` correto (±1s), `metadata` contendo width/height/codec e `thumbnail_key` apontando para objeto JPEG existente no bucket
- Job cujo objeto original não existe no storage esgota as 3 tentativas e o vídeo termina `failed` com `failure_reason` preenchido
- Reprocessar um vídeo já `ready` não altera seus dados (no-op idempotente)
- `docker compose up -d` sobe o serviço `video-worker` consumindo a fila `video-processing`

---

### SI-03.7 — Endpoints de Entrega (status do dono, streaming, thumbnail e download)

**Description:** Expõe a leitura do dono e a entrega pública por `public_id` — streaming e thumbnail via redirect presignado (Range/206 nativo do storage) e download autenticado com content-disposition.

**Technical actions:**

1. Estender `src/videos/videos.service.ts` — `getOwnerVideo(id, userId)` (404 para inexistente ou de outro canal), `resolvePublicReady(publicId)` (404 quando não `ready`), `getStreamRedirect(publicId)` e `getThumbnailRedirect(publicId)` (presign GET TTL `PRESIGN_STREAM_TTL`), `getDownloadRedirect(publicId)` (presign GET TTL `PRESIGN_DOWNLOAD_TTL` com `attachment; filename="{file_name}"`) (per `phase-03-videos/TD-05` e Revision 2026-08-10)
2. Estender `src/videos/videos.controller.ts` — `GET /videos/:id` (dono), `GET /videos/:publicId/stream` e `GET /videos/:publicId/thumbnail` com `@Public()` respondendo `302` com `Location` presignada, `GET /videos/:publicId/download` autenticado respondendo `302` (matriz `### Authorization Matrix`)
3. Anotações Swagger dos quatro endpoints (302/404/401) (convenção herdada `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: branches de entrega (não-`ready`, não-dono, download disposition) | `src/videos/videos.service.spec.ts` (estender) |
| delivery endpoints | E2E: 302 com Location presignada; `Range` na Location responde 206; auth do download; 404s | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.4, SI-03.5 — service/controller base e presign

**Acceptance criteria:**

- `GET /videos/{publicId}/stream` anônimo de vídeo `ready` retorna `302` com `Location` presignada; `GET` na Location com `Range: bytes=0-99` retorna `206` com exatamente 100 bytes e `Content-Range`
- `GET /videos/{publicId}/stream` de vídeo `processing` retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
- `GET /videos/{publicId}/download` sem token retorna `401`; autenticado retorna `302` cuja `Location` contém `response-content-disposition=attachment` com o `file_name` original
- `GET /videos/{id}` do dono retorna o payload completo do `### API Contracts` (inclusive `status` e `failure_reason`); de outro usuário retorna `404`

---

### SI-03.8 — E2E do Pipeline Completo e Sincronização da Documentação

**Description:** Prova o fluxo integral com a infraestrutura real (upload multipart → processamento → entrega) e sincroniza a documentação de IA e a spec OpenAPI com o estado final do código.

**Technical actions:**

1. Criar `test/videos-pipeline.e2e-spec.ts` — fluxo integral com infra real: register/login → `POST /videos` → PUT das partes via URLs presignadas direto no MinIO (arquivo com ≥2 partes, `UPLOAD_PART_SIZE` reduzido via env no teste) → `complete` → worker (contexto `WorkerModule` iniciado no `beforeAll`) processa com ffmpeg real → polling de `GET /videos/:id` até `ready` → `stream` 302 + `Range` 206 → `download` autenticado; caso de falha: original ausente → vídeo termina `failed` com `failure_reason`
2. Atualizar `CLAUDE.md` (raiz) — Message Queue deixa de ser "TBD" (BullMQ + Redis), seção do módulo de vídeos (upload multipart presigned, worker FFmpeg, streaming 302→presigned com Range/206, download autenticado) — e `docs/diagrams/software-arch.mermaid` coerente com a stack real
3. Atualizar `nestjs-project/CLAUDE.md` — serviços novos do Compose (`minio`, `redis`, `createbuckets`, `video-worker`), comandos do worker, exigência da stack de pé para as suítes de integração/e2e
4. Regenerar `openapi.json` via `npm run openapi:export` (convenção herdada `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| pipeline completo | E2E: upload→processamento→entrega com MinIO/Redis/ffmpeg reais | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- O e2e do pipeline passa de ponta a ponta com a stack do Compose usando um arquivo real de ≥2 partes (a capacidade de 10GB é garantida pela arquitetura multipart, exercitada com fixture pequena)
- Após o fluxo, o vídeo está `ready` no banco com `duration_seconds`, `metadata` e `thumbnail_key` preenchidos e os objetos existem no bucket
- `CLAUDE.md` raiz e `nestjs-project/CLAUDE.md` descrevem exatamente os serviços, comandos e endpoints existentes (zero referências a artefatos inexistentes)
- `openapi.json` regenerado contém os oito endpoints de vídeos

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → channels.id, not null |
| title | varchar(255) | not null |
| description | text | nullable |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `'draft'` |
| public_id | varchar(11) | unique, not null |
| file_name | varchar(255) | not null |
| content_type | varchar(100) | not null |
| file_size | bigint | not null |
| original_key | varchar(512) | not null |
| thumbnail_key | varchar(512) | nullable |
| duration_seconds | int | nullable |
| metadata | jsonb | nullable |
| failure_reason | text | nullable |
| s3_upload_id | varchar(255) | nullable |
| created_at | timestamp | not null, default now() |
| updated_at | timestamp | not null, default now() |

**Relations:** `Video` many-to-one `Channel` (`Channel` has many `Video`; FK `channel_id`) — per phase-03-videos/TD capability "vídeos pertencem a um canal" (channels are 1:1 with users since Phase 02).
**Indexes:** unique on `public_id` (per phase-03-videos/TD-06); index on `channel_id`.

**Field semantics:**
- `public_id` — 11-char base62 identifier generated app-side via Node `crypto` with single-retry-on-collision against the unique constraint (per phase-03-videos/TD-06).
- `original_key` — storage key `videos/{id}/original{ext}`, set at upload initiate (per phase-03-videos/TD-07 single-bucket prefix layout).
- `thumbnail_key` — storage key `videos/{id}/thumbnail.jpg`, set by the worker after generation (per phase-03-videos/TD-04).
- `metadata` — ffprobe extract (width, height, codec, bitrate, fps, container) persisted as jsonb (per phase-03-videos/TD-04).
- `s3_upload_id` — S3 multipart session id, present only while `status = draft`; cleared on complete/abort (per phase-03-videos/TD-02).
- `failure_reason` — terminal processing failure message, set only when `status = failed` (per phase-03-videos/TD-08).

**Status lifecycle (per phase-03-videos/TD-08):** `draft` (initiate → parts uploading) → `processing` (complete-upload accepted, job enqueued) → `ready` (worker succeeded) | `failed` (worker exhausted retries; `failure_reason` set). No other transitions; reprocessing a `ready` video is a safe no-op.

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- title: string, required — 1 to 255 characters
- description: string, optional — max 5000 characters
- file_name: string, required — max 255 characters, extension must be one of `.mp4`, `.webm`, `.mov`, `.mkv`
- file_size: number, required — integer bytes, 1 to 10737418240 (10 GiB, per phase-03-videos/TD-02)
- content_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`

**Response 201:**
- id: string (uuid)
- public_id: string
- title: string
- status: string — `draft`
- upload: object — `part_size`: number (104857600 = 100 MiB, per phase-03-videos/TD-02), `part_count`: number (ceil(file_size / part_size))

**Error responses:**
- 400 validation error: when the request body fails schema validation (size/type/extension limits included)
- 401 UNAUTHORIZED: missing/invalid access token

---

#### POST /videos/{id}/upload/part-urls (SI-03.5)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- part_numbers: number[], required — non-empty, unique integers in `1..part_count`, max 100 per request

**Response 200:**
- urls: array of objects — `part_number`: number, `url`: string (presigned `UploadPart` URL, TTL 1h, signed against `S3_PUBLIC_ENDPOINT`, per phase-03-videos/TD-02 and TD-07), `expires_at`: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel
- 409 UPLOAD_NOT_ACTIVE: video is not in `draft` status
- 400 INVALID_PART_NUMBERS: part numbers out of range or batch larger than 100
- 400 validation error: malformed body
- 401 UNAUTHORIZED: missing/invalid access token

---

#### POST /videos/{id}/upload/complete (SI-03.5)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array, required — non-empty, objects `{ part_number: number, etag: string }` collected from each part PUT response

**Response 200:**
- id: string (uuid)
- public_id: string
- status: string — `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel
- 409 UPLOAD_NOT_ACTIVE: video is not in `draft` status
- 400 UPLOAD_PARTS_MISMATCH: storage rejected the part list (InvalidPart / InvalidPartOrder / EntityTooSmall)
- 400 validation error: malformed body
- 401 UNAUTHORIZED: missing/invalid access token

---

#### DELETE /videos/{id}/upload (SI-03.5)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content. Aborts the multipart session on storage and deletes the draft video row (undoes the pre-registration).

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel
- 409 UPLOAD_NOT_ACTIVE: video is not in `draft` status
- 401 UNAUTHORIZED: missing/invalid access token

---

#### GET /videos/{id} (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:** (owner view — any status)
- id: string (uuid)
- public_id: string
- title: string
- description: string | null
- status: string — `draft` | `processing` | `ready` | `failed`
- duration_seconds: number | null
- metadata: object | null
- failure_reason: string | null
- file_name: string
- file_size: number
- content_type: string
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel
- 401 UNAUTHORIZED: missing/invalid access token

---

#### GET /videos/{publicId}/stream (SI-03.7)

Public endpoint (`@Public()`), resolved by `public_id`.

**Response 302:** `Location` header = presigned `GetObject` URL for `original_key` (TTL 6h, signed against `S3_PUBLIC_ENDPOINT`, per phase-03-videos/TD-05 and TD-07). The player follows the redirect and issues `Range` requests directly against storage, which answers `206 Partial Content` natively — playback never requires the full download.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` does not exist or video is not `ready`

---

#### GET /videos/{publicId}/thumbnail (SI-03.7)

Public endpoint (`@Public()`), resolved by `public_id`.

**Response 302:** `Location` header = presigned `GetObject` URL for `thumbnail_key` (TTL 6h, per phase-03-videos/TD-05 delivery pattern).

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` does not exist or video is not `ready`

---

#### GET /videos/{publicId}/download (SI-03.7)

Authenticated endpoint (any logged-in user, per phase-03-videos/TD-05 Revision 2026-08-10), resolved by `public_id`.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:** `Location` header = presigned `GetObject` URL for `original_key` with `response-content-disposition: attachment; filename="{file_name}"` baked into the signature (TTL 15min, per phase-03-videos/TD-05).

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` does not exist or video is not `ready`
- 401 UNAUTHORIZED: missing/invalid access token

---

#### Validation Rules — Videos module

- `title`: required, string, 1–255 characters
- `description`: optional, string, max 5000 characters
- `file_name`: required, string, max 255 characters, extension ∈ {`.mp4`, `.webm`, `.mov`, `.mkv`}
- `file_size`: required, integer, 1 … 10737418240 (10 GiB)
- `content_type`: required, ∈ {`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`}
- `part_numbers`: required, non-empty array of unique integers ≥ 1, each ≤ the video's `part_count`, max 100 entries per request
- `parts`: required, non-empty array of `{ part_number: integer ≥ 1, etag: non-empty string }`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (creates in own channel) | — |
| POST /videos/{id}/upload/part-urls | ✗ | ✗ | ✓ |
| POST /videos/{id}/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/{id}/upload | ✗ | ✗ | ✓ |
| GET /videos/{id} | ✗ | ✗ | ✓ |
| GET /videos/{publicId}/stream | ✓ | ✓ | ✓ |
| GET /videos/{publicId}/thumbnail | ✓ | ✓ | ✓ |
| GET /videos/{publicId}/download | ✗ | ✓ | ✓ |

- **Owner** = authenticated user whose 1:1 channel owns the video (`video.channel_id = user.channel.id`). Owner-scoped operations return `404 VIDEO_NOT_FOUND` (not 403) for videos of other channels — existence is not leaked.
- The global JWT guard from Phase 02 protects everything by default; `stream` and `thumbnail` opt out via the existing `@Public()` decorator. `download` requires authentication but not ownership (per phase-03-videos/TD-05 Revision 2026-08-10).

### Error Catalog

Error response format inherited from Phase 02 (phase-02-auth/TD-07, via `DomainExceptionFilter`): `{ statusCode, error, message }`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `id`/`public_id` inexistente; vídeo de outro canal em operação de dono; ou vídeo não-`ready` em endpoint de entrega |
| UPLOAD_NOT_ACTIVE | 409 | part-urls/complete/abort em vídeo fora do status `draft` |
| UPLOAD_PARTS_MISMATCH | 400 | storage rejeitou a lista de partes no complete (InvalidPart / InvalidPartOrder / EntityTooSmall) |
| INVALID_PART_NUMBERS | 400 | `part_numbers` fora do intervalo `1..part_count` ou lote com mais de 100 entradas |
| VALIDATION_ERROR | 400 | corpo/parâmetros reprovados pelo `ValidationPipe` global (herdado da Fase 02) |
| UNAUTHORIZED | 401 | token ausente/inválido no guard global (herdado da Fase 02) |

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` via `@InjectQueue('video-processing')` — API container (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessingConsumer` (`@Processor('video-processing')` extending `WorkerHost`) — `video-worker` container only (per `phase-03-videos/TD-01` and `TD-03`)
**Trigger:** successful `CompleteMultipartUpload` — the video flips `draft → processing` and the job is added with `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (per `phase-03-videos/TD-08`)
**Delivery semantics:** at-least-once (BullMQ on Redis, `maxmemory-policy=noeviction`); the handler is idempotent — reprocessing an already-`ready` video is a safe no-op/overwrite; on final failure the worker persists `failed` + `failure_reason` and the job stays in the failed set for inspection (per `phase-03-videos/TD-08`)

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (bucket/credenciais alinhados entre .env e Compose)
│   └── SI-03.4 — depends on SI-03.1 + SI-03.2 (SDK/config + MinIO real para os testes)
│       └── SI-03.5 — depends on SI-03.1 + SI-03.3 + SI-03.4 (entidade + storage + fila)
│           ├── SI-03.6 — depends on SI-03.2 + SI-03.5 (ffmpeg/redis na infra + contrato do job)
│           └── SI-03.7 — depends on SI-03.4 + SI-03.5 (presign + service/controller base)
│               └── SI-03.8 — depends on SI-03.6 + SI-03.7 (fluxo integral + docs)
SI-03.3 (root, independente — entidade, migration e módulo base)
```

---

## Deliverables

- [ ] SI-03.1 — Dependências e Namespaces de Configuração (storage e fila)
- [ ] SI-03.2 — Infraestrutura no Compose: MinIO, Redis e FFmpeg
- [ ] SI-03.3 — Entidade Video, Migration e Módulo Base
- [ ] SI-03.4 — Módulo de Storage (clientes S3, presign e multipart)
- [ ] SI-03.5 — Endpoints de Upload (initiate, part-urls, complete, abort)
- [ ] SI-03.6 — Worker de Vídeo (entrypoint, consumer e FFmpeg)
- [ ] SI-03.7 — Endpoints de Entrega (status do dono, streaming, thumbnail e download)
- [ ] SI-03.8 — E2E do Pipeline Completo e Sincronização da Documentação

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec -T nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec -T nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec -T nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec -T nestjs-api npm run lint`)

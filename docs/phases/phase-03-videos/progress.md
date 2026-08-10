# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Dependências e Namespaces de Configuração (storage e fila)
- **Status:** completed
- **Tests:** 9 passing (env.validation.integration-spec)
- **Observations:**
  - `.env.example` tinha a linha `MAIL_FROM` sem aspas completas (quebrava o parser do Docker Compose — bug pré-existente documentado no CLAUDE.md do backend); normalizada para o formato quoted shell-safe junto com a adição das variáveis novas.

### SI-03.2 — Infraestrutura no Compose: MinIO, Redis e FFmpeg
- **Status:** completed
- **Tests:** no tests (Infra) — ACs verificados: minio/redis healthy, bucket criado, ffmpeg/ffprobe 5.1.9 na imagem
- **Observations:**
  - Healthcheck do MinIO usa `mc ready local` (o binário `mc` é embarcado na imagem do servidor; `curl` não é garantido nas imagens UBI recentes).

### SI-03.3 — Entidade Video, Migration e Módulo Base
- **Status:** completed
- **Tests:** 11 passing (entity integration, public-id unit, module compile, migrations estendida)
- **Observations:**
  - O `beforeAll` do `migrations.integration-spec.ts` dropava tabelas em `Promise.all`; com a FK `videos→channels` os DROPs concorrentes deadlockavam no Postgres. Corrigido para drops sequenciais em ordem FK-safe (fragilidade latente pré-existente, exposta pela nova FK).
  - `file_size` usa transformer bigint→number (10 GiB cabe com folga em Number.MAX_SAFE_INTEGER).

### SI-03.4 — Módulo de Storage (clientes S3, presign e multipart)
- **Status:** completed
- **Tests:** 6 passing (integração com MinIO real: multipart via presigned PUT, presign GET, content-disposition, abort; compiles de StorageModule e VideosModule)
- **Observations:**
  - `videos.module.spec` passou a exigir `ConfigModule.forRoot` global no test module (VideosModule importa StorageModule que injeta `storageConfig.KEY`) — conforme regra de testes do projeto.

### SI-03.5 — Endpoints de Upload (initiate, part-urls, complete, abort)
- **Status:** completed
- **Tests:** 30 passing (unit do service com mocks; integração com DB+MinIO+Redis reais; e2e do fluxo completo com PUT presignado direto no storage)
- **Observations:**
  - BullMQ 6 tornou o client Redis um peer opcional (bring-your-own): `ioredis@^5` instalado como dependência explícita, complemento mecânico da escolha de TD-01 (registrado também no library-refs.md).
  - `findByUserId` adicionado ao `ChannelsService` (lookup do canal 1:1 pertence ao domínio de channels), via `dataSource.getRepository` para não alterar o construtor coberto pelo spec existente.
  - `ChannelNotFoundException` (404) adicionada para o caso defensivo de usuário sem canal.

### SI-03.6 — Worker de Vídeo (entrypoint, consumer e FFmpeg)
- **Status:** completed
- **Tests:** 9 passing (unit do consumer com idempotência/falha terminal; integração com ffmpeg/ffprobe reais sobre fixture lavfi; compile do WorkerModule) + serviço `video-worker` de pé no Compose
- **Observations:**
  - O DataSource do worker usa lista explícita de entidades `[Video, Channel, User]` — `autoLoadEntities` só registra o que algum `forFeature` importa, e a relação `Video#channel` exigia o fecho transitivo (o TypeORM ficava em retry loop parecendo hang).
  - `worker.module.spec` precisa de `module.init()` antes de `close()` para os shutdown hooks fecharem a conexão bloqueante do Worker BullMQ.
  - Fixture de vídeo gerada em runtime via `ffmpeg -f lavfi testsrc` no teste (nenhum binário commitado).

### SI-03.7 — Endpoints de Entrega (status do dono, streaming, thumbnail e download)
- **Status:** completed
- **Tests:** 24 passing (19 unit do service com branches de entrega; 5 e2e — 302 presignado, Range/206 real no MinIO, thumbnail público, download autenticado com content-disposition, visão do dono vs 404 para terceiros)
- **Observations:**
  - `file_name` é sanitizado (aspas removidas) antes de entrar no header `content-disposition` do presign.

### SI-03.8 — E2E do Pipeline Completo e Sincronização da Documentação
- **Status:** completed
- **Tests:** 2 passing (pipeline integral: upload multipart real ≥2 partes → worker do Compose processa com ffmpeg → ready → stream Range/206 byte-idêntico → thumbnail → download; caminho de falha → failed com failure_reason)
- **Observations:**
  - Fixture do pipeline usa MJPEG (`-q:v 2`): x264 comprime conteúdo sintético abaixo de qualquer alvo de bitrate e não atingia os 5 MiB mínimos de parte; MJPEG garante tamanho multi-parte com vídeo válido.
  - O spec reduz `UPLOAD_PART_SIZE` para 5 MiB via env no topo do arquivo — exercita o caminho multi-parte sem um arquivo de 100 MiB.
  - CLAUDE.md raiz (fila Redis+BullMQ, seção Videos Module), nestjs-project/CLAUDE.md (serviços novos, comandos do worker, requisito de stack para e2e), software-arch.mermaid e openapi.json sincronizados com o código real.

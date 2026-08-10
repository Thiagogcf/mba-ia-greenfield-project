# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/8 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoints de Upload (initiate, part-urls, complete, abort)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Worker de Vídeo (entrypoint, consumer e FFmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoints de Entrega (status do dono, streaming, thumbnail e download)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — E2E do Pipeline Completo e Sincronização da Documentação
- **Status:** pending
- **Tests:** —
- **Observations:** none

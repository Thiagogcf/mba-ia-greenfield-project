# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (Redis + BullMQ) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos Module (Phase 03)

Video upload and processing live in `nestjs-project/src/videos/` (HTTP module), `nestjs-project/src/storage/` (S3-compatible object storage boundary) and `nestjs-project/src/worker/` (standalone queue consumer, same codebase, separate `video-worker` container).

- **Upload (up to 10GB, direct-to-storage):** the file bytes never pass through the API. `POST /videos` pre-registers the video as a `draft` in the user's channel and opens an S3 multipart session; `POST /videos/:id/upload/part-urls` returns presigned part URLs (100 MiB parts by default) that the client PUTs directly against MinIO/S3; `POST /videos/:id/upload/complete` finishes the multipart upload with the collected ETags, flips the video to `processing` and enqueues a `video.process` job; `DELETE /videos/:id/upload` aborts the session and deletes the draft.
- **Processing:** the `video-worker` container consumes the `video-processing` BullMQ queue (Redis), downloads the original, extracts duration/metadata with `ffprobe`, generates a JPEG thumbnail with `ffmpeg` (both installed in the Docker image), uploads the thumbnail and marks the video `ready`. Jobs run with 3 attempts and exponential backoff; on terminal failure the video is marked `failed` with `failure_reason` persisted. Handlers are idempotent.
- **Status lifecycle:** `draft → processing → ready | failed` (enum `videos_status_enum` on the `videos` table, FK to `channels`).
- **Unique URL:** every video gets an 11-char base62 `public_id` (crypto-generated, `UNIQUE` column, retry on collision) — the public identity used by delivery endpoints.
- **Delivery:** `GET /videos/:publicId/stream` and `GET /videos/:publicId/thumbnail` are public and answer `302` redirects to short-lived presigned storage URLs (players issue `Range` requests directly against storage, which serves `206 Partial Content`); `GET /videos/:publicId/download` requires authentication and bakes `content-disposition: attachment` into the presigned URL; `GET /videos/:id` is the owner view (any status). Delivery only exposes `ready` videos — everything else is a `404`.
- **Presign strategy:** two S3 clients — internal operations use `S3_ENDPOINT` (`http://minio:9000`); presigned URLs are signed against `S3_PUBLIC_ENDPOINT` (the host the client actually reaches; SigV4 covers the host).

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.
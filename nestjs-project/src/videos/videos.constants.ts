export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

export const VIDEO_PROCESS_JOB = 'video.process' as const;

export const VIDEO_PROCESS_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
} as const;

export const VIDEO_ALLOWED_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export const VIDEO_ALLOWED_EXTENSIONS_PATTERN = /\.(mp4|webm|mov|mkv)$/i;

export const VIDEO_MAX_FILE_SIZE_BYTES = 10737418240 as const;

export const VIDEO_PART_URLS_BATCH_LIMIT = 100 as const;

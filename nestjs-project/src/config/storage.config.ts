import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET || 'streamtube-media',
  uploadPartSize: parseInt(process.env.UPLOAD_PART_SIZE || '104857600', 10),
  uploadMaxFileSize: parseInt(
    process.env.UPLOAD_MAX_FILE_SIZE || '10737418240',
    10,
  ),
  presignPartTtl: parseInt(process.env.PRESIGN_PART_TTL || '3600', 10),
  presignStreamTtl: parseInt(process.env.PRESIGN_STREAM_TTL || '21600', 10),
  presignDownloadTtl: parseInt(process.env.PRESIGN_DOWNLOAD_TTL || '900', 10),
}));

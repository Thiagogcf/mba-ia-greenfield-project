import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration — real MinIO)', () => {
  let service: StorageService;
  const runId = `${Date.now()}`;

  beforeAll(() => {
    service = new StorageService(storageConfig());
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  async function collectStream(
    stream: NodeJS.ReadableStream,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  it('should complete a multipart upload through presigned part URLs', async () => {
    const key = `test/${runId}/multipart.bin`;
    const payload = Buffer.alloc(1024, 7);

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(uploadId).toEqual(expect.any(String));

    const partUrl = await service.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: payload,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { part_number: 1, etag: etag! },
    ]);

    const stored = await collectStream(await service.getObjectStream(key));
    expect(stored.length).toBe(payload.length);
    expect(stored.equals(payload)).toBe(true);
  });

  it('should serve objects through a presigned GET url', async () => {
    const key = `test/${runId}/presign-get.txt`;
    const payload = Buffer.from('streamtube presign test');
    await service.putObject(key, payload, 'text/plain');

    const url = await service.presignGetObject(key, 60);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(payload)).toBe(
      true,
    );
  });

  it('should bake content-disposition into the presigned GET url', async () => {
    const key = `test/${runId}/disposition.bin`;
    await service.putObject(key, Buffer.from('x'), 'application/octet-stream');

    const url = await service.presignGetObject(
      key,
      60,
      'attachment; filename="video.mp4"',
    );
    expect(url).toContain('response-content-disposition=');

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(
      'attachment',
    );
  });

  it('should abort a multipart upload so it cannot be completed', async () => {
    const key = `test/${runId}/aborted.bin`;
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await service.abortMultipartUpload(key, uploadId);

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { part_number: 1, etag: '"whatever"' },
      ]),
    ).rejects.toThrow();
  });
});

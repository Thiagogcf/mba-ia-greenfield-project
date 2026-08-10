import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

describe('FfmpegService (integration — real ffmpeg/ffprobe)', () => {
  const service = new FfmpegService();

  async function generateFixture(dir: string): Promise<string> {
    const fixturePath = join(dir, 'fixture.mp4');
    await execFileAsync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=30',
      '-pix_fmt',
      'yuv420p',
      '-y',
      fixturePath,
    ]);
    return fixturePath;
  }

  it('probes duration and stream metadata from a real file', async () => {
    await service.withTempDir(async (dir) => {
      const fixturePath = await generateFixture(dir);

      const probe = await service.probe(fixturePath);

      expect(probe.durationSeconds).toBeGreaterThanOrEqual(1);
      expect(probe.durationSeconds).toBeLessThanOrEqual(3);
      expect(probe.metadata.width).toBe(320);
      expect(probe.metadata.height).toBe(240);
      expect(probe.metadata.codec).toBeTruthy();
      expect(String(probe.metadata.container)).toContain('mp4');
      expect(probe.metadata.fps).toBe(30);
    });
  });

  it('generates a JPEG thumbnail from a frame of the video', async () => {
    await service.withTempDir(async (dir) => {
      const fixturePath = await generateFixture(dir);

      const thumbnail = await service.generateThumbnail(
        fixturePath,
        join(dir, 'thumbnail.jpg'),
      );

      expect(thumbnail.length).toBeGreaterThan(1000);
      expect(thumbnail[0]).toBe(0xff);
      expect(thumbnail[1]).toBe(0xd8);
    });
  });

  it('fails loudly when the input file is not a video', async () => {
    await service.withTempDir(async (dir) => {
      const bogusPath = join(dir, 'bogus.mp4');
      await execFileAsync('sh', ['-c', `echo "not a video" > ${bogusPath}`]);

      await expect(service.probe(bogusPath)).rejects.toThrow();
    });
  });
});

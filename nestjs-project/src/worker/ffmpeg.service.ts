import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VideoProbeResult {
  durationSeconds: number;
  metadata: Record<string, unknown>;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
  }>;
}

function parseFrameRate(avgFrameRate: string | undefined): number | null {
  if (!avgFrameRate) return null;
  const [numerator, denominator] = avgFrameRate.split('/').map(Number);
  if (!numerator || !denominator) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}

@Injectable()
export class FfmpegService {
  async withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'video-processing-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async saveStreamToFile(stream: Readable, filePath: string): Promise<void> {
    await pipeline(stream, createWriteStream(filePath));
  }

  async probe(filePath: string): Promise<VideoProbeResult> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    const probe = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = probe.streams?.find(
      (stream) => stream.codec_type === 'video',
    );

    return {
      durationSeconds: Math.round(parseFloat(probe.format?.duration ?? '0')),
      metadata: {
        width: videoStream?.width ?? null,
        height: videoStream?.height ?? null,
        codec: videoStream?.codec_name ?? null,
        container: probe.format?.format_name ?? null,
        bitrate: probe.format?.bit_rate
          ? parseInt(probe.format.bit_rate, 10)
          : null,
        fps: parseFrameRate(videoStream?.avg_frame_rate),
      },
    };
  }

  async generateThumbnail(
    inputPath: string,
    outputPath: string,
  ): Promise<Buffer> {
    await execFileAsync('ffmpeg', [
      '-ss',
      '1',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=1280:-2',
      '-y',
      outputPath,
    ]);
    return readFile(outputPath);
  }
}

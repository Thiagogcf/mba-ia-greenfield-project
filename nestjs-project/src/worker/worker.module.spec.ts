import { Test } from '@nestjs/testing';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with queue consumer, ffmpeg and storage wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init();

    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);
    expect(module.get(VideoProcessingConsumer)).toBeInstanceOf(
      VideoProcessingConsumer,
    );
    await module.close();
  }, 30000);
});

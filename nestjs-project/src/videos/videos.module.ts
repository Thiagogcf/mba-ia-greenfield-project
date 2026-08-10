import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule],
})
export class VideosModule {}

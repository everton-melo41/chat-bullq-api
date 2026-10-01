import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { redisProvider, REDIS_CLIENT_TOKEN } from './redis.provider';
import { ShortTermMemoryService } from './short-term.service';

/**
 * Short-term memory module — Redis-backed working memory for AI agents.
 *
 * Exports `ShortTermMemoryService` so the agent runner (and any other
 * orchestrator) can read/write the per-conversation message cache.
 */
@Module({
  imports: [ConfigModule],
  providers: [redisProvider, ShortTermMemoryService],
  exports: [ShortTermMemoryService, REDIS_CLIENT_TOKEN],
})
export class ShortTermMemoryModule {}

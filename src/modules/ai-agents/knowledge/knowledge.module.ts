import { Module } from '@nestjs/common';
import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaModule } from '../../../database/prisma.module';
import { RagModule } from '../rag/rag.module';
import { KnowledgeService } from './knowledge.service';

@Processor('knowledge-index')
export class KnowledgeProcessor extends WorkerHost {
  constructor(private readonly knowledge: KnowledgeService) { super(); }
  process(job: Job<{ id: string; organizationId: string }>) { return this.knowledge.index(job.data.id, job.data.organizationId); }
}
@Module({ imports: [PrismaModule, RagModule, BullModule.registerQueue({ name: 'knowledge-index' })], providers: [KnowledgeService, KnowledgeProcessor], exports: [KnowledgeService] })
export class KnowledgeModule {}

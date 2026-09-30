import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Returns the list of WORKER agents the current ORCHESTRATOR can delegate to.
 * Each entry includes name, category and capabilities so the orchestrator can
 * pick the right specialist based on what the customer needs.
 */
@Injectable()
export class ListAvailableAgentsTool implements AiTool {
  readonly name = 'listAvailableAgents';
  readonly description =
    'Lista os agentes especialistas (workers) disponíveis para receber a delegação. Use ANTES de decidir pra quem encaminhar — assim você compara as capacidades e categorias antes de chamar delegateToAgent.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {},
  };

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    _input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const workers = await this.prisma.aiAgent.findMany({
      where: {
        organizationId: ctx.organizationId,
        kind: 'WORKER',
        isActive: true,
        publishedRevisionId: { not: null },
        deletedAt: null,
        id: { not: ctx.agentId },
      },
      select: {
        id: true,
        name: true,
        category: true,
        description: true,
        capabilities: true,
      },
      orderBy: { name: 'asc' },
    });

    return {
      output: {
        agents: workers.map((w) => ({
          agentId: w.id,
          name: w.name,
          category: w.category,
          description: w.description,
          capabilities: w.capabilities,
        })),
      },
    };
  }
}

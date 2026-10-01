import { Injectable } from '@nestjs/common';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { knowledgeBinding } from '../../knowledge/knowledge.binding';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
@Injectable()
export class SearchKnowledgeTool implements AiTool {
  readonly name = 'searchKnowledge';
  readonly description = knowledgeBinding.definition.description;
  readonly parameters = knowledgeBinding.definition.parameters;
  constructor(private readonly knowledge: KnowledgeService) {}
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return { output: await this.knowledge.search(ctx.organizationId, ctx.agentId, input.pergunta) };
  }
}

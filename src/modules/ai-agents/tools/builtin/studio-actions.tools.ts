import { Injectable } from '@nestjs/common';
import { AiTool, ToolContext } from '../tool.types';
import { StudioActionsService } from './studio-actions.service';

const string = { type: 'string', minLength: 1 };
@Injectable()
export class AddTagTool implements AiTool {
  readonly name = 'addTag';
  readonly description = 'Adiciona uma etiqueta existente à conversa. Prefira tagId; aceita name existente.';
  readonly parameters = { type: 'object', additionalProperties: false, properties: { tagId: string, name: string }, anyOf: [{ required: ['tagId'] }, { required: ['name'] }] };
  constructor(private readonly actions: StudioActionsService) {}
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    return this.actions.execute(this.name, input, ctx);
  }
}

@Injectable()
export class CreateInternalSummaryTool implements AiTool {
  readonly name = 'createInternalSummary';
  readonly description = 'Cria uma nota interna com resumo, identificada como gerada por IA.';
  readonly parameters = { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { ...string, maxLength: 10000 } } };
  constructor(private readonly actions: StudioActionsService) {}
  execute(input: Record<string, unknown>, ctx: ToolContext) { return this.actions.execute(this.name, input, ctx); }
}

@Injectable()
export class UpdateContactFieldsTool implements AiTool {
  readonly name = 'updateContactFields';
  readonly description = 'Atualiza nome, e-mail e dados permitidos do contato; CPF validado e dataNascimento em YYYY-MM-DD.';
  readonly parameters = { type: 'object', additionalProperties: false, required: ['fields'], properties: { fields: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['name', 'email', 'cpf', 'dataNascimento', 'cidade', 'uf', 'profissao', 'beneficioPretendido', 'observacoes'].map(k => [k, string])) } } };
  constructor(private readonly actions: StudioActionsService) {}
  execute(input: Record<string, unknown>, ctx: ToolContext) { return this.actions.execute(this.name, input, ctx); }
}

@Injectable()
export class MovePipelineCardTool implements AiTool {
  readonly name = 'movePipelineCard';
  readonly description = 'Move o card da conversa para uma etapa do pipeline; cria o card se ainda não existir.';
  readonly parameters = { type: 'object', additionalProperties: false, required: ['pipelineId', 'stageId'], properties: { pipelineId: string, stageId: string } };
  constructor(private readonly actions: StudioActionsService) {}
  execute(input: Record<string, unknown>, ctx: ToolContext) { return this.actions.execute(this.name, input, ctx); }
}

@Injectable()
export class AssignConversationTool implements AiTool {
  readonly name = 'assignConversation';
  readonly description = 'Atribui a conversa a um usuário com acesso ao canal OU a um departamento global/do mesmo canal.';
  readonly parameters = { type: 'object', additionalProperties: false, properties: { userId: string, departmentId: string }, oneOf: [{ required: ['userId'] }, { required: ['departmentId'] }] };
  constructor(private readonly actions: StudioActionsService) {}
  execute(input: Record<string, unknown>, ctx: ToolContext) { return this.actions.execute(this.name, input, ctx); }
}

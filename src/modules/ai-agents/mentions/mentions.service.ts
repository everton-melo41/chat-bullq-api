import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { LlmToolDefinition } from '../llm/llm.types';

/**
 * Menções no prompt (estilo LíderHub): o operador escreve
 * `@[Auxílio-doença](agent:<id>)` e o sistema transforma cada menção numa
 * ferramenta VINCULADA ao registro. O modelo só decide QUANDO chamar; o id
 * nunca passa pelo modelo, então ele não consegue trocar o destino.
 */
export type MentionType = 'agent' | 'tag' | 'department' | 'stage' | 'action';

export const MENTION_ACTIONS: Record<string, { label: string; description: string }> = {
  summary: { label: 'resumo', description: 'Gera um resumo da conversa como nota interna para a equipe.' },
  savedata: { label: 'salvar dados do lead', description: 'Salva dados informados pelo lead no cadastro (nome, e-mail, CPF, data de nascimento, cidade, UF, profissão, benefício pretendido, observações).' },
  disableai: { label: 'desativar IA', description: 'Desliga a IA nesta conversa; a equipe assume.' },
  human: { label: 'transferir para humano', description: 'Transfere para atendimento humano com o motivo.' },
};

const MENTION_RE = /@\[([^\]\n]{1,80})\]\((agent|tag|department|stage|action):([A-Za-z0-9_-]{1,64})\)/g;

export interface ParsedMention { label: string; type: MentionType; id: string; raw: string }

export interface MentionBinding {
  /** Nome da ferramenta exposta ao modelo. */
  toolName: string;
  /** Built-in executada de verdade, ou 'disableAi' (tratada pelo runner). */
  builtin: string;
  /** Argumentos fixos, sempre sobrepostos aos que o modelo mandar. */
  fixedArgs: Record<string, unknown>;
  definition: LlmToolDefinition;
}

export interface CompiledMentions {
  text: string;
  bindings: MentionBinding[];
  invalid: ParsedMention[];
}

export function parseMentions(prompt: string): ParsedMention[] {
  return [...(prompt ?? '').matchAll(MENTION_RE)].map(m => ({ raw: m[0], label: m[1].trim(), type: m[2] as MentionType, id: m[3] }));
}

function slug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'item';
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const text = (description: string, maxLength = 500) => ({ type: 'string', description, minLength: 1, maxLength });

@Injectable()
export class MentionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Valida e compila as menções de um prompt para a organização. */
  async compile(organizationId: string, prompt: string): Promise<CompiledMentions> {
    const mentions = parseMentions(prompt);
    if (!mentions.length) return { text: prompt ?? '', bindings: [], invalid: [] };
    const ids = (t: MentionType) => [...new Set(mentions.filter(m => m.type === t).map(m => m.id))];
    const [agents, tags, departments, stages] = await Promise.all([
      this.prisma.aiAgent.findMany({ where: { id: { in: ids('agent') }, organizationId, deletedAt: null, isActive: true, publishedRevisionId: { not: null } }, select: { id: true, name: true } }),
      this.prisma.tag.findMany({ where: { id: { in: ids('tag') }, organizationId }, select: { id: true, name: true } }),
      this.prisma.department.findMany({ where: { id: { in: ids('department') }, organizationId }, select: { id: true, name: true } }),
      this.prisma.pipelineStage.findMany({ where: { id: { in: ids('stage') }, pipeline: { organizationId } }, select: { id: true, name: true, pipelineId: true } }),
    ]);
    const found = {
      agent: new Map(agents.map(a => [a.id, a])),
      tag: new Map(tags.map(t => [t.id, t])),
      department: new Map(departments.map(d => [d.id, d])),
      stage: new Map(stages.map(s => [s.id, s])),
    };

    const invalid: ParsedMention[] = [];
    const bindings = new Map<string, MentionBinding>();
    let out = prompt;
    for (const m of mentions) {
      const binding = this.bind(m, found);
      if (!binding) { invalid.push(m); out = out.split(m.raw).join(m.label); continue; }
      bindings.set(binding.toolName, binding);
      out = out.split(m.raw).join(`${m.label} (ferramenta ${binding.toolName})`);
    }
    return { text: out, bindings: [...bindings.values()], invalid };
  }

  private bind(m: ParsedMention, found: {
    agent: Map<string, { id: string; name: string }>; tag: Map<string, { id: string; name: string }>;
    department: Map<string, { id: string; name: string }>; stage: Map<string, { id: string; name: string; pipelineId: string }>;
  }): MentionBinding | null {
    const make = (toolName: string, builtin: string, fixedArgs: Record<string, unknown>, description: string, parameters: Record<string, unknown>): MentionBinding =>
      ({ toolName, builtin, fixedArgs, definition: { name: toolName, description, parameters } });
    switch (m.type) {
      case 'agent': {
        const a = found.agent.get(m.id); if (!a) return null;
        return make(`passar_para_${slug(a.name)}`, 'handoffToAgent', { agentId: a.id },
          `Passa a conversa para o agente "${a.name}". Use quando o prompt indicar. Não responda ao cliente antes.`,
          obj({ motivo: text('Por que está passando a conversa.', 300), briefing: text('Resumo do que já foi coletado, para o próximo agente.', 4000) }, ['motivo', 'briefing']));
      }
      case 'tag': {
        const t = found.tag.get(m.id); if (!t) return null;
        return make(`etiqueta_${slug(t.name)}`, 'addTag', { tagId: t.id }, `Aplica a etiqueta "${t.name}" à conversa.`, obj());
      }
      case 'department': {
        const d = found.department.get(m.id); if (!d) return null;
        return make(`departamento_${slug(d.name)}`, 'assignConversation', { departmentId: d.id }, `Encaminha a conversa para o departamento "${d.name}".`, obj());
      }
      case 'stage': {
        const s = found.stage.get(m.id); if (!s) return null;
        return make(`etapa_${slug(s.name)}`, 'movePipelineCard', { pipelineId: s.pipelineId, stageId: s.id }, `Move a conversa para a etapa "${s.name}" do funil.`, obj());
      }
      case 'action': {
        const a = MENTION_ACTIONS[m.id]; if (!a) return null;
        if (m.id === 'summary') return make('resumo', 'createInternalSummary', {}, a.description, obj({ content: text('Resumo objetivo para a equipe.', 10000) }, ['content']));
        if (m.id === 'savedata') {
          const fields = Object.fromEntries(['name', 'email', 'cpf', 'dataNascimento', 'cidade', 'uf', 'profissao', 'beneficioPretendido', 'observacoes'].map(k => [k, { type: 'string' }]));
          return make('salvar_dados', 'updateContactFields', {}, a.description, obj({ fields: { type: 'object', additionalProperties: false, properties: fields } }, ['fields']));
        }
        if (m.id === 'disableai') return make('desativar_ia', 'disableAi', {}, a.description, obj({ motivo: text('Motivo, visível para a equipe.', 300) }, ['motivo']));
        if (m.id === 'human') return make('transferir_humano', 'transferToHuman', {}, a.description, obj({ reason: text('Motivo, visível para a equipe.', 500), summary: text('Resumo da conversa.', 4000) }, ['reason']));
        return null;
      }
    }
  }

  /** Opções para o autocomplete do editor. */
  async options(organizationId: string) {
    const [agents, tags, departments, stages] = await Promise.all([
      this.prisma.aiAgent.findMany({ where: { organizationId, deletedAt: null }, select: { id: true, name: true, publishedRevisionId: true }, orderBy: { name: 'asc' } }),
      this.prisma.tag.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.department.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.pipelineStage.findMany({ where: { pipeline: { organizationId } }, select: { id: true, name: true, pipeline: { select: { name: true } } }, orderBy: { order: 'asc' } }),
    ]);
    return [
      ...agents.map(a => ({ type: 'agent', id: a.id, label: a.name, hint: a.publishedRevisionId ? 'agente' : 'agente (não publicado)' })),
      ...tags.map(t => ({ type: 'tag', id: t.id, label: t.name, hint: 'etiqueta' })),
      ...departments.map(d => ({ type: 'department', id: d.id, label: d.name, hint: 'departamento' })),
      ...stages.map(s => ({ type: 'stage', id: s.id, label: s.name, hint: `etapa · ${s.pipeline.name}` })),
      ...Object.entries(MENTION_ACTIONS).map(([id, a]) => ({ type: 'action', id, label: a.label, hint: 'ação' })),
    ];
  }
}

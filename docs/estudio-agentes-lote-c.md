# Estúdio de agentes — lote C

## Grupos e canais

- `prisma/schema.prisma` e `prisma/migrations/20260930190000_agent_groups/migration.sql`: grupos por organização, membros ordenados, agente inicial, vínculo opcional do canal e campos do handoff/pergunta de entrada.
- `src/modules/ai-agents/groups/`: API `GET/POST /ai-agent-groups` e `PUT /ai-agent-groups/:id`. Escritas exigem OWNER/ADMIN. O inicial precisa ser membro; todos os membros pertencem à organização. A lista `memberIds` determina a ordem.
- `src/modules/channel-hub/channels/`: `PATCH /channels/:id` aceita `aiAgentGroupId`, inclusive `null` para desvincular; valida organização do grupo.
- `src/modules/ai-agents/router/agent-router.service.ts`: mantém agente ativo; conversa sem agente usa o inicial do grupo antes do classificador. Inicial indisponível não cai em agente externo. Sem grupo, o roteamento legado permanece.

## Handoff e perguntas

- `src/modules/ai-agents/tools/builtin/handoff-to-agent.tool.ts`: `handoffToAgent(agentId, motivo, briefing, entryQuestion?)`. Confere origem/destino no grupo do canal, organização, atividade, publicação e `enabledBuiltinTools` da revisão fixada no run.
- `agents/agent-snapshot.ts`, DTO de criação e `revisions.service.ts`: `entryQuestion` é versionada. A pergunta padrão vem da revisão **publicada do destino**, nunca do rascunho. Pergunta vazia usa o padrão; sem padrão o destino inicia imediatamente.
- `runner/prompt-builder.service.ts`: lê o último handoff dirigido ao agente atual, com a seção **Contexto recebido do agente anterior**, briefing e indicação da pergunta já feita.
- `runner/agent-runner.service.ts`: aguarda toda a continuação no mesmo mutex. Pergunta enviada interrompe a cadeia; retry do inbound anterior não inicia o destino. Ações posteriores ao handoff no mesmo lote são bloqueadas. Ferramentas legadas de delegação/retorno ficam indisponíveis em canais com grupo.
- O handoff e sua única mensagem são persistidos atomicamente. Retry reutiliza registro e jobId. Falha ao enfileirar a pergunta pausa IA e cria nota para humano.

## Limites

Máximo de 5 transferências por conversa em 30 minutos e 3 transferências por inbound. Uma inversão A → B → A é permitida; nova inversão do mesmo par dentro da janela é bloqueada. Ao atingir limites, a IA é pausada e uma nota interna indica o motivo. A retomada cabe à operação após revisar a cadeia.

O `running` do processador continua ocupado até finalizar a cadeia; o runner usa `IdempotencyService.withLock` para serializar também execuções do watchdog e entre processos. A opção de renovação mantém o lease durante a execução.

## Web (`../chat-bullq-web`)

- `src/features/ai-agents/components/agent-groups.tsx` e `services/agent-groups.service.ts`: criar/editar grupos, ordenar/adicionar/remover membros, escolher inicial e vincular/desvincular canais em `/ai-agents?tab=groups`.
- `src/features/ai-agents/components/edit-agent-dialog.tsx`: pergunta de entrada e lista “Pode passar para” por grupo, com disponibilidade dos membros.
- `src/features/channels/components/edit-channel-dialog.tsx`: seleção do grupo do canal.

## Ativação e pendências operacionais

1. Revisar e aplicar a migration manual no ambiente apropriado. **Não foi aplicada neste trabalho**; não foi executado `prisma migrate`.
2. Agentes existentes com allowlist explícita precisam habilitar `handoffToAgent` no editor e publicar uma revisão. As permissões existentes não são ampliadas automaticamente. Novos agentes incluem a ação na seleção padrão.
3. Publicar e ativar os agentes, criar grupo com inicial e vincular o canal. Grupos podem ser preparados com membros não publicados, mas estes não recebem atendimento.
4. Validar o fluxo real Triagem → Saúde → Renda, os dois modos de transição e o envio pelo provedor. Não houve acesso a rede, banco ou Docker; a interface e integração real não foram exercitadas.

Validação local: `npx prisma generate`, `npm run typecheck`, `npx jest --runInBand` na API e `npx tsc --noEmit` no web. Testes novos cobrem isolamento do grupo/organização, roteamento legado, publicação/permissões, briefing no prompt, pergunta única, retry, limites, mutex e continuação. Nenhum commit realizado.

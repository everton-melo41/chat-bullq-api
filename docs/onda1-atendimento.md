# Onda 1 — atendimento

Implementada nos repositórios `chat-bullq-api` e `chat-bullq-web`, na branch
`feat/onda1-atendimento`, sem commits.

## 1. Modelo padrão Fugu

Novos agentes usam `sakana/fugu`. Os seletores de criação e edição explicam a
latência de Fugu e Fugu Ultra. Não há atualização de agentes persistidos.

API:
- `src/modules/ai-agents/llm/llm.constants.ts`
- `src/modules/social-comments/social-comments.service.spec.ts`

Web:
- `src/features/ai-agents/services/ai-agents.service.ts`
- `src/features/ai-agents/components/create-agent-dialog.tsx`
- `src/features/ai-agents/components/edit-agent-dialog.tsx`

## 2. Agrupamento durável de mensagens

`AGENT_DEBOUNCE_MS=18000` e `AGENT_DEBOUNCE_AUDIO_MS=25000`. Não existe campo de
debounce adequado em `AiAgent`, portanto a configuração fica somente nas envs.
Cada conversa usa um job BullMQ com ID fixo sem `:`. Um mutex Redis serializa a
substituição do job pendente e sua transição de estado. Prazos pendentes não
expiram durante uma parada do worker. A guarda de execução e `followupNeeded`
foram mantidas, com prazo de follow-up também salvo no Redis.

Áudios bloqueiam a execução até a transcrição terminar ou falhar. O prazo de
áudio é publicado antes de liberar esse bloqueio. Texto posterior não encurta
o prazo de áudio. Não há detecção de presença/gravação.

O runner combina o histórico recente com todas as mensagens inbound desde a
última resposta enviada, sem cortar uma sequência maior que 30 mensagens. O
prompt preserva transcrição e legenda inclusive quando `content.text` é vazio.

Para evitar perder uma mensagem na corrida entre finalização e novo inbound,
o worker estaciona o job ocioso por 24h sob o mesmo mutex de agendamento. Um novo
inbound substitui esse job imediatamente. Acordar sem prazo pendente não executa
IA. Isso mantém um job atrasado por conversa que já teve agendamento; não usa
`setTimeout` para o debounce.

API:
- `.env.example`
- `src/modules/messaging/pipeline/inbound-message.processor.ts`
- `src/modules/messaging/pipeline/inbound-message.processor.spec.ts`
- `src/modules/messaging/pipeline/agent-debounce.spec.ts`
- `src/modules/ai-agents/runner/agent-runner.service.ts`
- `src/modules/ai-agents/runner/prompt-builder.service.ts`

## 3. Departamentos por número

`Department.channelId` é opcional; null mantém o departamento geral compatível.
`Channel.defaultDepartmentId` só aceita departamento ativo do próprio canal.
Novas conversas recebem esse padrão. Conversas existentes não são movidas.
Transferências aceitam departamentos gerais ou do mesmo canal. O roteador
automático também respeita essa regra.

Inclusão e remoção de membros sincronizam `ChannelAgent` em transação. A remoção
mantém acesso enquanto houver outra associação ativa a departamento do mesmo
canal. Alterar o vínculo de um departamento sincroniza seus membros e limpa o
padrão antigo; vínculos incompatíveis com suas conversas existentes são recusados.

API:
- `prisma/schema.prisma`
- `prisma/migrations/20260930150000_onda1_departments_by_channel/migration.sql`
- `src/modules/channel-hub/channels/channels.service.ts`
- `src/modules/channel-hub/channels/dto/update-channel.dto.ts`
- `src/modules/channel-hub/channels/channels.onda1.spec.ts`
- `src/modules/messaging/pipeline/conversation-resolver.service.ts`
- `src/modules/messaging/pipeline/conversation-resolver.onda1.spec.ts`
- `src/modules/messaging/conversations/conversations.service.ts`
- `src/modules/messaging/conversations/conversations.onda1.spec.ts`
- `src/modules/routing/router.service.ts`
- `src/modules/routing/router.service.spec.ts`
- `src/modules/routing/departments/departments.service.ts`
- `src/modules/routing/departments/departments.repository.ts`
- `src/modules/routing/departments/dto/create-department.dto.ts`
- `src/modules/routing/departments/dto/update-department.dto.ts`
- `src/modules/routing/departments/departments.onda1.spec.ts`

Web:
- `src/features/channels/services/channels.service.ts`
- `src/features/channels/components/edit-channel-dialog.tsx`
- `src/features/departments/services/departments.service.ts`
- `src/app/(dashboard)/settings/departments/page.tsx`
- `src/app/(dashboard)/settings/layout.tsx`
- `src/features/inbox/services/inbox.service.ts`
- `src/features/inbox/components/conversation-details-panel.tsx`

## 4. Notas internas

Endpoints `GET/POST /conversations/:id/notes` e
`DELETE /conversations/:id/notes/:noteId`. Os três reutilizam a checagem de
organização e acesso ao canal. A exclusão filtra também pelo autor autenticado.
O evento `note:changed` é emitido somente para `conv:<id>`; o cliente refaz a
consulta autorizada. Notas não criam `Message` nem entram na fila outbound.

O chat oferece um modo amarelo com cadeado e “visível só para a equipe”, com
rascunho separado. As notas aparecem intercaladas por data, com autor e exclusão
da própria nota. Também podem ser usadas em conversas encerradas.

API:
- `src/modules/messaging/conversations/conversations.controller.ts`
- `src/modules/messaging/conversations/conversations.service.ts`
- `src/modules/messaging/conversations/dto/create-internal-note.dto.ts`
- `src/modules/messaging/conversations/conversations.onda1.spec.ts`

Web:
- `src/features/inbox/services/inbox.service.ts`
- `src/features/inbox/components/chat-input.tsx`
- `src/features/inbox/components/chat-panel.tsx`
- `src/features/inbox/components/internal-note-card.tsx`
- `src/features/inbox/components/conversation-details-panel.tsx`

## 5. Painel lateral

Painel direito recolhível para conversas individuais: contato e edição do nome,
canal, departamento compatível, responsável, IA, tags, pipelines/etapas e notas.
Reutiliza os serviços existentes, `AssignmentPopover`, `ConversationAiToggle` e
`PipelinePopover`. Não adiciona endpoints duplicados.

Web:
- `src/features/inbox/components/conversation-details-panel.tsx`
- `src/features/inbox/components/chat-panel.tsx`
- `src/features/inbox/services/inbox.service.ts`

## 6. Template em conversa aberta e janela de 24h

O caminho `POST /messages` já aceita `TEMPLATE`, e o mapper oficial já envia o
payload como template. Foi reutilizado sem novo endpoint. O seletor consulta a
mesma lista de templates aprovados da abertura de conversa e compartilha a
montagem de variáveis de corpo.

A listagem de mensagens passou a retornar `lastInboundAt`, independente da
paginação. O web combina essa data com mensagens recebidas pelo socket e atualiza
a verificação a cada 30 segundos. Fora da janela, bloqueia texto livre e mídias e
oferece template; notas internas continuam disponíveis. A restrição se aplica
apenas ao WhatsApp Oficial.

API:
- `src/modules/messaging/messages/messages.service.ts`
- `src/modules/messaging/messages/messages.onda1.spec.ts`

Web:
- `src/features/inbox/services/template-utils.ts`
- `src/features/inbox/services/inbox.service.ts`
- `src/features/inbox/components/conversation-template-picker.tsx`
- `src/features/inbox/components/new-conversation-dialog.tsx`
- `src/features/inbox/components/chat-input.tsx`
- `src/features/inbox/components/chat-panel.tsx`

## Validação e limites

Executado localmente, usando dependências já instaladas:
- API: `npx prisma generate` — passou.
- API: `npm run typecheck` — passou.
- API: `npx jest --runInBand` — 25 suítes, 176 testes passaram.
- Web: `npx tsc --noEmit` — passou.
- `git diff --check` nos dois repositórios — passou.

A migration foi escrita manualmente e **não aplicada**. Não foram executados
`prisma migrate dev/deploy`, banco, Redis real, Docker, chamadas de rede, envio ao
WhatsApp, browser/E2E ou commits. Os testes de debounce usam doubles de fila/Redis
e chamadas reais dos métodos de contexto/prompt, sem serviços externos.

Ficaram de fora: override por agente (não existe campo adequado e a regra permite
somente env), aplicação da migration e validação de integração/UI com serviços
reais. Nenhum dos seis itens funcionais foi adiado.

Alterações locais anteriores foram preservadas: `yarn.lock`,
`prisma/migrations/20260923214436_chat_bullq/` e `chat-bullq-web/next-env.d.ts`.

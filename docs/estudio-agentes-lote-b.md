# Estúdio de Agentes — Lote B

## Contrato e compatibilidade

`PATCH /ai-agents/:id` continua aceitando os campos anteriores, mas **salva no rascunho**. Não altera o comportamento publicado. A resposta contém os campos publicados e as relações `draftRevision` / `publishedRevision`; para editar, sobreponha `draftRevision.snapshot` aos campos do agente. `PUT /ai-agents/:id/draft` devolve a revisão salva.

- `GET /ai-agents/:id/revisions`: revisões em ordem decrescente de versão.
- `PUT /ai-agents/:id/draft`: cria ou atualiza o único DRAFT. Aceita campos parciais do agente, `enabledBuiltinTools` e `skills: [{ skillId, requiresApproval }]`.
- `POST /ai-agents/:id/publish`, corpo `{ "note": "opcional" }`: publica o rascunho, arquiva a publicação anterior e atualiza os campos/vínculos materializados do agente atomicamente.
- `POST /ai-agents/:id/revisions/:version/restore`: copia uma versão publicada/arquivada para um novo DRAFT, substituindo eventual rascunho; nunca publica automaticamente.
- `GET /ai-agents/:id/revisions/diff?from=1&to=2`: `lines` com `added`, `removed`, `context` e `fields` com `field`, `before`, `after`.

Mutações exigem OWNER/ADMIN; todas as operações verificam organização e agente não excluído. Escritas são serializadas com `SELECT ... FOR UPDATE` no agente. Índices parciais garantem no máximo um DRAFT e um PUBLISHED; `(agent_id, version)` é único. O rascunho reserva a próxima versão; salvamentos repetidos não incrementam. A publicação seguinte usa vN+1.

Agentes novos nascem com rascunho v1 e só participam do runtime após publicar. Agentes existentes recebem v1 publicada pela migration. `createdById` identifica o criador do rascunho; no preenchimento histórico é nulo, pois o autor não é conhecido.

O snapshot inclui prompt, contexto e data de atualização, modelo/parâmetros, `kind` (papel/role), capacidades, identidade, hierarquia, configurações de resposta/follow-up, ações habilitadas e vínculos de skills com aprovação. O runner fixa uma revisão publicada para toda a execução, passa seus dados ao prompt-builder/model-router/registry e registra `AiAgentRun.revisionId`. Uma publicação concorrente não troca a revisão de uma execução já iniciada. Conteúdo das skills continua no catálogo; o versionamento do agente captura os **vínculos**, não clona o catálogo.

Os endpoints legados de atribuição de skills e aprovação também salvam no rascunho. Mudanças de canais e exclusão continuam operações administrativas imediatas.

## Ações

`enabledBuiltinTools: null` mantém a disponibilidade anterior (restrições de kind e allowlist continuam aplicadas). `[]` desabilita todas as built-ins. A lista é aplicada à exposição ao modelo, ao dispatch e ao envio automático de resposta textual. O armazenamento usa JSONB nullable porque listas escalares opcionais não são suportadas pelo Prisma; a API valida `string[] | null`.

Novos agentes recebem as ações gerais, sem `lookupOffering`, `checkBonusEligibility`, `checkMembersAccess`, client-ops e recuperação específica. O catálogo `GET /ai-agents/:id/built-in-actions` continua mostrando todas as ações elegíveis, inclusive desmarcadas, para permitir reabilitá-las.

## Arquivos e validação

1. Revisões: `prisma/schema.prisma`, `prisma/migrations/20260930180000_agent_revisions/migration.sql`, `agents/agent-snapshot.ts`, `agents/revisions.service.ts`, `agents/agents.service.ts`, `agents/agents.controller.ts`, DTOs, módulo e serviços/controllers do catálogo de skills.
2. Runtime e ações: `runner/agent-runner.service.ts`, `router/agent-router.service.ts`, `tools/tool-registry.service.ts`, `tools/tool.types.ts`, `tools/http-tool-executor.service.ts`, built-ins de listagem/delegação.
3. Web: `services/ai-agents.service.ts`, `components/edit-agent-dialog.tsx`, `components/create-agent-dialog.tsx`, `components/agents-list.tsx`, todos sob `src/features/ai-agents/`.
4. Jest: `agents/revisions.service.spec.ts`, `runner/agent-revisions.spec.ts`, `tools/tool-registry.spec.ts`. Os testes usam mocks, sem banco ou rede.

Na API, caminhos de módulos acima são relativos a `src/modules/ai-agents/`.

A migration foi escrita manualmente e não aplicada. Usa `gen_random_uuid()::text`, já utilizado em `20260501140801_add_channel_agents`; nenhuma extensão adicional foi instalada. Validação com banco/migration e teste visual integrado ficam para um ambiente autorizado. Comandos locais: `npx prisma generate`, `npm run typecheck`, `npx jest` na API e `npx tsc --noEmit` na web.

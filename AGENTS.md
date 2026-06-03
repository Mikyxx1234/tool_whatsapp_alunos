# AGENTS.md — convenções e decisões técnicas

Este arquivo é a fonte de verdade para decisões estruturais do projeto.
Subagentes devem consultar antes de questionar/refazer escolhas já avaliadas.

## Decisões técnicas

### 02/06/2026 — Breakdown por ciclo em Conversão, CAA Daily, CAA Funil e Disparador

- **Modelo usado:** Opus 4.7 (principal) decidiu + implementou diretamente (Executor foi interrompido pelo usuário no meio da tarefa; trabalho parcial estava em commits intermediários que o Opus auditou e completou).
- **Problema:** A separação por ciclo existia apenas em `MatriculadosComparisonPanel` (`/reports` card matriculados). Demais relatórios (Conversão, CAA Daily, CAA Funil) e o Disparador não diferenciavam 2026/1 de 2026/2 — relevante porque Graduação e Pós viram ciclo em datas distintas (ex.: Pós ainda em 2026/1 enquanto Graduação já em 2026/2). Contagens agregadas escondiam essa diferença.
- **Decisão:**
  1. **Helper compartilhado** `server/services/cicloResolverService.js` com cache TTL 5min:
     - `getRgmToCicloMap(): Promise<Map<rgm, ciclo>>` — indexa o snapshot mais recente de matriculados.
     - `getAvailableCiclos(): Promise<string[]>` — lista ordenada desc lexicográfico.
     - `rgmFromMasterKey(masterKey)` e `masterKeysForCiclo(map, ciclo)` — helpers de transformação.
     - `bustCicloCache()` chamado em `routes/baseUploads.js` ao subir snapshot de matriculados.
  2. **Endpoints aceitam `?ciclo=<valor>` e sempre retornam `available_ciclos` + dados por ciclo:**
     - `/api/reports/activation-conversion` → `kpis_by_ciclo: Record<ciclo, kpis>` (sempre presente quando há >1 ciclo). Filtro específico: aplica `master_key = ANY(...)` derivado do `cicloMap`.
     - `/api/reports/caa/summary` → `summary_by_ciclo: Record<ciclo, { transitions }>`. Filtra in-memory cruzando `caa_protocols.rgm` com map.
     - `/api/reports/caa/funnel` → `counts_by_ciclo: Record<ciclo, counts>`. Mesma estratégia in-memory.
     - `/api/activation/list/:category` → `counts_by_ciclo: Record<ciclo, number>` — calculado sobre `rows` cacheado, **antes** dos filtros de stage/subgrupo/ciclo. Garante que contagens visíveis no header não se alteram com filtros locais.
  3. **UI segue padrão `MatriculadosComparisonPanel`:**
     - Dropdown `<select>` "Ciclo: Todos / 2026/2 / 2026/1" no header de cada painel — só aparece quando `available_ciclos.length > 1`.
     - Modo "Todos": número principal + mini-badges abaixo com breakdown por ciclo.
     - Modo "ciclo específico": números/listas recalculados pra esse ciclo, badges escondidos.
     - **Disparador (roster):** linha de texto "Por ciclo: 2026/2: X · 2026/1: Y" **sempre visível** acima dos chips de filtro (mostra total real independente do filtro ativo).
- **Onde (arquivos modificados):**
  - Backend: `cicloResolverService.js` (NOVO), `activationConversionService.js`, `caaProtocolsService.js`, `caaFunnelService.js`, `activationService.js`, `routes/reports.js`, `routes/baseUploads.js`.
  - Frontend: `reportApi.ts`, `activationApi.ts` (types), `ActivationConversionPage.tsx` (KpiCard com `cicloBreakdown`), `CaaDailyPanel.tsx` (helpers `pickTransition`/`buildBreakdown` reativos ao filtro), `CaaFunnelPanel.tsx` (dropdown + badges nos 6 estado cards), `ActivationRosterTable.tsx` (estado `countsByCiclo` + linha "Por ciclo:").
- **Default seguro:** Sem snapshot matriculados → cache vazio, `available_ciclos = []`, dropdown não aparece, comportamento idêntico ao anterior. Sem ciclo válido para um RGM → não conta em nenhum breakdown (mas continua na agregada).
- **Escopo conhecido (não implementado nesta iteração):** No CAA Daily, o filtro de ciclo afeta apenas os 4 KPIs do topo. A tabela de transições e os chips "Estado atual da base CAA" continuam agregados (backend não recebe filtro de ciclo nesses fluxos). Iterar quando houver demanda real.

#### Estratégia in-memory vs JOIN no banco

Optou-se por **filtragem in-memory** (cruzando `master_key/rgm` com o `cicloMap` carregado uma vez por query) em vez de JOIN com tabela temporária:
- ✅ Cache compartilhado entre as 3 queries de um mesmo painel (TTL 5min cobre a janela típica de navegação).
- ✅ Não precisa criar nem manter tabela `rgm_ciclo` no banco — fonte continua sendo o JSON do snapshot.
- ✅ Filtragem por ciclo via `master_key = ANY($N)` é eficiente em PostgreSQL com índice em `master_key`.
- ❌ Carrega map completo em memória (28k RGMs × ~10 bytes = ~280KB — negligível).

#### Alternativas descartadas

- **Layout side-by-side com 2 colunas de cards** (proposta original do usuário): 4 KPIs × 2 ciclos = 8 cards no Conversão, 6 cards × 2 = 12 no Funil — visualmente poluído. O padrão do MatriculadosComparison (número principal + badges abaixo) entrega a mesma informação com menos ruído e o usuário já validou esse padrão na decisão de 29/05.
- **Persistir ciclo em coluna nova de `activation_dispatch_events`:** acoplaria registros históricos ao snapshot atual de matriculados — se o ciclo de um aluno mudasse, o histórico ficaria errado. Lookup on-the-fly via snapshot vigente é mais consistente conceitualmente.
- **JOIN com tabela temporária `rgm_ciclo`:** mais "puro" SQL mas exige sincronização extra e cleanup. Filtragem in-memory é mais simples pro volume atual (~28k RGMs).
- **Cache de ciclo por TTL maior (ex.: 30min):** matriculados pode ser reimportado várias vezes ao dia em operação ativa; 5min equilibra performance × frescor.
- **Cache pré-aquecido no boot:** não vale a complexidade — primeira request paga ~1s, depois fica em cache.

### 02/06/2026 — Sync de desfechos CAA via CRM (remove input manual)

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Problema:** O painel de desfecho manual (decisão 28/05) exigia que o consultor abrisse a app, preenchesse um modal e subisse print. Na prática, o consultor já registrava o desfecho no CRM DataCrazy diretamente — dois registros paralelos, divergentes e com fricção.
- **Decisão:** Substituir o fluxo de input manual por **polling automático de um campo CRM**. O consultor preenche o campo `DATACRAZY_DESFECHO_CAA_FIELD_ID` no lead com `"Sim"` (matrícula revertida) ou `"Não"` (cancelamento confirmado). A app lê esse campo, cria a entrada em `activation_manual_outcomes` e limpa o campo (handshake).
- **Escopo da remoção:** Página `/desfechos-manuais`, modal `ManualOutcomeModal`, hook `useConsultor`, `manualOutcomesApi.ts`, rota `/api/manual-outcomes`, serviço `manualOutcomesService.js`, link "Desfechos" no header, rota em `App.tsx`, botão "Desfecho" no roster CAA e no funil CAA.
- **O que continua:** Repositório `manualOutcomesRepository.js` (agora escrito pelo sync, lido pelo `caaFunnelService`). Tabela `activation_manual_outcomes` inalterada. A coluna "Desfecho manual" no funil CAA continua mostrando o valor — agora preenchido pelo sync.
- **Mapeamento de valores:**
  - `"Sim"` → `outcome = 'revertido'`
  - `"Não"` / `"Nao"` (case-insensitive) → `outcome = 'confirmado'`
  - Qualquer outro valor → ignorado (auditoria em `crm_desfecho_sync_log`)
- **Envs:**
  - `DATACRAZY_DESFECHO_CAA_FIELD_ID` — UUID do campo no CRM (sem esse env o sync é no-op com aviso).
  - `CRM_DESFECHO_SYNC_LOOKBACK_DAYS` — janela de lookback (default 14 dias).
  - `CRM_DESFECHO_SYNC_INTERVAL_HOURS` — intervalo do cron interno (default 2h).
- **Rate-limit:** reutiliza `datacrazyCrmLimiter` (10/s) extraído para `server/utils/datacrazyCrmLimiter.js` (compartilhado com cleanup de `origem_ativacao`).
- **Onde:**
  - Migration `023_crm_desfecho_sync_log.sql` — tabela de auditoria do sync.
  - `server/utils/datacrazyCrmLimiter.js` (NOVO) — singleton extraído do cleanup service.
  - `server/services/activationOrigemCleanupService.js` — refatorado para importar do módulo compartilhado.
  - `server/services/datacrazyClient.js` — nova função `getLeadAdditionalFieldValue(leadId, fieldId)`.
  - `server/repositories/activationDispatchRepository.js` — nova função `listRecentDispatchedLeadsForCategory(category, days)`.
  - `server/repositories/manualOutcomesRepository.js` — novas funções `deleteByRgmAndCategory` e `createFromCrm`.
  - `server/services/crmDesfechoSyncService.js` (NOVO) — orquestra o sync, retorna resultado.
  - `server/routes/maintenance.js` — endpoint `POST /api/maintenance/sync-crm-desfechos`.
  - `server/index.js` — remove rota manual-outcomes, adiciona cron do sync.
  - `src/services/maintenanceApi.ts` — novo método `syncCrmDesfechos` e tipo `SyncCrmDesfechosResponse`.
  - `src/pages/JourneyRulesPage.tsx` — card "Sync de desfechos CAA do CRM" no scope GLOBAL.
  - `src/components/Header.tsx`, `src/App.tsx` — remoção de rota/link.
  - `src/components/ActivationRosterTable.tsx`, `src/components/CaaFunnelPanel.tsx` — remoção de botão e modal.

#### Alternativas descartadas

- **n8n webhook disparando quando o campo é preenchido:** exigiria configuração de automação no DataCrazy para cada campo, mais frágil que polling periódico.
- **Preservar input manual junto com o sync:** dois caminhos paralelos gerando entradas divergentes; dados de fonte dupla confundem o funil. O CRM é a fonte de verdade.
- **Polling de todos os leads do CRM (sem filtrar por dispatched):** caro e sem contexto — só faz sentido verificar leads que realmente foram ativados. `listRecentDispatchedLeadsForCategory` filtra por `status='sent'` na janela de lookback.
- **Limitar lookback ao cooldown CAA (6h):** muito curto; consultor pode demorar dias para registrar. 14 dias cobre bem sem custo excessivo de GETs no CRM.
- **Rate-limit separado para o sync:** descartado em favor do singleton compartilhado — ambos chamam o mesmo CRM, o teto de 10/s é global.

### 02/06/2026 — Limpeza proativa de `origem_ativacao` stale + filtro defensivo de respostas

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Problema:** O handshake n8n (decisão 01/06) só limpa `origem_ativacao` no CRM se a pessoa **responder**. Quem nunca responde fica com o campo preenchido pra sempre — e qualquer mensagem futura (3 meses, 6 meses depois) dispara o webhook e vira falso-positivo em `activation_responses`.
- **Decisão (tripé):**
  1. **Cleanup ativo** — job que limpa leads com `origem_ativacao` SET há mais de N horas (default 72h, configurável em `/journey-rules`). Lê de `activation_origem_ativacao_log` os SETs sem CLEAR posterior + `created_at < now() - interval Nh`. Pra cada, PUT `value=""` no CRM e registra um CLEAR no log (auditoria + idempotência).
  2. **2 caminhos de execução do cleanup:**
     - **Endpoint `POST /api/maintenance/clean-stale-origem-ativacao`** (protegido por `requireApiKey`) — agendável via n8n Schedule Trigger.
     - **Cron interno** — `setInterval` no boot do server (a cada 24h). Backup defensivo caso o n8n caia.
  3. **Filtro defensivo na leitura de respostas** — toda query que conta/exibe respostas faz `INNER JOIN activation_dispatch_events` exigindo um `sent` para a mesma `master_key`/`category` nas últimas N horas antes do `received_at`. Mesma N do cleanup (vem de `journey_settings.origem_ativacao_stale_hours`). Respostas "órfãs" continuam no DB (auditoria) mas não contam em painel de Conversão nem no `ResponseBadge` do roster.
- **Config:** novo campo `origem_ativacao_stale_hours integer default 72 check (between 1 and 8760)` em `journey_settings` (scope GLOBAL), editável em `/journey-rules` em um card novo.
- **Onde:**
  - Migration `022_origem_ativacao_settings.sql` (campo novo).
  - `server/repositories/journeySettingsRepository.js` (FIELDS + ALLOWED).
  - `server/repositories/activationOrigemRepository.js` — nova função `listStaleSetEntries(hours)`.
  - `server/services/activationOrigemCleanupService.js` (NOVO) — orquestra cleanup, retorna `{ scanned, cleaned, failed, errors }`.
  - `server/services/datacrazyClient.js` — função `clearOrigemAtivacaoForLead(leadId)` (PUT value=""), se ainda não existir.
  - `server/routes/maintenance.js` (NOVO) — endpoint + `requireApiKey`.
  - `server/index.js` — registra rota + `setInterval(cleanupService.run, 24h)` no boot.
  - `server/repositories/activationResponseRepository.js` — modifica `findLastByMasterKeys` com JOIN/filtro de dispatch recente.
  - `server/services/activationConversionService.js` — aplica filtro em todas as métricas (KPIs, by_category, top_buttons, recent_responses).
  - `src/services/journeySettingsApi.ts` — campo novo.
  - `src/pages/JourneyRulesPage.tsx` — card "Limpeza de origem_ativacao (CRM)" com input numérico.
- **Default seguro:** 72h cobre janela CAA (48h) + folga; categorias não-CAA têm sobra confortável. Cron 24h evita explosão de PUTs no CRM.

#### Alternativas descartadas

- **Limpar a tabela `activation_responses` (deletar registros stale):** descartado. Os registros são auditoria. Filtro em query é reversível e não destrói dado.
- **Webhook na app pra interceptar e validar antes de gravar:** quebra a decisão arquitetural de 22/05 (n8n grava direto, app só lê). Cleanup ativo + filtro defensivo resolve sem essa migração.
- **Cleanup só via endpoint (sem cron interno):** se n8n cair, fica acumulando. Cron interno é backup barato.
- **Janela diferente pra cleanup e pra filtro:** confunde — se limpamos em 72h, responder após 72h é stale por definição. Usar mesma config.
- **Janela hard-coded no env (sem UI):** decisão 29/05 abriu precedente — config de operação vai pra `journey_settings` + `/journey-rules` (escala melhor que env).
- **Categoria nova `aguardando-inicio` no CHECK do log de origem:** fora de escopo desta iteração; bug latente conhecido (CHECK na tabela `activation_origem_ativacao_log` não inclui `aguardando-inicio`). Anotar pra próxima migration.

#### Extensão (02/06/2026) — Botão manual + rate-limit do CRM

- **Botão na UI:** card "Limpeza de origem_ativacao" em `/journey-rules` ganhou 2 botões:
  - **Simular (dry-run)** → `POST /api/maintenance/clean-stale-origem-ativacao?dry_run=true` (não chama CRM, só conta o que seria limpo).
  - **Limpar agora** → mesmo endpoint sem `dry_run`. Confirm dialog antes de disparar.
  - Painel de resultado mostra: encontrados, limpos, falhas, janela, taxa CRM, ran_at + lista expansível dos erros.
- **Rate-limit CRM:** `activationOrigemCleanupService.js` ganhou um `createRateLimiter` singleton (default 10/s, configurável via `DATACRAZY_CRM_RATE_PER_SECOND`). `await datacrazyCrmLimiter.acquire()` antes de cada PUT pro CRM DataCrazy. Default conservador — DataCrazy não publica limite oficial; 10/s evita rajada e mantém cleanup tolerável (1.000 leads stale → ~100s).
- **Onde:**
  - `server/services/activationOrigemCleanupService.js` — `datacrazyCrmLimiter` + `acquire()` antes do PUT + `crm_rate_per_second` no retorno.
  - `src/services/maintenanceApi.ts` (NOVO) — client TS com `apiAuthHeaders()`.
  - `src/pages/JourneyRulesPage.tsx` — botões + painel de resultado.

##### Alternativas descartadas (extensão)

- **Sem confirm dialog:** botão escarlate sem confirmação é arriscado — Limpeza apaga centenas de campos no CRM real.
- **Rate-limit no `datacrazyClient` (global):** afetaria também `searchLeads` / `paginateAll` que já têm seus próprios pacings (`pageDelay`). Limitar só na cleanup mantém o resto inalterado.
- **Botão na página `/manutenção` separada:** página dedicada de manutenção não existe ainda; pra 1 botão, criar uma página é overhead. Colocar no card já existente é coeso.

### 02/06/2026 — Rate-limit Meta WhatsApp (cap rígido por segundo)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** O dispatcher de ativação (`runDatacrazyActivationBatch`) não tinha nenhuma garantia estrutural de respeitar limites da Meta. Único pacing era o `ACTIVATION_SEND_DELAY_MS` (default 400ms = ~2,5/s) — útil mas frágil: se alguém zerar o env, paralelizar o dispatcher, ou se a Meta apertar o limite, o código não avisa. Risco real de derrubar qualidade do número WABA ou ser banido em lotes grandes (ex.: 4.600 inadimplentes).
- **Decisão:** Adicionar um **rate limiter de janela deslizante** singleton no módulo, com cap rígido por segundo (default 60/s, configurável via `WHATSAPP_MAX_SENDS_PER_SECOND`). `await whatsappSendLimiter.acquire()` antes de cada `messagingProvider.sendTemplateMessage`. Default 60/s é abaixo do limite Cloud API da Meta (80/s) com margem de segurança.
- **Onde:**
  - `server/utils/rateLimiter.js`: novo helper `createRateLimiter(maxPerWindow, windowMs)` — janela deslizante in-memory.
  - `server/services/activationService.js`: singleton `whatsappSendLimiter` no top-level; `await whatsappSendLimiter.acquire()` antes do envio dentro do loop.
- **Comportamento mantido:** `ACTIVATION_SEND_DELAY_MS=400` (default) continua valendo — o limiter é puramente defensivo. Para acelerar (ex.: lotes grandes em WABA tier 4/5), setar `ACTIVATION_SEND_DELAY_MS=0` e o limiter garante teto de 60/s. Em tier 4 (100k/24h), 60/s permite drenar 100k em ~28min sem risco.
- **Limitação conhecida:** estado in-memory, válido para 1 processo Node. Se houver múltiplos workers no futuro, migrar para Redis/Postgres.

#### Alternativas descartadas

- **Reduzir `ACTIVATION_SEND_DELAY_MS` para 17ms (= 60/s evenly distributed):** mais simples, mas não tem garantia de teto se algum envio for instantâneo (cache local). Sliding-window é mais robusto.
- **Token bucket clássico:** funcionalmente equivalente para esse caso (não precisamos de "burst"); sliding-window é mais fácil de raciocinar e suficiente.
- **Cap diário por categoria/global:** considerado, mas tier 4 (100k/24h) deixa folga suficiente para o volume atual; cap por segundo basta. Adicionar cap diário em fase futura se for útil.
- **Quality monitoring via API Meta Business (Green/Yellow/Red):** valor agregado, mas exige integração nova; pode entrar em iteração posterior se a operação crescer.

### 02/06/2026 — Coluna "Janela" no roster CAA (tempo restante 48h)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** O roster CAA não mostrava ao consultor quanto tempo ainda restava da janela de 48h por candidato. A informação existia no `caaFunnelService` (estoque/funil) mas ficava escondida lá. Sem isso, o consultor não conseguia priorizar quem atender primeiro.
- **Decisão:** Adicionar coluna nova "Janela" no `ActivationRosterTable` (somente categoria `processos-caa`), mostrando o tempo restante até a janela vencer, com badge colorido por urgência. Cálculo do `hours_remaining` é feito no frontend a partir do `expires_at` (timestamp absoluto vindo do backend), garantindo que o número sempre reflita o "agora", mesmo com o cache do backend ativo.
- **Onde:**
  - `server/services/activationService.js`: `import { calcJanela }` adicionado; após o loop de items, novo bloco específico para CAA carrega `listOpenProtocolsByRgm` + `journey_settings`, calcula `{ t0, expires_at }` via `calcJanela`, anexa `caa_janela: { t0, expires_at, t0_source, dias_tipo }` (ISO strings) em cada item. Sort atualizado: CAA ordena por `expires_at` ascendente (mais urgente no topo).
  - `src/services/activationApi.ts`: novo tipo `CaaJanelaInfo` + campo opcional em `ActivationRosterItem`.
  - `src/components/ActivationRosterTable.tsx`: novo componente `CaaJanelaCell` + coluna "Janela" no `<thead>` (CAA only) entre os filtros condicionais e "Vezes ativado".
- **Faixas de cor:** Verde ≥12h (formato `14h` ou `2d` se ≥48h) · Âmbar 6–12h · Vermelho <6h (mostra minutos se <1h: `42min`) · Cinza "Vencida" ou "sem janela" (sem T0).
- **Tooltip:** mostra fonte do T0 (Data Chegada / 1º export / 1º envio), tipo de contagem (corridos/úteis), T0 e data de vencimento formatados.

#### Alternativas descartadas

- **Computar `hours_remaining` no backend e cachear o número:** ficaria preso ao TTL do cache (10min), badge ficaria "frozen" em valor antigo. Solução adotada (cachear `expires_at` absoluto, computar horas no frontend) é mais simples e sempre fresca.
- **Badge inline no nome em vez de coluna:** o usuário pediu coluna explicitamente. Coluna deixa o dado tabular e ordenável.
- **Chips de contagem no header ("X vencendo em 6h · Y em <1h"):** considerado, mas escopo MVP é coluna; adicionar depois se houver demanda.
- **Querry separada para listar TODOS protocolos abertos (sem dedup por RGM):** descartado em favor de reusar `listOpenProtocolsByRgm` (mesma usada pra montar a fila). Pessoas com >1 protocolo aberto verão a janela do "mais recentemente mudado" — caso raro, custo de erro baixo, evolui depois.

### 02/06/2026 — Remoção do dedup por template (`template_ja_enviado`)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Mesmo com o cooldown novo (decisão abaixo), a pessoa continuava sendo bloqueada permanentemente por uma segunda barreira no `runDatacrazyActivationBatch`: `wasTemplateSentInCategory(category, master_key, template_name)`. Essa função consultava `activation_dispatch_events` sem janela temporal e marcava `skipped: template_ja_enviado` se aquele **nome de template específico** já tivesse sido enviado uma vez. Na prática — como quase nenhuma categoria tem 3 templates distintos por tier (1ª/Reativação/5ª) — o sistema resolvia o mesmo nome (`caa_cancelamento`) pra todos os tiers e o segundo filtro virava bloqueio permanente disfarçado de "dedup". Caso real validado: RGM 47277581 entrou na fila como Reativação após o cooldown de 6h, mas o dispatch acusava `1 ignorada(s) (template já enviado)`.
- **Decisão:** Remover o check + a função `wasTemplateSentInCategory`. O cooldown (6h CAA / 24h outras) é o único gate antispam; o cap por tier continua dado pela presença/ausência de template (sem template `fifth` → `template_nao_configurado` segura naturalmente).
- **Onde:** `server/services/activationService.js` — `runDatacrazyActivationBatch` (5 linhas removidas) + definição da função (9 linhas removidas).
- **Efeito:** Pessoa pode receber o mesmo template múltiplas vezes desde que respeite o cooldown e o tier. A operação assume a responsabilidade de configurar templates distintos por tier em `/regras` se quiser conteúdo variado (não é obrigatório).

#### Alternativas descartadas

- **Janela temporal no dedup (ex.: "mesmo template só após 7 dias"):** mais um eixo de configuração que sobrepõe o cooldown sem benefício claro. Cooldown único é mais simples.
- **Manter o dedup mas relaxar pra "diferente status que não `sent`":** não muda nada — o status pra evento bem-sucedido sempre é `sent`.
- **Manter o dedup como warning não-bloqueante:** poluiria o resultado do batch sem agregar; quem precisar de variedade de conteúdo cadastra mais templates.

### 02/06/2026 — Cooldown entre disparos (substitui filtro absoluto de dispatched)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Pessoa que já foi disparada 1 vez em uma categoria nunca mais voltava à fila — o filtro `dispatched.has(master_key)` era absoluto. Conflito com a regra de múltiplas ativações por tier (1ª / Reativação / 5ª) que já existia no resto da app (`resolveMessageTier`, `resolveTemplateForActivation`).
- **Decisão:** Trocar por **cooldown configurável por categoria**:
  - **`processos-caa`**: **6h** (encaixa 2 disparos/dia dentro da janela CAA de 48h; consultor não trabalha 24h, então 12h não daria 2 envios no mesmo expediente)
  - **Outras categorias** (`docs-pendentes`, `financeiro`, `acessos-blackboard`, `provavel-evasao`, `aguardando-inicio`): **24h** (1x/dia)
  - Limite total continua dado pelos templates configurados — pessoa some quando esgota o tier (ex.: sem template `5ª ativação`, sai após a 4ª).
- **Onde:**
  - `activationDispatchRepository.js#getLastSentAtByMasterKey` — nova query `max(created_at)` por master_key + status `sent`.
  - `activationService.js#COOLDOWN_HOURS_BY_CATEGORY`, `getCooldownHoursForCategory`, `isOnCooldown` — helpers.
  - 3 locais que usavam `dispatched.has(master_key)` foram substituídos por `isOnCooldown(...)`: intersection list, aguardando-início, batch.
  - Erro claro quando usuário seleciona alguém em cooldown via batch: HTTP 400 `no_eligible_selected` com mensagem indicando horas restantes.
- **Default seguro:** cooldownHours hardcoded por categoria. Quando for preciso tuning fino per-categoria via UI, mover pra `journey_settings`.

#### Alternativas descartadas

- **Sempre permitir disparos consecutivos sem cooldown:** spam; sem proteção contra clique duplo.
- **Cooldown via `journey_settings`:** mais flexível, mas exige migration + form em `/regras` + carregar settings em cada chamada de fila. Defaults hardcoded resolvem o problema imediato.
- **Limite máximo absoluto por pessoa (ex.: 5 disparos/categoria):** confiamos nos templates configurados (sem 5ª = sai naturalmente).

### 01/06/2026 — Verify de `origem_ativacao` agora é best-effort + n8n limpa após resposta

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** `verifyOrigemAtivacaoForCategory` bloqueava o disparo quando o **PUT no CRM web** retornava 200 OK mas o **GET na API pública** (`/api/v1/leads`) não retornava o campo `origem_ativacao` nos `additionalFields` (config "campo não exposto via API"). O campo estava sendo gravado corretamente no CRM — só não saía na resposta da API pública.
- **Decisão:**
  - `verify` agora confia no **PUT 200 OK** (a automação do CRM lê o campo internamente, não via API pública).
  - GET via API pública continua sendo feito como double-check, mas se falhar/não retornar o campo, loga warning e segue (`ok: true, verified: false`).
  - PUT que falhar de verdade (status != 200) continua bloqueando o disparo (comportamento correto).
- **Onde:** `server/services/datacrazyClient.js#verifyOrigemAtivacaoForCategory`.

#### Webhook de resposta (n8n) — handshake obrigatório

A automação do CRM (DataCrazy) dispara o webhook de resposta enquanto `origem_ativacao` estiver preenchido no lead. Se o n8n só grava em `activation_responses` e **não limpa** o campo, **toda mensagem subsequente do aluno** continuará sendo logada como resposta de ativação (falso-positivo).

**Fluxo correto no n8n:**

```
[Trigger: resposta WhatsApp]
  ↓
[Grava em activation_responses (Postgres)]
  ↓
[HTTP PUT — limpa origem_ativacao no CRM]
```

**PUT pra limpar o campo:**

```
PUT https://crm.g1.datacrazy.io/api/crm/additional-fields/lead/{LEAD_ID}/3a22bd69-4578-4740-87c1-29e72fbbac22
Authorization: Bearer <DATACRAZY_API_KEY>
Content-Type: application/json
Body: {"value": ""}
```

(Field ID `3a22bd69-4578-4740-87c1-29e72fbbac22` = `origem_ativacao` no CRM. Validado 01/06/2026.)

#### Alternativas descartadas

- **Endpoint da app `POST /api/activation/responses` fazer o PUT de limpeza:** acopla a app ao fluxo de respostas e duplica responsabilidade — o n8n já é o ponto natural pra isso.
- **Marcar o campo `origem_ativacao` como "exposto via API" no CRM:** seria mais limpo, mas requer config no DataCrazy que pode não estar disponível na conta. A solução com PUT-trust funciona sem depender disso.

### 03/06/2026 — Falso start: consultor no dispatch (revertido na mesma sessão)

- **Modelo usado:** Opus 4.7 (principal)
- **Contexto:** Numa primeira leitura, interpretei "consultor" como quem clica em "Ativar". Construí `activation_dispatch_events.consultor_id` (migration 024) + hook `useConsultor` + painel agrupado por disparador. **Errado.** O usuário corrigiu: o disparador é um operador (pessoa diferente do consultor); o consultor é quem ASSUME a conversa no DataCrazy depois que o aluno responde.
- **Revertido em:** migration 025 dropa colunas; arquivos novos deletados; código modificado restaurado.
- **Aprendizado documentado:** sempre clarear "quem clica" vs "quem atende" antes de modelar tabelas de autoria.

### 03/06/2026 — Painel "Por consultor" (modelo correto)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Identidade do consultor vem do **DataCrazy** (não do nosso app). Snapshot textual gravado em duas fontes:
  - `activation_responses.consultor_responsavel_nome` — populado pelo webhook do n8n que entrega a resposta (n8n lê o campo customizado do DataCrazy ao processar a resposta).
  - `caa_protocols.consultor_responsavel_nome` + `consultor_responsavel_updated_at` — populado pelo `crmDesfechoSyncService` que faz polling. Quando detecta desfecho (Sim/Não), também lê o campo "consultor responsável" do mesmo lead e atualiza TODOS os protocolos daquele RGM.

#### Migration 026

```sql
alter table activation_responses
  add column consultor_responsavel_nome text;
alter table caa_protocols
  add column consultor_responsavel_nome text,
  add column consultor_responsavel_updated_at timestamptz;
```

Snapshot por texto (não FK) — preserva histórico se o consultor for renomeado/deletado no futuro `app_users`. Depois do merge com `dcz-crm-sync`, resolve nome → user por similarity em `username` / `email_cruzeiro`.

#### Config necessária

- `DATACRAZY_DESFECHO_CAA_FIELD_ID` — campo "Sim/Não" do desfecho (já existia).
- `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID` (NOVO) — UUID do campo customizado no DataCrazy onde fica o nome do consultor responsável. Sem ele, sync de desfecho continua funcionando mas atribuição fica vazia.

#### Contrato do webhook do n8n

O n8n já posta em `POST /api/activation/responses`. Agora também pode enviar:

```json
{
  "lead": "<datacrazy_lead_id>",
  "evt": "<external_id>",
  "rgm": "...",
  "consultor_responsavel_nome": "Felipe Nolasco"
}
```

Aceita várias chaves: `consultor_responsavel_nome` | `consultorResponsavelNome` | `consultor` | `responsavel` | `responsible_user_name`. Sem o campo, gravação continua funcional (consultor fica nulo).

#### Atribuição CAA

Quando `crmDesfechoSyncService` detecta `Sim`/`Não` num lead:
1. Cria entrada em `activation_manual_outcomes` (como já fazia).
2. **Novo**: Lê `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID` no mesmo lead via `getLeadAdditionalFieldValue`.
3. Se preenchido, `UPDATE caa_protocols SET consultor_responsavel_nome=$1, consultor_responsavel_updated_at=now() WHERE rgm=$2` (atualiza todos os protocolos do RGM — realista, o consultor cuida do lead inteiro, não de protocolos individuais).
4. Best-effort: se falhar leitura/update, loga warning e segue (não bloqueia o sync de desfecho).

#### Endpoint

`GET /api/reports/consultores?period_days=` (com `requireApiKey`). Resposta:
- `consultores[]`: `{ consultor_nome, caa_revertidos, caa_perdidos, caa_taxa_reversao, total_respostas, ultima_atribuicao }`.
- `totals`: agregado.
- Período padrão 30d, máx 365.
- Ordenado por `caa_revertidos desc`, tiebreaker `total_respostas desc`.

#### UI

`ConsultoresPanel` em `/reports` (renderizado quando categoria ativa = CAA). Filtros: período 7/30/90d. Tabela compacta com Consultor / Revertidos / Perdidos / Taxa / Respostas / Última atividade. Mensagem informativa quando vazio (explica que dados aparecem quando webhook/sync começarem a popular).

#### Alternativas descartadas

- **FK pra `app_users.id`:** acoplaria ao banco do dcz-crm-sync antes do merge. Snapshot textual desacopla.
- **Atribuir respostas com mesma lógica:** decisão do usuário foi "só reversão" — mais simples e foco no que importa pra comissionamento.
- **Tabela `consultor_attribution` separada:** redundante, snapshot dentro de `caa_protocols` resolve.
- **Buscar consultor em todo lead disparado (não só nos com desfecho):** mais custo de API e dado fica obsoleto rápido. Snapshot no momento do desfecho captura quem efetivamente fechou.
- **Múltiplas tentativas de chave no webhook:** preferido invés de exigir uma chave única — torna o n8n mais resiliente a refactor do nome do campo.

### 02/06/2026 — Direct search threshold 25→100 + paralelização

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Selecionar **29 pessoas** na fila CAA caía no scan paginado completo do CRM (29 > 25). Resultado: minutos pra varrer 30k leads em 300+ páginas com 400ms entre páginas.
- **Decisão:**
 - Threshold default sobe de **25 → 100** (`DATACRAZY_DIRECT_SEARCH_THRESHOLD`). Cobre seleções típicas do roster sem trade-off (até 100 GETs diretos ainda é mais rápido que paginar o CRM inteiro).
 - Buscas diretas agora rodam em **batches paralelos de 5** (configurável via `DATACRAZY_DIRECT_SEARCH_CONCURRENCY`, default 5, max 20). Antes era 1 por vez (sequencial).
 - 29 leads sai de minutos → ~6s.
- **Onde:** `server/services/datacrazyClient.js#buildLeadsLookupIndex` (bloco do fast path).

#### Alternativas descartadas

- **Threshold ainda maior (ex.: 500):** acima de ~100 alvos, paginar o CRM inteiro (com cache `sharedLeadsIndex` TTL 20min) já compensa, porque a 1ª chamada paga o custo único e as subsequentes reusam.
- **Concorrência mais alta (ex.: 20):** sem dados sobre rate limit oficial do DataCrazy, 5 é conservador. Bumpável via env se precisar.
- **Cache de leads por master_key:** já existe via `sharedLeadsIndex` (índice global de phone/email com TTL 20min).

### 01/06/2026 — Busca direta no DataCrazy para lotes pequenos

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Disparar 1 pessoa demorava ~4min porque `buildLeadsLookupIndex` varria todas as páginas de leads (`take=100&skip=N`) com `pageDelay=400ms`, mesmo que o alvo fosse só 1 telefone.
- **Decisão:** Quando o lote tem **<= 25 alvos novos** (configurável via `DATACRAZY_DIRECT_SEARCH_THRESHOLD`), pular a paginação e fazer `GET /api/v1/leads?search=<telefone_ou_email>&take=5` por alvo, alimentando o mesmo `byPhone/byEmail` que o caminho paginado popula. Lotes maiores continuam no scan paginado (mais eficiente em volume). **Atualização 02/06/2026:** threshold elevado para 100 + paralelização de 5 — ver entrada acima.
- **Onde:** `server/services/datacrazyClient.js` → `buildLeadsLookupIndex`. Retorno ganhou flags `direct_search` e `direct_queries` para diagnóstico.
- **Efeito:** Disparo individual (seleção de 1 aluno) deve cair de ~4min para alguns segundos (1 request à API + latência).
- **Default seguro:** Se a busca direta falhar (`searchLeads` lançar), loga warning e continua com o que tiver. Cache compartilhado (`sharedLeadsIndex`, TTL 20min) é alimentado igual.

#### Alternativas descartadas

- **Sempre usar scan paginado:** mantém o problema atual (tempo proporcional ao tamanho do CRM, não ao lote).
- **Buscar lead por id quando já temos `datacrazy_lead_id`:** só vale após a primeira ativação. No 1º disparo, ainda precisamos descobrir o lead por telefone/email.

### 22/05/2026 — Regra D+1 para CAA (cancelamento de matrícula)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Status normalizado por protocolo + histórico de transições + fila restrita aos pendentes.

#### Modelo de status

A partir das colunas `Situação Atendimento` e `Situação Deferimento` do export `data.xlsx`:

| Atendimento | Deferimento | Status normalizado | Significado                                       |
|-------------|-------------|--------------------|---------------------------------------------------|
| PENDENTE    | Em aberto   | `open`             | Em fila para ativação                             |
| CANCELADO   | (qualquer)  | `lost_canceled`    | Aluno desistiu antes do CAA decidir (perdemos)    |
| CONCLUIDO   | Deferido    | `lost_confirmed`   | CAA aprovou cancelamento (perdemos)               |
| CONCLUIDO   | Indeferido  | `won_reverted`     | CAA negou cancelamento — matrícula segue (vitória) |
| (outros)    | —           | `unknown`          |                                                   |

#### Tabelas

- `caa_protocols` — estado vivo por **Protocolo** (chave primária).
- `caa_protocol_transitions` — histórico de mudanças de status (`from_status` → `to_status`).

Snapshots brutos continuam em `processos_caa_snapshots/_rows` para auditoria.

#### Pipeline

1. Upload CAA grava em `processos_caa_rows` (snapshot bruto).
2. `caaProtocolsService.processSnapshot(snapshotId)` é chamado em sequência:
   - UPSERT em `caa_protocols`.
   - Para cada protocolo, se o status mudou em relação ao estado vivo, registra uma linha em `caa_protocol_transitions`.
3. Idempotente: reimportar o mesmo snapshot não gera novas transições.

#### Fila de ativação

- Categoria `processos-caa` em `getIntersectionActivationList`:
  - Filtra `processos_caa_rows` por `Subprocesso = cancelamento` **E** `Situação Atendimento = PENDENTE`.
  - Dedup por RGM (não falar 2x com a mesma pessoa).
  - Cruzamento com matriculados mantém a régua de 1ª/reativação/5ª via `activation_dispatch_events`.

#### Painel D+1

- Endpoints:
  - `GET /api/reports/caa/summary?hours=24` — KPIs + contagens atuais.
  - `GET /api/reports/caa/transitions?hours=24&to_status=lost_canceled,lost_confirmed` — lista detalhada.
- UI: componente `CaaDailyPanel` aparece em **Relatórios** (quando card CAA selecionado) e em **Ativação CAA**.

#### Alternativas descartadas

- **Calcular tudo on-the-fly comparando snapshots brutos:** caro e sem chave estável (mesmo Protocolo é a única chave confiável; comparar XLSX a XLSX é frágil).
- **Identidade por Protocolo na fila:** descartado por pedido do usuário — 1 aluno com 2 protocolos pendentes deve aparecer 1× só.
- **Mudar `rowFilterForCategory` para incluir o filtro de pendência em todos os contextos:** quebraria o relatório de overview ("12.425 cancelamentos no arquivo") que conta tudo. O filtro de pendência é aplicado **só na fila**, via flag `caaOnlyPending` passada de `activationService`.

#### Scripts utilitários

- `server/scripts/backfillCaaProtocols.mjs` — reconstrói `caa_protocols` a partir dos snapshots existentes (usar `--reset` para zerar antes).
- `server/scripts/inspectCaaProtocols.mjs` — fotografia rápida do estado.
- `server/scripts/diagCaaQueue.mjs` — verifica a fila CAA atual.
- `server/scripts/diagCaaSummary.mjs` — verifica stats D+1.

#### Extensão (25/05/2026) — Painel D+1 baseado no último export

- Antes: filtro por janela móvel `?hours=24` (mostrava "0" se passassem 24h sem upload novo).
- Agora: `scope=last_snapshot` é o padrão. Os endpoints `/api/reports/caa/summary` e `/api/reports/caa/transitions` resolvem o snapshot mais recente em `processos_caa_snapshots` e filtram `caa_protocol_transitions` por `snapshot_id`.
- Compatibilidade: `?scope=hours&hours=24` continua funcionando (debug).
- Resposta agora inclui o objeto `snapshot` (`id`, `file_name`, `row_count`, `created_at`) para o header do painel mostrar contexto.

### 22/05/2026 — Respostas de ativação (webhook externo)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** A app **não recebe webhook** de respostas. A integração externa (DataCrazy ou similar) grava direto na tabela `activation_responses`. A app apenas **lê** e exibe.

#### Schema `activation_responses` (migration 015)

| Coluna | Tipo | O que preencher |
|---|---|---|
| `category` | text | `processos-caa` / `docs-pendentes` / `financeiro` / `acessos-blackboard` / `provavel-evasao` (pode ficar null — será resolvido pelo dispatch) |
| `master_key` | text | Idealmente `RGM:<rgm>` (mesma chave de `activation_dispatch_events`) |
| `datacrazy_lead_id` | text | ID do lead na DataCrazy |
| `telefone` | text | Número (qualquer formato; é normalizado) |
| `rgm` | text | Para fallback de identificação |
| `response_kind` | text | `click` (default) / `message` / `opt_out` / `other` |
| `button_payload` | text | Texto/payload do botão clicado (ex.: "Quero ativar", "Não quero") |
| `message_text` | text | Texto livre, se houver |
| `external_id` | text | ID único do evento no provedor — usado para idempotência (UPSERT) |
| `raw_payload` | jsonb | Payload original (auditoria) |
| `received_at` | timestamptz | Quando o evento aconteceu no provedor |

**Correlação fila ↔ resposta** (ordem de prioridade):
1. `master_key` direto (preferido).
2. `datacrazy_lead_id` → busca último `activation_dispatch_events.datacrazy_lead_id`.
3. `telefone` normalizado → busca último envio dessa pessoa (janela 168h).

**Comportamento na fila:**
- Resposta **não tira** ninguém da fila. Só vira badge "Clicou · 2h" no roster.
- Para CAA: o aluno só sai da fila quando o **status do protocolo** mudar (pendente → won/lost). Cruzar resposta + transição permite identificar "respondeu mas perdemos" (alvo de análise).

**Exemplo de INSERT** (para a integração externa):
```sql
insert into activation_responses (
  category, master_key, datacrazy_lead_id, telefone, rgm,
  response_kind, button_payload, external_id, raw_payload
) values (
  'processos-caa', 'RGM:47485892', 'lead_abc123', '5511947648432', '47485892',
  'click', 'Quero ativar minha matrícula', 'evt_xyz',
  '{"source":"datacrazy","template":"caa_reativacao_v2"}'::jsonb
)
on conflict (external_id) where external_id is not null do nothing;
```

#### Alternativas descartadas

- **Endpoint webhook na própria app:** o usuário prefere centralizar gravação fora; menos pontos de falha do lado nosso.
- **Tirar quem respondeu da fila:** descartado — clique não significa desfecho, só engajamento.

### 22/05/2026 — Filtro de "limbo" na fila Blackboard (turma ainda não começou)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Alunos cuja `Data Matrícula` cai em uma turma cadastrada em `academic_terms` cujo `inicio_conteudo` ainda não chegou são **retirados da fila `acessos-blackboard`**. Outras filas (financeiro, docs, CAA, evasão) NÃO são afetadas.

#### Por quê

A planilha de Blackboard lista todos os matriculados que não acessaram a plataforma. Mas se a turma de alguém ainda não começou (ex.: matriculado em junho na turma "Agosto", aulas só em 15/08), ele não tem conteúdo para acessar — pressioná-lo a entrar no BB é ativação inútil/ruidosa.

#### Como funciona

1. **Cadastro:** turmas vivem em `academic_terms` (já existente, página `/academic-terms`). Campos relevantes: `inicio_matricula`, `fim_matricula`, `inicio_conteudo`, `tem_ambientacao`, `dias_ambientacao`.
2. **Resolução da turma do aluno:** `findTermByMatriculaDate(terms, dataMatricula)` em `server/services/termResolverService.js`.
   - Lê `data->>'Data Matrícula'` do snapshot matriculados.
   - Converte serial Excel via `excelSerialToDate` (`server/utils/dateParser.js`).
   - Acha a turma `t` onde `t.inicio_matricula ≤ dataMat ≤ t.fim_matricula`.
3. **Verificação de limbo:** `isInLimbo(term, today)` retorna `true` se `today < (inicio_conteudo - dias_ambientacao)`.
4. **Aplicação:** em `getIntersectionActivationList` (categoria `acessos-blackboard`), antes de adicionar o item à fila, executa `resolveLimbo`; se `limbo === true`, incrementa `skipped_bb_limbo` e pula.
5. **Cache:** turmas são carregadas com TTL 5min (`loadTerms()`); rotas POST/PUT/DELETE em `academicTerms.js` invalidam via `bustTermCaches()` (limpa também o cache da fila BB).

#### Default seguro

- Sem turma cadastrada → ninguém é filtrado (comportamento idêntico ao anterior).
- Aluno cuja data de matrícula não bate com nenhuma turma → entra na fila normalmente.

#### Indicação na UI

- Banner amarelo na `AcademicTermsPage` explicando a regra.
- Banner na `ActivationRosterTable` quando `category === 'acessos-blackboard'` e `skipped_bb_limbo > 0`, com link pro Calendário.

#### Alternativas descartadas

- **Identificar turma pelo `Ciclo`** (ex.: "2026/1"): o ciclo é grosseiro (1 ciclo = 1 semestre), não tem granularidade pra "abril/maio/junho". Usar data_matricula dá a granularidade necessária e usa o cadastro já existente.
- **Filtrar em todas as filas:** o usuário decidiu aplicar apenas em BB por ora (financeiro/docs/CAA podem ter ações úteis mesmo no limbo).
- **Mover cadastro de turmas pra dentro de Regras:** o cadastro já existe em Calendário e é referenciado por outros sistemas (decisionEngine, students.term_id); duplicar ou mover quebraria links existentes.

#### Próximos passos sugeridos

- Categoria nova de ativação `aguardando-inicio` para os alunos em limbo, com mensagens semanais ("sua turma começa em X dias") — esqueleto fica reservado para quando os tipos de mensagem forem decididos.

#### Extensão (22/05/2026) — Priorização BB + filtros nível/ciclo

- Migration 016: `nivel` e `ciclo` em `academic_terms` (text, nullable, indexados). Aplicar manualmente: `node server/db/migrate.js` (ou `npm run migrate` se houver script).
- Form de turma e listagem de Regras ganham os campos. Filtros na listagem por nível e ciclo.
- Fila BB ordena por urgência: `alta` (≥30d sem início), `media` (≥14d), `normal` (<14d), `sem_turma`. Defaults hard-coded em `URGENCY_HIGH_DAYS` / `URGENCY_MEDIUM_DAYS` em `activationService.js`.
- Badge `UrgencyBadge` no roster + chips com contagens no header da fila BB.
- Default seguro: sem turma cadastrada para um aluno → `sem_turma`, mantém na fila sem priorização.

### 25/05/2026 — Campo `origem_ativacao` no disparo DataCrazy

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Após envio bem-sucedido do template em `runDatacrazyActivationBatch`, a app faz `PUT` no endpoint do **CRM web** (não o OpenAPI público): `{crm}/api/crm/additional-fields/lead/{leadId}/{fieldId}` com body `{ value: "Doc" | "Inad" | "caa" | ... }`. Mesma URL que o navegador usa ao editar o campo manualmente.
- **Extensão (26/05/2026):** `verifyOrigemAtivacaoForCategory` confirma leitura no lead (GET com `additionalFields`). **Pré-voo** no 1º lead encontrado antes de qualquer envio; falha → HTTP 503 `origem_ativacao_unavailable` e banner na UI. No loop, grava `origem_ativacao` **antes** do WhatsApp; se falhar, não envia e interrompe o lote.
- **Extensão (26/05/2026) — Hardening:** `APP_API_KEY` opcional protege rotas de escrita; upload matriculados invalida cache de todas as filas; CPF→RGM usa matrícula mais recente; reparo de colunas CAA deslocadas (`caaExportRepair.js`); falha em `processSnapshot` retorna `warning` no upload.
- **Correção (25/05):** `PATCH /api/v1/leads/{id}` com `additionalFields` retorna 200 mas **não persiste** o valor de forma confiável; só o PUT no CRM funciona.

### 28/05/2026 — Painel de Desfecho Manual (CAA + 4 categorias)

- **Modelo usado:** Opus 4.7 (principal) decidiu, Executor (Sonnet 4.6) implementou.
- **Decisão:** Os consultores registram manualmente o resultado de cada ativação CAA (revertido/confirmado/sem contato/outro), com possibilidade de anexar print da conversa. Esta tabela vira a **fonte da verdade do desfecho** porque o export CAA novo só lista protocolos com `Data Chegada = D-1` — a maioria dos desfechos cai fora dessa janela e não aparece em snapshots subsequentes (3 exports consecutivos analisados em 25/26/27 de maio: zero protocolos repetidos).

#### Modelo de dados

Migration `018_activation_manual_outcomes.sql`:

| Coluna | Tipo | O que guarda |
|---|---|---|
| `id` | uuid pk | |
| `category` | text (check 5 categorias) | Genérico para reuso futuro; UI inicial só CAA |
| `master_key` | text | Padrão `RGM:<rgm>` (mesmo das outras tabelas) |
| `rgm`, `cpf`, `nome` | text | Identificação do aluno |
| `protocolo` | text | Opcional. Auto-vinculado se aluno tem 1 protocolo aberto |
| `outcome` | enum | `revertido` / `confirmado` / `sem_contato` / `outro` |
| `motivo` | text | Texto livre detalhando |
| `notes` | text | Observações |
| `proof_path` | text | Caminho absoluto no disco (`server/uploads/manual_outcomes/{id}.{ext}`) |
| `proof_mime`, `proof_size_bytes` | | |
| `consultor_nome` | text not null | Texto livre — **sem auth de usuário no app** |
| `occurred_at` | timestamptz | Quando o desfecho aconteceu na vida real |

#### Endpoints (todos com `requireApiKey`)

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/api/manual-outcomes` | Cria registro JSON (sem anexo) |
| `POST` | `/api/manual-outcomes/:id/proof` | Upload binário (`X-File-Name`, MIME validado, ≤10MB) |
| `GET` | `/api/manual-outcomes` | Lista com filtros (category, outcome, consultor, period, search por RGM/nome) |
| `GET` | `/api/manual-outcomes/:id` | Detalhe |
| `GET` | `/api/manual-outcomes/:id/proof` | Serve o anexo inline |
| `DELETE` | `/api/manual-outcomes/:id` | Hard delete + remove anexo |
| `DELETE` | `/api/manual-outcomes/:id/proof` | Remove só o anexo |
| `GET` | `/api/manual-outcomes/protocols-by-rgm/:rgm` | Lista protocolos abertos do RGM (auxiliar do modal) |

#### Fluxo de uso

1. Consultor abre `/desfechos-manuais` (item "Desfechos" no header) ou clica no botão "Desfecho" na linha do roster CAA em `/`.
2. Modal abre. Se vier do roster, pré-preenche `category`, `rgm`, `nome` e busca protocolos abertos do aluno.
 - 1 protocolo aberto → preenche e mostra "Trocar".
 - >1 → dropdown.
 - 0 → campo livre.
3. Hook `useConsultor` lê `localStorage['consultor_nome']`. Primeira vez, usa `window.prompt`. Reusa nas próximas vezes.
4. Submeter cria o registro. Se houver anexo, faz POST sequencial para `/api/manual-outcomes/:id/proof`.
5. Página de listagem permite filtrar, ver anexo (link direto pra rota `/proof`), excluir.

#### Decisões de design

- **Tipo do anexo:** upload local em `server/uploads/manual_outcomes/`, replicando padrão `express.raw` de `baseUploads.js`. Pasta criada no boot do server (`fs.mkdirSync` em `server/index.js`). MIMEs aceitos: PNG/JPG/WebP/GIF/PDF.
- **Sem multer:** mantida a regra do projeto de não adicionar dependências.
- **Trade-off:** se o app for pra ambiente sem disco persistente (container ephemeral), os anexos somem. Hoje o app roda local/servidor próprio — OK como MVP. Migrar pra Supabase Storage se virar problema (dependência `@supabase/supabase-js` já existe; só falta config de bucket).
- **Identidade do consultor:** texto livre via localStorage. Sem auth de usuário (decisão consciente de não criar tabela `users`/login agora).
- **Tabela genérica:** modelada com `category` aceitando todas as 5 (CAA, docs, financeiro, BB, evasão) mesmo a UI sendo CAA-only no MVP — evita migration nova depois.
- **`proof_path` absoluto:** simplifica `res.sendFile()`. O endpoint `GET /:id` retorna esse path no JSON; futuro: sanitizar no DTO se preocupar com vazamento (rota é protegida por API key).

#### Alternativas descartadas

- **Inferir desfecho automaticamente do export CAA:** não funciona — o export novo só lista D-1. Confirmado com 3 amostras consecutivas (25/26/27 de maio): zero protocolos repetidos.
- **Multipart com multer:** descartado — sem novas dependências. POST JSON + POST binário separado é equivalente.
- **Enum granular (6 valores) com `revertido_caa`/`revertido_aluno`/`confirmado_caa`/etc.:** descartado em favor de `outcome` simples + campo `motivo` (texto). Granularidade vai pro `motivo`, classificação principal fica usável.
- **Login/auth de usuário:** descartado — consumo único de tempo sem benefício imediato. localStorage com prompt resolve para ≤20 consultores.
- **Painel manual genérico desde a UI:** descartado — UI focada em CAA (caso de uso real); modelo de dados genérico.

#### Pendências (não-bloqueantes)

- **Janela de 48h (cap de envios + saída automática da fila):** configuração persistida (ver decisão 29/05/2026 abaixo). Falta implementar a aplicação efetiva: `expiration_at` em `caa_protocols` + filtro de cap (2/dia, 4/total por RGM) + job de expiração + KPI "perdas silenciosas".
- **Painel de conversão (envios × respostas):** Fase 2 prevista, independente do painel manual. Cruza `activation_dispatch_events` × `activation_responses`.
- **Sanitização do `proof_path` no DTO `GET /:id`:** ajuste menor de segurança.

### 29/05/2026 — Configuração da janela CAA na aba Regras

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Decisão:** Adicionar 2 campos configuráveis em `journey_settings` (scope GLOBAL apenas) para o usuário definir como funciona a janela de 48h do CAA, sem ainda aplicar a lógica.

#### Campos

Migration `019_caa_window_settings.sql` (`ALTER TABLE journey_settings`):

| Coluna | Tipo / valores | Default | O que significa |
|---|---|---|---|
| `caa_janela_t0` | text — `data_chegada` \| `primeiro_export` \| `primeiro_envio` | `data_chegada` | Quando começa a contar os 48h: Data Chegada no CAA, 1ª vez que apareceu no nosso export, ou 1º envio que fizemos |
| `caa_janela_dias_tipo` | text — `corridos` \| `uteis` | `corridos` | Se os 2 dias da janela são corridos (com sábado/domingo) ou úteis (só seg–sex) |

Reaproveita endpoints existentes (`GET/PUT /api/journey-settings/global`) — só ampliou `FIELDS` e `ALLOWED` em `journeySettingsRepository.js`.

#### UI

Novo Card "Janela CAA (48h)" em `/journey-rules`, **só aparece no scope GLOBAL** (essas regras não fazem sentido por turma).

Banner amarelo no topo do card sinaliza: *"Estas configurações são armazenadas, mas ainda não impactam a fila CAA. A aplicação efetiva acontecerá em fase posterior."* — evita expectativa errada de que ao salvar já vale.

#### Alternativas descartadas

- **Nova tabela `system_settings` chave/valor:** custo desnecessário; a tabela `journey_settings` já é a "fonte de regras operacionais" e tem toda a infra de GET/PUT/scope GLOBAL pronta.
- **Aplicar como prefixo em raw_config (jsonb):** mais frouxo, sem CHECK nem tipagem. Colunas dedicadas dão validação no banco e DTOs limpos.
- **Permitir por turma (scope TERM):** descartado — regras de janela CAA são da operação, não do calendário acadêmico.
- **Implementar a lógica de expiração junto com a UI:** descartado pra evitar ativar a regra sem o usuário ter confirmado a configuração com o time interno. UI primeiro, lógica depois (em fase separada).

### 29/05/2026 — Subgrupos da fila "Sem acesso BB" + categoria nova `aguardando-inicio`

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Decisão:** Dividir a fila `acessos-blackboard` em 3 subgrupos baseados em telemetria do export, e mover alunos em limbo (turma ainda não começou) para uma 6ª categoria de ativação com mensagem própria.

#### Modelo da fila BB

Antes: binário — "está no export = excluído". Agora: cada matriculado é classificado em `bbSubgroupService.classifyBbSubgroup()`:

| Ordem | Subgrupo | Critério | Cor no roster |
|---|---|---|---|
| 1 | `podia_e_nao_acessou` | Sem linha no export OU sem `Ultimo Acesso` | rose ("Nunca acessou") |
| 2 | `nao_acessa_faz_tempo` | Último acesso ≥ `bb_nao_acessa_dias` atrás | amber ("Há tempo") |
| 3 | `acessou_pouco` | Acesso recente, mas `Minutos < bb_acessou_pouco_minutos` OU `Interações < bb_acessou_pouco_interacoes` | sky ("Pouco uso") |
| — | `ok` | Acessando regularmente | (não entra na fila) |

Limbo continua excluído da fila BB e agora alimenta a categoria nova `aguardando-inicio`.

#### Thresholds em `journey_settings` (migration 020)

| Coluna | Default | Range |
|---|---|---|
| `bb_nao_acessa_dias` | 14 | 1–365 |
| `bb_acessou_pouco_minutos` | 60 | ≥ 0 |
| `bb_acessou_pouco_interacoes` | 10 | ≥ 0 |

Editáveis em `/journey-rules` (scope GLOBAL) — card **"Subgrupos da fila Sem acesso BB"**, sem banner de "não impacta" (esses thresholds afetam a fila em produção imediatamente).

Período de análise = **mensal** (assumido — `Minutos`/`Interações` no export representam atividade do mês corrente).

#### Categoria nova `aguardando-inicio` (migration 021)

- Aluno cuja turma ainda não liberou conteúdo (limbo). Não cruza com nenhum export.
- Cada item da fila tem `dias_ate_inicio` (positivo) + `bb_term_codigo`.
- Aba dedicada em `ActivationPanel.tsx`.
- Template configurável via `raw_config.activation_templates['aguardando-inicio']`.
- `origem_ativacao` mapping: `'aguardando-inicio' → 'AguardInicio'` em `datacrazyClient.js`.
- Cap de envios (`excludeDispatched`) continua valendo — mesma régua das outras categorias.

Migration 021 atualiza CHECK constraints de `activation_dispatch_events` e `activation_manual_outcomes` (a tabela `activation_responses.category` é nullable e sem check — não foi tocada).

#### Filtro de subgrupo no roster

- Endpoint roster aceita `?bb_subgrupo=podia_e_nao_acessou|nao_acessa_faz_tempo|acessou_pouco`.
- Frontend adiciona chips em `ActivationRosterTable` (só categoria BB) com contagens calculadas **antes** do filtro de stage, pra exibir o total real por subgrupo independente da combinação de filtros.

#### Implicações operacionais conhecidas

- **Distribuição inicial enviesada:** snapshots BB que cobrem só uma fração dos matriculados (ex.: 131 linhas vs 27.790 alunos) jogam quase todo mundo em `podia_e_nao_acessou`. Não é bug — é estado do dado. Importar export BB completo redistribui.
- **`bb_urgency` ainda existe** como sinal secundário (alta/media/normal/sem_turma); ordenação primária agora é por subgrupo.
- **Banner amarelo "X alunos retirados por limbo"** foi substituído por mini-link apontando que esses alunos agora vivem na aba "Aguardando início".

#### Alternativas descartadas

- **Sub-abas dentro do BB ao invés de chips:** chips replicam o padrão dos filtros de stage já existentes e ocupam menos espaço.
- **Manter "Sem conteúdo" como subgrupo do BB:** preferimos categoria separada porque a mensagem (apoio "sua turma começa em X dias") é fundamentalmente diferente das mensagens de "sem acesso".
- **Thresholds em `raw_config` (jsonb):** colunas dedicadas com CHECK dão validação e tipagem; segue padrão da janela CAA.
- **Reaproveitar `bb_urgency` como base de subgrupo:** `bb_urgency` mede tempo desde início da turma; subgrupo mede engajamento real com o BB. Conceitos diferentes; mantemos ambos.

#### Mapeamento categoria → valor

| Categoria (`activationService`) | Valor em `origem_ativacao` |
|---------------------------------|----------------------------|
| `docs-pendentes` | `Doc` |
| `financeiro` | `Inad` |
| `processos-caa` | `caa` |
| `provavel-evasao` | `Evasao` |
| `acessos-blackboard` | `BB` |

Campo custom no **Lead** (não negócio). Config: `DATACRAZY_ORIGEM_ATIVACAO_FIELD` (nome), `DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID` (UUID do campo), `DATACRAZY_CRM_BASE_URL` (default deriva `api.g1` → `crm.g1`).

#### Implementação

- `server/services/datacrazyClient.js` — `verifyOrigemAtivacaoForCategory`, `ORIGEM_ATIVACAO_BY_CATEGORY`, `ORIGEM_ATIVACAO_BLOCK_MESSAGE`.
- `activation_origem_ativacao_log` (migration 017) — auditoria local de cada PUT (lead, categoria, valor, ok/falha).
- Automações DataCrazy podem filtrar `origem_ativacao = caa` (etc.) para gravar em `activation_responses`.
- **Webhook resposta (opcional):** `POST /api/activation/responses` com `{ lead, evt, rgm?, cpf? }`. Com `cpf`, o RGM vem do **último snapshot matriculados**, linha com **Data Matrícula** mais recente para aquele CPF (prioridade sobre `rgm` do webhook). Monta `master_key` (RGM → CPF → dispatch recente).

#### Alternativas descartadas

- **Preencher só na automação DataCrazy:** o disparo já parte da nossa app; preencher no PATCH garante o valor antes de qualquer clique/resposta.
- **Usar tag em vez de campo adicional:** tags são mais visíveis no funil, mas misturam com segmentação manual; o campo foi criado pelo usuário para esse fim.

### 29/05/2026 — Painel de Conversão de Ativação

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Nova página `/conversao` que cruza `activation_dispatch_events` × `activation_responses` e mostra KPIs de engajamento (taxa de resposta, opt-out, top botões) com filtro retrátil por base e janela 7/30/90 dias.

#### Diferença vs Funil CAA

- **Funil CAA** = lifecycle de protocolos (ainda ativável / perdido / revertido). Exclusivo CAA.
- **Conversão** = quantos disparos viraram interação. Atravessa todas as 6 categorias (ou filtra uma específica).

#### Endpoint

`GET /api/reports/activation-conversion?category=<cat|all>&period_days=<7|30|90>` (com `requireApiKey`).

Resposta (estável):
- `filters`: o que foi aplicado (`category`, `period_days`, `since`, `now`).
- `kpis`: agregados globais (`total_dispatches`, `unique_dispatched`, `unique_responders`, `unique_clickers`, `unique_messages`, `unique_opt_outs`, `response_rate`, `opt_out_rate`).
- `by_category`: array com mesmas métricas por categoria (**sempre devolvido**, mesmo quando filtrado por uma — UI só exibe quando `all`).
- `top_buttons`: top-5 `button_payload` mais clicados no período.
- `recent_responses`: últimas N respostas com nome resolvido via LEFT JOIN no último dispatch da mesma `master_key`+categoria com `status='sent'`.

#### Métricas

- `unique_*` = `COUNT(DISTINCT master_key)` (NULLs excluídos). Importante porque uma pessoa pode receber múltiplos disparos.
- `response_rate` = `unique_responders / unique_dispatched` (0 se denominador 0).
- "Respondeu" = qualquer `response_kind ≠ null`. "Clicou" = só `click`. "Mensagem" = só `message`. "Opt-out" = só `opt_out`.
- Janela: `created_at >= now() - interval '<N> days'` para dispatches; `coalesce(received_at, created_at)` para responses.
- Apenas dispatches com `status='sent'` contam como envio efetivo.

#### UI

- **Botão retrátil "Base"** (pedido explícito): popover single-select com 7 opções (Todas + 6 categorias), fecha ao clicar fora. Implementado com `useState` + ref/click-outside, sem libs novas.
- **Chips de período** sempre visíveis (7d/30d/90d), default 30d.
- **4 KPI cards** no topo (Enviados, Responderam c/ taxa, Clicaram, Opt-out).
- **Quebra por base** (tabela): visível só quando "Todas as bases". Linhas clicáveis → selecionam a categoria. Taxa de resposta colorida (verde >10% / âmbar 5-10% / cinza <5%).
- **Top botões** (lista compacta) quando há dados de `button_payload`.
- **Tabela "Últimas respostas"** paginada (Carregar mais, +50 por vez).
- Link "Conversão" no `Header` entre "Relatórios" e "Regras", ícone `TrendingUp`.

#### Alternativas descartadas

- **Dropdown nativo `<select>` em vez de popover:** o usuário pediu explicitamente "botão retrátil". Popover dá visual mais limpo, integra melhor com chips e abre espaço para futuro multi-select.
- **Endpoint separado para `by_category`:** vem junto no mesmo endpoint para evitar 2 round-trips por load.
- **`recent_responses` com paginação por cursor:** offset simples é suficiente para os volumes atuais; cursor pode entrar quando a tabela passar de 10k linhas.
- **Métrica de conversão a partir de respostas web (PerfectPay etc.):** fora de escopo desta iteração; este painel é só sobre engajamento na conversa do WhatsApp.

### 29/05/2026 — Funil CAA (base estoque com lifecycle)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Painel novo `CaaFunnelPanel` + mini-resumo no `CaaDailyPanel`. Lifecycle calculado **on-the-fly** sobre `caa_protocols` (sem schema novo). Manual outcome **prevalece** sobre status do export.

#### Escopo

Apenas CAA por enquanto. Outras 5 categorias (docs, financeiro, BB, evasão, aguard-início) não têm tabela "estoque" equivalente — generalização fica para quando o conceito estiver validado.

#### Estados do funil (6 estados + 1 fora)

Calculados em `server/services/caaFunnelService.js#classifyEstado`:

| Estado | Condição | Cor UI |
|---|---|---|
| `ativavel` | sem manual + status='open' + dentro da janela | azul |
| `perdido_silencioso` | sem manual + status='open' + janela vencida + sem clique/msg | laranja |
| `revertido_manual` | manual_outcome.outcome = 'revertido' | verde médio |
| `perdido_manual` | manual_outcome.outcome ∈ ('confirmado','sem_contato','outro') | vermelho médio |
| `revertido_export` | sem manual + status='won_reverted' | verde escuro |
| `perdido_export` | sem manual + status ∈ ('lost_canceled','lost_confirmed') | vermelho escuro |
| (fora) `unknown` | status='unknown' (não conta no `total_no_funil`) | cinza |

Prioridade: **manual outcome > export.** Flag `conflict_manual_vs_export` quando manual diverge do status final (ex.: manual `revertido` + export `lost_confirmed`).

#### Janela 48h

`expires_at = T0 + 48h conforme `journey_settings`:

- `caa_janela_t0`: `data_chegada` | `primeiro_export` (default) | `primeiro_envio` — com fallback para `first_seen_at` se T0 escolhido é inválido.
- `caa_janela_dias_tipo`: `uteis` (default) → `addBusinessDays(T0, 2)` em `server/utils/businessDays.js` (pula sáb/dom; **TODO feriados** comentado) | `corridos` → `T0 + 48h`.

#### Flags transversais

- `engajado` = tem `activation_response` com `response_kind ∈ ('click','message')` no master_key `RGM:<rgm>`.
- `conflito` = manual outcome diverge do status final do export.

#### Cap de envios

**Não bloqueia.** Apenas exibe `dispatches_today` / `dispatches_total` na tabela. Cap visual virá em iteração futura.

#### Endpoint

`GET /api/reports/caa/funnel?estado=&engajado=&conflito=&limit=&offset=` (com `requireApiKey`).

Resposta:
```json
{
  "config": { "janela_t0", "janela_dias_tipo", "cap_diario", "cap_total", "now" },
  "counts": { "ativavel", "perdido_silencioso", "revertido_manual", "perdido_manual",
              "revertido_export", "perdido_export", "unknown",
              "total_no_funil", "engajados", "com_conflito" },
  "items": [ /* lifecycle por protocolo */ ],
  "total_items", "limit", "offset", "generated_at"
}
```

#### Filtro de "base estoque ativa"

Query no service: `caa_protocols.last_snapshot_id = ÚLTIMO_SNAPSHOT_ID` OR existe `activation_manual_outcomes` ligado por protocolo OU rgm. Garante:
- Snapshot atual: tudo aparece.
- Históricos com desfecho registrado: continuam visíveis para rastreabilidade.
- Snapshots antigos sem desfecho: somem da base estoque (não poluem).

#### Hardening de `protocolFromRow` (caaProtocolsRepository)

Adicionado guard: rejeita linhas com `protocolo` que não seja numérico de 9-12 dígitos. Antes do guard, snapshots processados ANTES do repair V2 inseriam entradas "fantasma" em `caa_protocols` usando texto bagunçado ("Motivo: X...\nSubmotivo: Y...") como chave primária. Após o repair, novas entradas eram criadas com o protocolo limpo — mas as antigas ficavam. O script `server/scripts/cleanupCaaPhantoms.mjs` (one-shot) remove esses fantasmas (22 entradas + transições no momento da decisão).

#### UI

- Em `/reports` (card CAA): `CaaFunnelPanel` renderizado abaixo do `CaaDailyPanel` (D+1).
- `CaaDailyPanel` ganha seção rodapé "Estoque acumulado" com 6 chips compactos.
- Cards do funil são clicáveis (filtro toggle por estado).
- Tabela com botão "Registrar desfecho" → abre `ManualOutcomeModal` pré-preenchido (não criar modal novo).
- Toggles "Só engajados" / "Só conflito" como filtros adicionais.

#### Alternativas descartadas

- **Persistir estado em coluna nova:** o estado depende de `now()` e `journey_settings`, mudaria toda vez. Cálculo on-the-fly é mais simples e sempre consistente.
- **Funil em todas as 6 categorias agora:** sem chave estável análoga ao Protocolo nas outras categorias (RGM seria a chave, mas múltiplas matrículas/situações por aluno complicam). Validar no CAA primeiro.
- **Cap de envios bloqueante já:** decisão de "perdemos vs ainda dá" precisa de mais dados de operação para calibrar os limites. Por ora só observamos.

### 29/05/2026 — Repair V2 para export CAA (colunas embaralhadas, padrão novo)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** `caaExportRepair.js` ganhou um segundo detector + repair (V2) para um novo padrão de deslocamento do export `data.xlsx`. V1 mantido intacto para snapshots antigos.

#### Sintomas

Snapshot CAA de 29/05/2026 mostrava 25 cancelamentos de matrícula no arquivo mas só 2 pendentes na fila (BI externo confirmava 24 pendentes). O validador `validateCaaUploadRows` não bloqueava porque o `isCaaRowMisaligned` antigo só detectava 1 padrão (status em `Observação` / protocolo em `Data Conclusão`).

#### Padrão V2 (novo)

Em ~88% das linhas de cancelamento o XLSX vinha assim:

| Coluna XLSX | Conteúdo real esperado |
|---|---|
| `Protocolo` | texto "Motivo: X - Y\r\nSubmotivo: Z - W\r\nCelular: ..." (= Observação) |
| `Email` | "UNICID - GRADUAÇÃO EAD" (= Instituição) |
| `Celular` | "PEDAGOGIA (LICENCIATURA)" (= Curso) |
| `Curso` | "1" (lixo) |
| `Instituição` | "" (vazio) |
| `Situação Atendimento` | "11958849181" (= Celular) |
| `Situação Deferimento` | email |
| `Aging Dias` | **status real** ("PENDENTE") |
| `Observação` | **deferimento real** ("Em aberto") |
| `Data Previsão` | **protocolo real** (10 dígitos) |
| `Data Conclusão` | "0" (lixo) |

#### Detector `looksLikeMisalignedV2`

Sinais combinados: `Aging Dias` contém PEND/CONCLU/CANCEL/ABERTO + `Data Previsão` parece protocolo (9-12 dígitos após `\D+` strip) + `Protocolo` é texto longo OU não-numérico.

#### Repair `repairMisalignedV2`

- `Protocolo` ← dígitos de `Data Previsão`
- `Observação` ← texto original de `Protocolo`
- `Situação Atendimento` ← normalizado de `Aging Dias` (PENDENTE/CONCLUIDO/CANCELADO)
- `Situação Deferimento` ← texto original de `Observação`
- `Celular` ← dígitos de `Situação Atendimento` original
- `Email` ← `Situação Deferimento` original (já era email)
- `Instituição` ← `Email` original se contém ` - `
- `Curso` ← `Celular` original se não for telefone
- `Aging Dias`, `Data Previsão`, `Data Conclusão` ← `""` (limpar)
- Escreve variantes com e sem acento em sincronia

#### Prioridade

`repairCaaExportRow` testa V2 antes de V1; se V2 detectado, aplica e retorna sem cair no V1. Padrões são mutuamente exclusivos pelos dados observados.

#### Endurecimento do validador

- `validateCaaUploadRows` threshold de misaligned: 40% → 25%.
- Mensagem atualizada para sinalizar tentativa de repair automático e sugerir reexportar se persistir.

#### Reprocessamento

- `node server/scripts/repairLatestCaaSnapshot.mjs` reaplica repair em todas as linhas do snapshot mais recente e re-roda `processSnapshot`.
- Snapshots antigos NÃO foram reprocessados (formato diferente, V1 já tinha rodado).

#### Resultado validado

- Snapshot `e2811ece` (data (1).xlsx, 29/05/2026 17:28):
  - Antes: open=2, lost_confirmed=1, **unknown=22**
  - Depois: open=24, lost_confirmed=1, **unknown=0**
- `GET /api/reports/caa/summary?scope=last_snapshot` retorna `current.open=24` ✓

#### Alternativas descartadas

- **Refatorar parsing de XLSX para tolerar headers misturados:** muito complexo (`xlsx` lib chama `sheet_to_json` com header automático); repair pós-parse é cirúrgico.
- **Bloquear upload e mandar refazer:** o arquivo é tudo que temos do dia; bloquear sem repair seria perda de visibilidade.
- **Reprocessar todos snapshots antigos:** usuário pediu só o atual; antigos têm formato diferente e já foram reduzidos.
- **Adicionar coluna `data_repaired`:** repair grava in-place em `processos_caa_rows.data` (snapshot original do XLSX bruto fica no `file_path` se necessário auditar).

### 29/05/2026 — Filtro por Ciclo em comparison e filas de ativação

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Resposta do `/api/reports/matriculados-comparison` passa a expor `available_ciclos` + `by_ciclo` (mesma shape do agregado, filtrada por ciclo). Roster de ativação aceita `?ciclo=2026/1` e devolve `available_ciclos`. Frontend exibe dropdown (relatórios) e chips (filas) **só quando há >1 ciclo distinto** no snapshot.

#### Motivação

Graduação e Pós viram ciclo em datas diferentes (Graduação já em 2026/2, Pós ainda em 2026/1). Somar os dois ciclos na contagem dá número enganoso. Hoje a confusão era visível no painel "Matriculados x Outras Bases" e nas filas.

#### Backend

- `server/services/baseComparisonService.js`:
  - Helper `extractAvailableCiclos(matByCanon)` extrai os ciclos distintos do snapshot matriculados, ordenados desc lexicográfico (`'2026/2' > '2026/1'`).
  - Helper `buildBlocksForMat(matByCanon, matIndex, otherSnaps, matSnap)` extraído do fluxo principal — recebe um `matByCanon` arbitrário (completo ou filtrado por ciclo).
  - Resposta nova: `{ ..., comparisons, by_ciclo: { '<ciclo>': { blocks } }, available_ciclos }`.
  - Nome do campo agregado **`comparisons`** preservado (não renomeado para `blocks`) por compatibilidade com o consumer já existente.
- `server/services/activationService.js`:
  - `getActivationRoster(category, opts)` aceita `opts.ciclo`. `available_ciclos` é calculado **antes** de qualquer filtro (sobre `rows` cacheado), então o seletor nunca some quando algum filtro está ativo.
  - Filtro de ciclo aplicado em pós-processamento in-memory (após stage filter e bb subgrupo filter), não dentro de `getIntersectionActivationList` — respeita o cache `buildRosterRowsCached` que não conhece ciclo.
- `server/routes/activation.js`: aceita `?ciclo=<valor>` e repassa.

#### Frontend

- `src/components/MatriculadosComparisonPanel.tsx`:
  - Dropdown `<select>` "Ciclo: [Todos] [2026/2] [2026/1] …" no cabeçalho, visível só com `available_ciclos.length > 1`.
  - Quando `'all'`: blocos renderizam o agregado **+** badges compactos `2026/2: X · 2026/1: Y` abaixo do número primário de cada bloco.
  - Quando ciclo específico: blocos renderizam `by_ciclo[ciclo].blocks` (sem os badges de quebra).
- `src/components/ActivationRosterTable.tsx`:
  - Estados `cicloFilter` / `availableCiclos` em todas as 6 categorias.
  - Chips "Ciclo: Todos / 2026/2 / 2026/1 …" abaixo dos chips de stage (e abaixo dos chips de subgrupo BB quando categoria === `acessos-blackboard`).
  - Reseta `page = 0` na troca; passa `ciclo` no `roster()`.

#### Alternativas descartadas

- **Cache segmentado por ciclo (chave nova):** desnecessário — o pós-filtro in-memory é trivialmente rápido sobre o `rows` já cacheado, e mantém o cache base único.
- **Filtro de ciclo dentro de `getIntersectionActivationList`:** quebraria o cache `buildRosterRowsCached` (chave teria que mudar). Pós-filtro é funcionalmente equivalente e mais simples.
- **Renomear `comparisons` → `blocks` no payload comparison:** quebraria o consumer existente sem ganho. Mantive `comparisons` no agregado e usei `blocks` dentro de `by_ciclo[ciclo]`.
- **Quebra por ciclo em todos os números do bloco (primary + secondary):** poluído visualmente. Apenas o número primário ganha os badges.

# INTEGRATION.md — Merge com `dcz-crm-sync`

Documento operacional para integrar este app (`tool_whatsapp_alunos`) ao projeto Flask `dcz-crm-sync` em um único ecossistema, mantendo Postgres compartilhado e identidade de usuário comum.

Última revisão: **03/06/2026** (modelo principal Opus 4.7)

---

## 1. Visão geral do app

Ferramenta WhatsApp de ativação de alunos. Stack:

| Camada | Tecnologia | Onde |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind | `src/` → `dist/` no build |
| Backend | Node 20 + Express 5 + ESM | `server/` |
| Banco | PostgreSQL 14+ | conexão via `DATABASE_URL` (lib `pg`) |
| Migrations | SQL puro, sequenciais idempotentes | `server/db/migrations/0NN_*.sql` |
| Container | Multi-stage Dockerfile | builder + runtime (Node 20 alpine) |
| Deploy atual | Easypanel (`banco-disparador-whatsapp`) | porta 3001 |

Mesmo processo Node serve `/api/*` E o build estático React (de `dist/`). Não há server-side rendering. Em dev, Vite (5173) faz proxy de `/api` para Node (3001).

---

## 2. Topologia recomendada do merge

Você marcou "ainda decido". Recomendação:

### A — **Lado a lado via Easypanel routes (recomendado)**

```
Easypanel domain
├─ /            → Flask  (dcz-crm-sync)         :5000
├─ /whatsapp/*  → Node   (tool_whatsapp_alunos) :3001
└─ /api/*       → ... a quem você quiser rotear
```

- **Vantagens:** mínimo refactor; cada app evolui no seu ritmo; rollback isolado; deploys independentes.
- **Desvantagens:** 2 containers, 2 builds, 2 logs (mas Easypanel já lida bem com isso).
- **Identidade compartilhada:** Flask injeta header `X-User-Id` no proxy; Node lê e resolve em `public.app_users`.

### B — Subapp via blueprint Python

Migrar toda a UI React/TypeScript para `routes/whatsapp.py` + Jinja2. **Não recomendado**: trabalho enorme, perde o stack já testado.

### C — Iframe

Frágil (cross-origin), navegação dentro do iframe não atualiza URL, sessões podem brigar. **Não recomendado**.

### D — Único container

Empacotar Flask + Node no mesmo Dockerfile com supervisord. Funciona, mas dificulta logs e troubleshooting. Só vale se o limite Easypanel for problema.

**→ Toda essa documentação assume cenário A.**

---

## 3. Banco — schema isolado

Escolha confirmada: **mesmo Postgres, nosso app no schema próprio.**

### 3.1 Por quê schema próprio (em vez de `public`)

- Isolamento lógico: `public.app_users` (Flask) vs `whatsapp.activation_dispatch_events` (nosso).
- Backup/restore granular (pode dropar 1 schema sem afetar o outro).
- Permissões diferenciadas (futuramente, role só pra `whatsapp`).
- Evita colisão de nomes (não temos `users`, mas `students` sim — colidiria se algum dia o Flask quisesse `students`).

### 3.2 Plano de migração

Hoje as 31 tabelas estão em `public`. Plano:

```sql
-- 1. Cria schema dedicado
CREATE SCHEMA IF NOT EXISTS whatsapp_app;

-- 2. Move TODAS as tabelas (uma vez só, durante manutenção)
ALTER TABLE public.academic_terms                       SET SCHEMA whatsapp_app;
ALTER TABLE public.acessos_blackboard_rows              SET SCHEMA whatsapp_app;
ALTER TABLE public.acessos_blackboard_snapshots         SET SCHEMA whatsapp_app;
ALTER TABLE public.activation_dispatch_events           SET SCHEMA whatsapp_app;
ALTER TABLE public.activation_dispatches                SET SCHEMA whatsapp_app;
ALTER TABLE public.activation_manual_outcomes           SET SCHEMA whatsapp_app;
ALTER TABLE public.activation_origem_ativacao_log       SET SCHEMA whatsapp_app;
ALTER TABLE public.activation_responses                 SET SCHEMA whatsapp_app;
ALTER TABLE public.caa_protocol_transitions             SET SCHEMA whatsapp_app;
ALTER TABLE public.caa_protocols                        SET SCHEMA whatsapp_app;
ALTER TABLE public.campaign_templates                   SET SCHEMA whatsapp_app;
ALTER TABLE public.campaign_types                       SET SCHEMA whatsapp_app;
ALTER TABLE public.crm_desfecho_sync_log                SET SCHEMA whatsapp_app;
ALTER TABLE public.docs_pendentes_rows                  SET SCHEMA whatsapp_app;
ALTER TABLE public.docs_pendentes_snapshots             SET SCHEMA whatsapp_app;
ALTER TABLE public.financeiro_rows                      SET SCHEMA whatsapp_app;
ALTER TABLE public.financeiro_snapshots                 SET SCHEMA whatsapp_app;
ALTER TABLE public.journey_settings                     SET SCHEMA whatsapp_app;
ALTER TABLE public.matriculados_rows                    SET SCHEMA whatsapp_app;
ALTER TABLE public.matriculados_snapshots               SET SCHEMA whatsapp_app;
ALTER TABLE public.processos_caa_rows                   SET SCHEMA whatsapp_app;
ALTER TABLE public.processos_caa_snapshots              SET SCHEMA whatsapp_app;
ALTER TABLE public.provavel_evasao_rows                 SET SCHEMA whatsapp_app;
ALTER TABLE public.provavel_evasao_snapshots            SET SCHEMA whatsapp_app;
ALTER TABLE public.scheduled_events                     SET SCHEMA whatsapp_app;
ALTER TABLE public.student_timeline_events              SET SCHEMA whatsapp_app;
ALTER TABLE public.students                             SET SCHEMA whatsapp_app;
ALTER TABLE public.whatsapp_campaign_contacts           SET SCHEMA whatsapp_app;
ALTER TABLE public.whatsapp_campaign_events             SET SCHEMA whatsapp_app;
ALTER TABLE public.whatsapp_campaigns                   SET SCHEMA whatsapp_app;
ALTER TABLE public.whatsapp_inbound_unmatched           SET SCHEMA whatsapp_app;
ALTER TABLE public.whatsapp_interactions                SET SCHEMA whatsapp_app;
ALTER TABLE public.whatsapp_message_logs                SET SCHEMA whatsapp_app;
ALTER TABLE public._migrations                          SET SCHEMA whatsapp_app;
```

### 3.3 Como o app fala com o schema

Hoje as queries no código são `select ... from caa_protocols` (sem qualificar). Duas opções de adaptação:

**Opção 1 — `search_path` no connection string (recomendado)**

Acrescente `?options=-csearch_path%3Dwhatsapp_app,public` no `DATABASE_URL` ou ajuste `server/db/client.js`:

```js
pool = new pg.Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DATABASE_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  options: '-c search_path=whatsapp_app,public',  // ← nova linha
});
```

Vantagem: zero refactor nas queries. `public.app_users` continua acessível pelo nome completo nas queries que precisam de cross-schema.

**Opção 2 — Qualificar todas as queries** (não recomendado, ~70 arquivos)

### 3.4 Cross-schema query (consultor → app_users)

Hoje gravamos `caa_protocols.consultor_responsavel_nome` como texto. Para resolver no painel:

```sql
SELECT
  cp.consultor_responsavel_nome,
  u.id          AS app_user_id,
  u.email_cruzeiro,
  u.role,
  COUNT(*) FILTER (WHERE cp.status = 'won_reverted') AS revertidos,
  COUNT(*) FILTER (WHERE cp.status IN ('lost_canceled','lost_confirmed')) AS perdidos
FROM whatsapp_app.caa_protocols cp
LEFT JOIN public.app_users u
  ON lower(u.username) = lower(cp.consultor_responsavel_nome)
  OR lower(u.email_cruzeiro) ILIKE lower(cp.consultor_responsavel_nome) || '%'
WHERE cp.consultor_responsavel_nome IS NOT NULL
GROUP BY cp.consultor_responsavel_nome, u.id, u.email_cruzeiro, u.role;
```

Match heurístico (nome do consultor é snapshot textual, não FK). Quando o merge acontecer e a UI precisar filtrar/agrupar por user.id, a query acima é o ponto de bridge.

---

## 4. Inventário

### 4.1 Tabelas (31 + `_migrations`)

| Domínio | Tabelas |
|---|---|
| **Régua/Jornada** | `journey_settings`, `scheduled_events`, `student_timeline_events`, `students` |
| **Campanhas legacy** | `campaign_templates`, `campaign_types`, `whatsapp_campaigns`, `whatsapp_campaign_contacts`, `whatsapp_campaign_events`, `whatsapp_message_logs`, `whatsapp_interactions`, `whatsapp_inbound_unmatched` |
| **Upload de bases** | `matriculados_snapshots/_rows`, `docs_pendentes_*`, `financeiro_*`, `acessos_blackboard_*`, `processos_caa_*`, `provavel_evasao_*` (6 pares) |
| **Ativação** | `activation_dispatches` (legacy), `activation_dispatch_events`, `activation_responses`, `activation_manual_outcomes`, `activation_origem_ativacao_log` |
| **CAA** | `caa_protocols`, `caa_protocol_transitions`, `crm_desfecho_sync_log` |
| **Calendário** | `academic_terms` |

26 migrations (`001` → `026`), todas idempotentes (`if not exists`). Rodar com `npm run migrate`.

### 4.2 Rotas HTTP top-level (14)

Todas em `/api/*`:

| Prefix | O que faz | Auth (`requireApiKey`) |
|---|---|---|
| `/api/health` | healthcheck | público |
| `/api/templates` | lista templates WhatsApp | público (GET) |
| `/api/send-message` | envio manual | parcial |
| `/api/campaigns` | CRUD campanhas legacy | parcial |
| `/api/campaign-types` | CRUD tipos | parcial |
| `/api/webhooks` | webhook entrada WhatsApp Cloud | público (com `WEBHOOK_VERIFY_TOKEN`) |
| `/api/students` | CRUD alunos | parcial |
| `/api/journeys` | CRUD jornadas | parcial |
| `/api/scheduled-events` | fila do scheduler | parcial |
| `/api/academic-terms` | CRUD turmas | parcial |
| `/api/journey-settings` | settings globais/por turma | parcial |
| `/api/reports` | painéis (overview, CAA, conversão, consultores) | parcial |
| `/api/base-uploads` | upload de XLSX (6 categorias) | parcial |
| `/api/activation` | filas, batch DataCrazy, respostas | parcial |
| `/api/maintenance` | crons manuais | `requireApiKey` (todas) |

"Parcial" = só rotas de escrita exigem API key. Leituras (GET) ficam abertas para facilitar dev local; em produção a API key é obrigatória se `APP_API_KEY` estiver setada.

### 4.3 Variáveis de ambiente (45)

Agrupadas por uso:

**Obrigatórias em produção:**
```
DATABASE_URL                          # connection string Postgres
APP_API_KEY                           # qualquer string forte; protege escrita
WHATSAPP_API_KEY                      # Meta Cloud API token
WHATSAPP_PHONE_NUMBER_ID              # Meta phone_number_id
WHATSAPP_BUSINESS_ACCOUNT_ID          # Meta WABA id
DATACRAZY_API_KEY                     # token da API pública DataCrazy
```

**Webhooks e callbacks:**
```
WEBHOOK_VERIFY_TOKEN                  # token do GET /api/webhooks
```

**DataCrazy CRM (campos customizados):**
```
DATACRAZY_BASE_URL                    # default: https://api.g1.datacrazy.io
DATACRAZY_CRM_BASE_URL                # default: deriva api.g1 → crm.g1
DATACRAZY_ORIGEM_ATIVACAO_FIELD       # nome humano (informativo)
DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID    # UUID — origem_ativacao no lead
DATACRAZY_DESFECHO_CAA_FIELD_ID       # UUID — Sim/Não do desfecho CAA
DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID  # UUID — nome do consultor responsável (NOVO)
```

**Rate limiters:**
```
WHATSAPP_MAX_SENDS_PER_SECOND         # default: 60 (limite Meta)
DATACRAZY_CRM_RATE_PER_SECOND         # default: 10
DATACRAZY_PAGE_DELAY_MS               # delay entre páginas de scan
DATACRAZY_DIRECT_SEARCH_THRESHOLD     # default: 100 (lote ≤ N usa busca direta)
DATACRAZY_DIRECT_SEARCH_CONCURRENCY   # default: 5 (paralelismo busca direta)
DATACRAZY_LEADS_PAGE_SIZE             # default: 100
DATACRAZY_MAX_PAGES                   # cap de segurança
```

**Scheduler/Crons:**
```
SCHEDULER_ENABLED                     # 'true' liga régua
SCHEDULER_INTERVAL_MS                 # tick em ms
SCHEDULER_BATCH_SIZE                  # max eventos por tick
SCHEDULER_STALE_LOCK_MIN              # destrava locks parados (min)
MIN_INTERVAL_SECONDS                  # cool-down jornada
CRM_DESFECHO_SYNC_INTERVAL_HOURS      # default: 2
CRM_DESFECHO_SYNC_LOOKBACK_DAYS       # default: 14
WEBHOOK_MATCH_WINDOW_HOURS            # janela bind webhook → dispatch
```

**Provedores (plug-in):**
```
TEMPLATES_PROVIDER                    # 'whatsapp' | 'mock'
MESSAGES_PROVIDER                     # 'whatsapp' | 'mock'
EMAIL_PROVIDER, EMAIL_API_KEY         # opcional
WHATSAPP_BASE_URL                     # default Meta Graph v21+
```

**Upload e limites:**
```
JSON_BODY_LIMIT                       # default: '100mb'
BASE_UPLOAD_MAX_BYTES, BASE_UPLOAD_MAX_ROWS, BASE_UPLOAD_INSERT_CHUNK,
BASE_UPLOAD_MAX_CSV_BYTES, BASE_UPLOAD_STATEMENT_MS, BASE_ROW_PAGE_SIZE
REPORT_OVERVIEW_CACHE_TTL_MS
ACTIVATION_SEND_DELAY_MS              # delay entre envios no batch
ACTIVATION_TEMPLATE_LANGUAGE          # default: pt_BR
```

**Banco:**
```
DATABASE_SSL                          # 'true' em Supabase/RDS
DATABASE_POOL_MAX                     # default: 10
PORT                                  # default: 3001
```

### 4.4 Dependências runtime

Mínimas (instaladas via `npm ci` no Dockerfile):

```
@supabase/supabase-js   # apenas para o cliente, opcional
cors, express, dotenv   # servidor
pg                      # postgres
fflate, papaparse, xlsx # parsing arquivos
react, react-dom,
react-router-dom,
lucide-react            # UI
uuid                    # ids
```

Dev (`npm prune --omit=dev` no runtime stage):
```
vite, typescript, eslint, @vitejs/plugin-react,
tailwindcss, postcss, autoprefixer, concurrently,
@types/*
```

### 4.5 Filesystem (não-banco)

| Path | O que |
|---|---|
| `server/uploads/manual_outcomes/` | anexos de desfecho manual (PNG/JPG/PDF) — criado no boot via `fs.mkdirSync` |
| `dist/` | build estático React (gerado pelo Vite) |
| `server/db/migrations/*.sql` | 26 arquivos SQL |

**Atenção pro merge:** `server/uploads/` precisa ser volume persistente no Easypanel se a feature manual_outcomes for usada (hoje não usamos UI manual, só leitura de log via CRM sync — mas tabela existe). Plano B: migrar para Supabase Storage (lib `@supabase/supabase-js` já está no projeto).

---

## 5. Identidade — leitura via `public.app_users`

Hoje o app **não tem autenticação**. Identidade do consultor é capturada **apenas via DataCrazy** (campo customizado do lead, vide AGENTS.md decisão 03/06/2026).

Quando o merge acontecer e você quiser proteger as rotas com login real:

### 5.1 Middleware proposto

Criar `server/middleware/dczAuth.js` (não criado ainda — fica como TODO post-merge):

```js
import { query } from '../db/client.js';

/**
 * Lê o user_id do header X-User-Id (injetado pelo proxy do Flask após validar
 * sessão) e popula req.user com a linha de public.app_users. Sem header,
 * retorna 401 (se DCZ_AUTH_REQUIRED='true').
 */
export async function dczAuth(req, res, next) {
  const userId = Number(req.headers['x-user-id'] || 0);
  if (!userId) {
    if (String(process.env.DCZ_AUTH_REQUIRED).toLowerCase() === 'true') {
      return res.status(401).json({ error: 'X-User-Id ausente' });
    }
    return next();  // dev: permite passar sem auth
  }
  try {
    const { rows } = await query(
      `SELECT id, username, role, kommo_user_id, email_cruzeiro,
              categoria, datacrazy_user_id
         FROM public.app_users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Usuário não encontrado' });
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}
```

Plugar em `server/index.js` antes das rotas:

```js
import { dczAuth } from './middleware/dczAuth.js';
// app.use(express.json(...));      // já existe
app.use('/api', dczAuth);            // após express.json, antes das rotas
```

**Substituir `requireApiKey`?** Não imediatamente. Mantém `APP_API_KEY` para o n8n e integrações server-to-server; `dczAuth` para sessões humanas via browser.

### 5.2 Bridge `consultor_responsavel_nome` → `app_users.id`

Já documentado em §3.4. A coluna nova (migration 026) é texto livre, populada por:
1. Webhook do n8n em `POST /api/activation/responses` (campo `consultor_responsavel_nome` no body).
2. `crmDesfechoSyncService` ao detectar desfecho CAA (lê `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID`).

Resolução para `app_users.id` é responsabilidade do consumer (painel, joins).

---

## 6. Integrações externas

### 6.1 DataCrazy CRM

- **API pública:** `https://api.g1.datacrazy.io` (envio de templates WhatsApp, busca leads, GET additionalFields).
- **CRM web:** `https://crm.g1.datacrazy.io` (PUT additionalFields — não exposto na API pública).
- **Rate limit aplicado:** 10 req/s configurável.
- **Campos customizados usados:**
  - `origem_ativacao` (UUID em `DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID`)
  - desfecho CAA Sim/Não (UUID em `DATACRAZY_DESFECHO_CAA_FIELD_ID`)
  - consultor responsável (UUID em `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID`) — **opcional, novo**
- **Auth:** `Authorization: Bearer <DATACRAZY_API_KEY>`

### 6.2 WhatsApp Cloud API (Meta)

- **Base URL:** `WHATSAPP_BASE_URL` (default Graph v21+).
- **Rate limit aplicado:** 60 msg/s sliding window (limite oficial Meta para Tier 4).
- **Phone number:** `WHATSAPP_PHONE_NUMBER_ID`.
- **Webhook entrada:** `POST /api/webhooks` (Meta verifica via `WEBHOOK_VERIFY_TOKEN`).

### 6.3 n8n

Consumidor de eventos. Fluxos esperados:

1. **Resposta WhatsApp:** webhook DataCrazy → n8n → `POST /api/activation/responses` (com `Authorization: Bearer <APP_API_KEY>`).
2. **Limpa `origem_ativacao` após resposta:** n8n → `PUT crm.g1/api/crm/additional-fields/lead/{id}/{field_id}` com `{value: ""}`. **Crítico** — sem isso o campo permanece preenchido e gera falso-positivo em respostas subsequentes.

---

## 7. Crons internos (rodam no processo Node)

Definidos em `server/index.js`:

| Cron | Frequência | O que faz |
|---|---|---|
| Scheduler da régua | a cada `SCHEDULER_INTERVAL_MS` | despacha `scheduled_events` pendentes |
| Cleanup `origem_ativacao` stale | a cada 24h | limpa campo no CRM de leads ativados há >72h |
| Sync de desfecho CAA | a cada `CRM_DESFECHO_SYNC_INTERVAL_HOURS` (default 2h) | lê desfecho + consultor responsável, cria manual_outcome |
| Pré-aquecimento comparação | 1× no boot (+3s) | popula cache do painel matriculados |
| Pré-aquecimento overview CAA | 1× no boot (+8s) | popula cache do painel CAA |

**Implicação pro merge:** se rodar em **mais de 1 réplica**, os crons rodam N vezes em paralelo. Hoje o Easypanel roda 1 réplica única. Se subir, precisa adicionar lock distribuído (advisory lock no Postgres já basta — TODO se acontecer).

---

## 8. Build & Deploy

### 8.1 Dev local

```bash
# Pré-requisitos: Node 20+, Postgres rodando, .env preenchido
npm install
npm run migrate           # aplica migrations pendentes
npm run dev               # sobe Vite (5173) + Node (3001) com proxy
```

### 8.2 Produção (atual — Easypanel)

```bash
docker build -t whatsapp-tool .
docker run -p 3001:3001 --env-file .env whatsapp-tool
```

Multi-stage: builder gera `dist/`, runtime serve em Node 20 alpine como user `node` (não-root). Expõe 3001.

### 8.3 Em ambiente Flask+Node lado a lado

No Easypanel:

1. Criar **2 serviços** no mesmo project: `dcz-crm-sync` (Python) e `whatsapp-tool` (Node).
2. Apontar ambos para o mesmo Postgres (uma instância).
3. Configurar **routes** no domínio principal:
   - `/` → `dcz-crm-sync:5000`
   - `/whatsapp` (ou `/disparador`) → `whatsapp-tool:3001`
4. Reverse-proxy do Easypanel já lida com header forwarding.
5. Quando ativar identidade compartilhada: configurar Flask para injetar `X-User-Id` no path `/whatsapp/*` (middleware Flask). Node lê via `dczAuth`.

---

## 9. Checklist de merge (sequência sugerida)

Fase 0 — **Banco**
- [ ] Backup full do Postgres atual
- [ ] Aplicar `CREATE SCHEMA whatsapp_app` + `ALTER TABLE ... SET SCHEMA` (script §3.2)
- [ ] Atualizar `DATABASE_URL` com `?options=-csearch_path%3Dwhatsapp_app,public` OU editar `client.js` (§3.3)
- [ ] Smoke test: `node server/scripts/diagCaaQueue.mjs` (qualquer script de leitura) ainda funciona
- [ ] Smoke test: dashboard Flask continua acessando `public.app_users` normal

Fase 1 — **Deploy lado a lado**
- [ ] Subir `whatsapp-tool` no mesmo project Easypanel do `dcz-crm-sync`
- [ ] Configurar route `/whatsapp` → `whatsapp-tool:3001`
- [ ] Verificar acesso via browser ao `/whatsapp/`
- [ ] Confirmar que as 14 rotas `/api/*` respondem
- [ ] Validar que `DATACRAZY_*`, `WHATSAPP_*`, `APP_API_KEY` estão no env do container novo

Fase 2 — **Identidade**
- [ ] Adicionar `DCZ_AUTH_REQUIRED=false` (modo permissivo no início)
- [ ] Criar `server/middleware/dczAuth.js` (template em §5.1)
- [ ] Plugar no `index.js` antes das rotas
- [ ] Flask: middleware que injeta `X-User-Id` nos requests pra `/whatsapp/*`
- [ ] Testar com user real navegando, conferir `req.user` chega populado
- [ ] Trocar `DCZ_AUTH_REQUIRED=true` quando estável

Fase 3 — **Consultor responsável (já pronto, falta config)**
- [ ] Criar/identificar UUID do campo "consultor responsável" no DataCrazy CRM
- [ ] Adicionar `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID=<uuid>` no env
- [ ] Atualizar fluxo do n8n pra passar `consultor_responsavel_nome` no `POST /api/activation/responses`
- [ ] Validar: dispara → aluno responde → consultor assume → 2h depois sync popula `caa_protocols.consultor_responsavel_nome`
- [ ] Painel `/whatsapp/reports` (aba CAA) mostra consultor agregado

Fase 4 — **Cleanup pós-merge (opcional)**
- [ ] Avaliar se `APP_API_KEY` ainda é necessária (mantém pra integração n8n)
- [ ] Avaliar se algum endpoint legacy (`/api/campaigns`, `/api/students`) pode sair (não usado pelo fluxo de ativação)
- [ ] Migrar `server/uploads/manual_outcomes/` pra Supabase Storage se for usar UI manual

---

## 10. O que **NÃO** precisa mudar no código

- Estrutura de pastas (`server/`, `src/`) — fica autocontida.
- Migrations existentes — todas idempotentes; apenas a SET SCHEMA é one-shot.
- Endpoints e contratos JSON — clientes (n8n, browser) não percebem o merge.
- Stack frontend — React/Vite continua, build vai pra `dist/`.
- Dockerfile — funciona standalone, sem mudança.

---

## 11. O que **PODE** mudar no código (post-merge)

| Item | Quando | Esforço |
|---|---|---|
| Adicionar `dczAuth` middleware | quando ativar identidade | ~30min |
| Remover `requireApiKey` em rotas humanas (mantém pra n8n) | após validar `dczAuth` | ~15min |
| Migrar uploads para Supabase Storage | se usar UI manual | ~2h |
| Consolidar `consultor_responsavel_nome` em FK pra `app_users.id` | quando o DataCrazy estiver enviando IDs estáveis | ~3h (migration + service + painel) |
| Lock distribuído nos crons | se for escalar pra >1 réplica | ~1h |

---

## 12. Documentação correlata

- `AGENTS.md` — fonte de verdade das decisões técnicas (sessão 22/05 → 03/06/2026). Inclui decisão completa sobre consultor responsável (03/06/2026) e o falso start revertido.
- `README.md` — visão geral pública.
- `server/db/migrations/*.sql` — schema completo, comentado.

---

## 13. Contato técnico

Identidades-chave (pra debugging):

- **RGM de teste do usuário:** 47277581 (CPF 44765254828, lead DataCrazy `25f79ea0-7474-4390-bad6-e95919396337`)
- **FIELD_ID `origem_ativacao`:** `3a22bd69-4578-4740-87c1-29e72fbbac22`
- **Easypanel project:** `banco-disparador-whatsapp` (host `banco-disparador-whatsapp.6tqx2r.easypanel.host`)
- **Repo:** github.com/Mikyxx1234/tool_whatsapp_alunos

---

Fim do documento.

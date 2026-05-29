# Disparador WhatsApp

Ferramenta web para disparo de campanhas de WhatsApp a partir de uma base CSV.
Frontend em **React + Vite + Tailwind**, backend em **Node/Express** atuando
como proxy seguro para as APIs do WhatsApp Cloud (Meta) e da DataCrazy.

## Arquitetura

```
project/
├── server/                       # backend Express (proxy seguro)
│   ├── index.js
│   ├── routes/
│   │   ├── templates.js          # GET  /api/templates
│   │   └── sendMessage.js        # POST /api/send-message
│   └── services/
│       ├── datacrazyClient.js    # envio de mensagem (DataCrazy)
│       └── whatsappClient.js     # listagem de templates (Meta)
├── src/
│   ├── App.tsx                   # orquestra a página
│   ├── components/               # UI (Bolt) + componentes novos
│   ├── services/
│   │   ├── apiClient.ts
│   │   ├── csvParser.ts
│   │   └── campaignQueue.ts
│   └── utils/
│       ├── phoneNormalizer.ts
│       ├── templateVariables.ts
│       └── campaignStorage.ts
├── .env.example
└── vite.config.ts                # proxy /api -> backend
```

## Setup

### 1. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

```dotenv
DATACRAZY_API_KEY=seu_token_datacrazy
DATACRAZY_BASE_URL=https://api.datacrazy.ai

WHATSAPP_API_KEY=seu_token_meta
WHATSAPP_BASE_URL=https://graph.facebook.com/v20.0
WHATSAPP_BUSINESS_ACCOUNT_ID=id_da_sua_waba

TEMPLATES_PROVIDER=whatsapp   # ou "datacrazy"
PORT=3001
```

> O `.env` está no `.gitignore` e nunca deve ser comitado.

### 2. Instalar dependências

```bash
npm install
```

### 3. Rodar em desenvolvimento

Sobe **frontend (5173)** e **backend (3001)** em paralelo:

```bash
npm run dev
```

O Vite faz proxy automaticamente de `/api/*` para o backend, então o
frontend acessa `/api/templates` e `/api/send-message` sem precisar configurar
URLs diferentes em produção/dev.

### Scripts úteis

| Comando             | Descrição                              |
| ------------------- | -------------------------------------- |
| `npm run dev`       | Frontend + backend em paralelo         |
| `npm run dev:web`   | Apenas Vite                            |
| `npm run dev:server`| Apenas backend (com `node --watch`)    |
| `npm run server`    | Backend em modo "produção"             |
| `npm run build`     | Build de produção do frontend          |
| `npm run typecheck` | TS sem emitir saída                    |

## Endpoints do backend

### `GET /api/health`
Sanidade do backend e flags de configuração.

### `GET /api/templates`
Retorna templates aprovados do provedor configurado.

```json
{
  "provider": "whatsapp",
  "templates": [
    {
      "id": "1234567890",
      "name": "boas_vindas",
      "language": "pt_BR",
      "status": "APPROVED",
      "category": "MARKETING",
      "components": [...]
    }
  ]
}
```

### `POST /api/send-message`
Envia uma mensagem via DataCrazy.

Body:
```json
{
  "phone": "5511999999999",
  "templateName": "boas_vindas",
  "language": "pt_BR",
  "variables": { "nome": "João", "curso": "Administração" }
}
```

Sucesso:
```json
{ "success": true, "phone": "5511999999999", "messageId": "abc123" }
```

Erro:
```json
{ "success": false, "phone": "5511999999999", "error": "mensagem do erro" }
```

## Fluxo da campanha

1. Upload do CSV (qualquer separador, detecção automática via Papaparse).
2. Telefones brasileiros são normalizados (apenas dígitos, DDI 55).
3. Linhas marcadas como `valid`, `invalid` ou `duplicate`.
4. Frontend busca `/api/templates` ao abrir a página.
5. Usuário escolhe um template aprovado.
6. Ao confirmar o disparo, a fila (`processCampaignQueue`) percorre os
   contatos válidos chamando `/api/send-message` com o intervalo configurado.
7. Cada linha vai para `pending` → `sending` → `sent` ou `error`.
8. O usuário pode cancelar a qualquer momento.
9. Ao final, a campanha é salva no `localStorage` (chave
   `disparador_whatsapp_campaign_history_v1`).

## TODOs marcados no código

Todos os pontos que dependem do formato exato da API estão marcados com
`TODO [CURSOR]`:

- `server/services/datacrazyClient.js`: confirmar `SEND_MESSAGE_PATH`,
  `LIST_TEMPLATES_PATH` e formato do payload.
- `server/services/whatsappClient.js`: confirmar versão da Graph API.
- `src/utils/campaignStorage.ts`: trocar `localStorage` por Supabase ou
  backend dedicado quando o histórico for persistido server-side.
- `src/utils/templateVariables.ts`: ajustar parser de templates caso o
  provedor retorne em outro formato.

## Segurança

- Tokens só vivem no `.env` do servidor.
- O frontend conversa apenas com o backend (`/api/*`).
- Avisos de consentimento exibidos na UI.
- `.env` está no `.gitignore`.

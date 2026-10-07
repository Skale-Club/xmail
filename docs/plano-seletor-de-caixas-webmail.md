# Plano: seletor de caixas do webmail (botão + painel)

Data: 2026-10-06. Decisão do Vanildo: seletor vira **botão + painel**; **sem** "All inboxes" por enquanto.
Só plano, nada implementado.

## O problema (medido no print de produção, viewport ≈ 1000px)

| Sintoma | Causa no código |
|---|---|
| Pastas (Inbox, Sent, Drafts, Trash) somem abaixo da dobra; só uma ponta do "Inbox" aparece embaixo do Compose | `SidebarContent` em `MailLayout.tsx:80-200` renderiza o `MailboxSidebarSwitcher` **antes** do Compose e das pastas, e a lista de caixas tem altura própria com scroll interno |
| Cabem 5 caixas de 33; cada linha tem ícone 48px + nome + e-mail + selo | linha de 2 textos + avatar em `MailboxSidebarSwitcher.tsx` (~80-160) |
| Warm-up (`agenda@`, `contato@`) com "99+" domina a lista; as `info@` (trabalho) ficam no meio | agrupamento só por domínio em `mailbox-navigation.ts:58` (`groupMailboxes`); o cliente não sabe quais caixas são warm-up |
| Coluna de e-mails com ~290px: "nore… Repo…" | `ResizablePanels` sem largura mínima em px (só percentual) e barra lateral `w-72` fixa em `MailLayout.tsx:315` |

## Desenho alvo

```
┌ barra lateral (w-72 / w-[72px] recolhida) ─────────┐
│ ☰  Xmail                                           │
│ ┌────────────────────────────────────────────────┐ │
│ │ ▣ info@skale.club                     12  ▾    │ │  ← botão: caixa atual + não lidas
│ └────────────────────────────────────────────────┘ │
│ [ + Compose ]                                      │
│ Inbox 12 · Starred · Sent · Drafts · Archive ·     │  ← pastas SEMPRE visíveis
│ Spam · Trash                                       │
│ …                                                  │
│ Settings                                           │
└────────────────────────────────────────────────────┘

Painel (Popover ancorado no botão, 360px, max-h 70vh):
┌──────────────────────────────────────────────┐
│ 🔍 Search mailboxes…                 Ctrl+K  │
│ PINNED                                       │
│   info@skale.club                       12   │
│ WORK                                   (8)   │  ← info@ dos domínios da operação
│   info@skleanings.com                   40   │
│   info@xkedule.com                       1   │
│ WARM-UP                        (24) ▸ show   │  ← recolhido por padrão
│ OTHER ORGANIZATIONS             (4) ▸ show   │  ← já existe (toggle)
│ ──────────────────────────────────────────── │
│ + Add mailbox          ⚙ Manage mailboxes    │
└──────────────────────────────────────────────┘
```

Uma linha por caixa: `local@domínio` (domínio em muted), selo de não lidas à direita, pin no hover.
Recolhida (72px): o botão vira só o avatar/inicial da caixa atual com o selo; o painel abre igual.

## Como o cliente sabe o que é warm-up

Hoje `GET /api/mail/mailboxes` devolve `unreadCount`, `organizationName`, `isOperationMailbox`
(`mailboxes.ts:141-173`). Adicionar **`role: 'work' | 'warmup' | 'other'`**, calculado no servidor:

- `warmup`: existe `email_accounts` com o mesmo e-mail e `warmup_only = true` (regra 2 das três caixas;
  `CLAUDE.md`). Um `LEFT JOIN email_accounts ON lower(email)` na mesma query agrupada que já existe.
- `other`: `isOperationMailbox = false` (já calculado).
- `work`: o resto (as `info@`, `dmarc@`, e a caixa própria do admin).

Sem migration: é só leitura cruzada. Sem mudar nada em `email_accounts`.

## Fases

### Fase 1 — Servidor (pequena)
- `src/server/routes/mail/mailboxes.ts`: campo `role` na resposta de `GET /`; join por e-mail com
  `email_accounts.warmup_only`. Teste unitário da classificação (work / warmup / other).
- `src/hooks/useMailbox.tsx`: tipo `Mailbox` ganha `role`.

### Fase 2 — Seletor novo
- Novo `src/components/mail/MailboxSwitcherButton.tsx` (botão) + `MailboxSwitcherPanel.tsx`
  (conteúdo do Popover, usando `src/components/ui/popover` já existente — Radix cuida de Esc, clique
  fora e foco).
- `mailbox-navigation.ts`: `buildMailboxSections` passa a devolver `pinned / work / warmup / other`
  (hoje devolve pinned + grupos por domínio + others). Dentro de cada seção, ordenar por não lidas
  desc, depois nome. Busca continua cobrindo todas as seções, inclusive recolhidas (quando há busca,
  as seções recolhidas abrem sozinhas).
- Estado por usuário em localStorage (chaves já existem em `pinnedMailboxesStorageKey` /
  `showOtherOrgsStorageKey`; adicionar `warmupExpandedStorageKey`), tudo em try/catch.
- Teclado: `Ctrl+K` e `g m` abrem o painel com foco na busca (evento `FOCUS_MAILBOX_SEARCH_EVENT`
  já existe); setas navegam, Enter seleciona, Esc fecha e devolve o foco ao botão.
- Trocar de caixa fecha o painel e mantém a pasta atual (Inbox→Inbox).
- `MailLayout.tsx`: substituir `<MailboxSidebarSwitcher>` pelo botão; pastas e Compose voltam a
  ocupar a barra lateral. Remover `MailboxSidebarSwitcher.tsx` (e seu teste) quando o novo estiver
  coberto.
- Testes jsdom: seções e ordem; warm-up recolhido por padrão e aberto na busca; seleção fecha o
  painel; recolhida mostra só avatar; `Ctrl+K` foca a busca.

### Fase 3 — Layout por largura
- `ResizablePanels.tsx`: largura **mínima em px** para a lista (360px) e para a leitura (420px), além
  do percentual. Quando `lista + leitura` não cabem (`container < 780px`), o componente passa para
  **modo sobreposto**: a lista ocupa tudo e a leitura abre por cima (drawer) com botão Back — igual
  ao fluxo mobile que `FolderPage` já tem, mas por largura do container, não por `isMobile`.
- `MailLayout.tsx`: abaixo de `xl` (1280px) a barra lateral começa recolhida (72px) por padrão,
  respeitando a escolha do usuário se ele já salvou (`readSidebarCollapsed`).
- `EmailList.tsx`: remetente e assunto com truncamento honesto (uma linha cada, `min-w-0`), sem
  cortar em 5 caracteres; data em formato curto ("Yesterday" → "Yest."? não — manter, mas com
  `shrink-0` e a coluna de texto com `flex-1 min-w-0`).
- Conferir em 1000, 1280, 1366 e 1920px via `javascript_tool` em produção (scrollWidth == clientWidth;
  largura real de cada coluna).
- **Implementado (2026-10-06):** `ResizablePanels` ganhou `minLeftPx` 360, `minRightPx` 420 e `maxLeftPx` 480 (o teto vem do critério 5: lista entre 360 e 480px em 1920); abaixo de 780px vira drawer (render-prop `{ overlay, close }`, `hasRight`, `onCloseRight`, Esc fecha fora de campos/diálogos). O Back do drawer é `DetailBackBar` (espelha o do `EmailDetailPage`; o do mobile é markup dentro da página, não componente). `MailLayout` usa `useSidebarCollapsed` (`sidebar-collapse.ts`): preferência salva vence, senão colapsada abaixo de 1280px. Em `EmailList` a causa do truncamento era a soma de colunas fixas (ponto, checkbox, estrela, avatar, data, ações no hover) comendo ~220px de uma lista de ~290px: a data foi para a linha do remetente, o clipe para a linha do assunto e as ações de hover viraram overlay absoluto. Falta só a conferência em produção (1000/1280/1366/1920px).

### Fase 4 — E-mail novo aparece na hora (push por SSE)

**Por que:** o Gmail avisa o navegador no instante em que o e-mail chega. O nosso webmail, até
2026-10-06, não atualizava nunca; desde o deploy de hoje checa a pasta aberta a cada 30 s
(`useMail.ts:168-204`, só com a aba visível, mais ao voltar para a aba). Falta o "instantâneo".

**Reaproveita o que já existe:** a Inbox de outreach tem um bus pub/sub em processo
(`src/server/lib/inbox-events.ts`: `publishInboxEvent`/`subscribeToInboxEvents`, limites por
assinante, heartbeat de 25 s) e uma rota SSE (`GET /api/outreach/unified-inbox/events`,
`unified-inbox.ts:301`) consumida por `useUnifiedInboxEvents.ts` via `fetch` + `ReadableStream`
(não `EventSource`, porque precisa do header `Authorization`). O webmail ganha o equivalente,
escopado por **caixa** em vez de organização.

**Servidor**
- `src/server/lib/mailbox-events.ts`: bus igual ao de inbox-events, chaveado por `mailboxId`.
  Evento `{ mailboxId, folderId, kind: 'message.new' | 'message.updated' | 'folder.counts', at }`.
  Sem corpo de mensagem no evento (só ids): o cliente refaz a leitura pela API normal.
- Publicar em todo caminho que grava `mail_messages` de uma caixa nativa:
  `mx-server.ts:126` (chegada por MX — o caso que importa), `smtp-server.ts:108` e
  `native-send.ts:136` (cópia em Sent), `routes/mail/send.ts:699`, `mail-sync.ts:416`
  (caixas espelhadas), `move-messages.ts` (mudança de pasta) e `folder-counts.ts`
  (recontagem → `folder.counts`). Publicar **depois** do commit, nunca dentro da transação.
- `GET /api/mail/mailboxes/:id/events`: SSE com `checkUserMailboxAccess` (dono ou admin), mesmos
  headers e heartbeat da rota de outreach, limite de assinantes por usuário. Como o processo é
  único (um container), o bus em memória basta; não precisa de Redis.
- Teste unitário: publicar para a caixa A não chega no assinante da caixa B; insert no MX publica.

**Cliente**
- `src/hooks/useMailboxEvents.ts`, cópia adaptada de `useUnifiedInboxEvents.ts`: assina a caixa
  selecionada; reconecta com backoff; cai para o polling de 30 s quando o stream não está
  conectado (o polling já existe e fica como reserva — quando o SSE está "live", o intervalo
  sobe para 2 min).
- Ao receber `message.new` da pasta aberta: refaz a página 1 da lista (mesmo caminho do poll,
  `fetchPage(1)` + comparação de assinatura) e atualiza `unreadCount` da caixa e da pasta sem
  refetch geral. Em outra pasta: só atualiza os selos.
- Indicador discreto "Live" / "Reconnecting…" junto do botão de refresh da pasta (há um igual
  no outreach, `InboxSyncStatus`).
- Opcional, barato: título da aba com `(N)` não lidas da pasta aberta, como o Gmail.

**Aceite**
1. E-mail enviado de fora para `info@skale.club` aparece na lista em ≤ 3 s com a aba aberta, sem
   clicar em nada; o selo da caixa e o da pasta Inbox sobem juntos.
2. Com o SSE derrubado (bloquear a rota no DevTools), a lista ainda atualiza em ≤ 30 s.
3. Duas abas na mesma caixa recebem o evento; uma aba em outra caixa não recebe.
4. Nenhum evento carrega assunto, remetente ou corpo (checar no Network).

Estimativa: ≈ 2 h de implementação + revisão. Sem migration.

- **Implementado (2026-10-06):** `lib/mailbox-events.ts` (bus por caixa, teto de 6 streams por usuário e 2000 no total) e `routes/mail/events.ts` (`GET /api/mail/mailboxes/:mailboxId/events`, 429 acima do teto). Em vez de espalhar `publish` por cada gravador, `emitFolderChange` (`lib/mail-events.ts`, já chamado depois do commit pelo MX, SMTP, IMAP, `move-messages` e `deleteMessagesPermanently`) agora também publica (`new` → `message.new`; `flags`/`expunge` → `message.updated`); `recomputeFolderCounts` publica `folder.counts`; publicação direta só onde não havia `emitFolderChange` (`native-send` Sent, rascunho em `send.ts`, `mail-sync` uma vez por pasta, read/star em `messages.ts`). Cliente: `useMailboxEvents` (registro por módulo = uma conexão por caixa e aba, backoff 1s→30s com jitter, watchdog de 70 s sem heartbeat, resync ao reconectar), `useMailboxLiveSync` no `MailLayout` (selos), `useInfiniteMessages` (checagem da página 1 no `message.new`; poll 120 s se live, 30 s senão), `LiveIndicator` ao lado do refresh e `(N)` no título. Falta só a conferência em produção dos 4 critérios de aceite.

### Fora deste plano (anotado para depois)
- "All work inboxes" (lista unificada das `info@`) — pede endpoint novo de mensagens cross-mailbox;
  o Vanildo pediu para deixar para depois.
- Ocultar de vez as caixas de warm-up do webmail — hoje elas são a única forma de ver o que o
  warm-up está fazendo; por isso ficam recolhidas, não escondidas.

## Critérios de aceite
1. Com a barra lateral aberta em 1366×768, Compose e as 7 pastas aparecem sem rolar.
2. Abrir o painel, digitar "xked" e dar Enter troca para `info@xkedule.com` em ≤ 3 teclas depois de `Ctrl+K`.
3. Nenhuma caixa de warm-up aparece sem expandir "Warm-up", exceto quando a busca a encontra.
4. Em 1000px de largura: sem scroll horizontal; lista ≥ 360px; abrir um e-mail cobre a lista e Back volta.
5. Em 1920px: três colunas, lista entre 360 e 480px, leitura com o resto.
6. `tsc` (duas configs), lint zero warnings, vitest (`--maxWorkers=2`) verdes.

## Ordem de execução e custo
Um agente Sonnet por vez (PC limitado): Fase 1 (≈20 min) → Fase 2 (≈1h30) → Fase 3 (≈1h) →
Fase 4 (≈2h). Revisão Opus no fim das Fases 2, 3 e 4. A Fase 4 é independente das outras e pode
subir antes, se for prioridade. Deploy só quando o Vanildo mandar.

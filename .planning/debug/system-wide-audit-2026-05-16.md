---
status: diagnosed
trigger: "System-wide audit of SkaleClub Mail — find bugs, inconsistencies, dead code, schema/RLS issues, broken routes, technical debt"
created: 2026-05-16T00:00:00Z
updated: 2026-05-16T00:00:00Z
---

## Current Focus

hypothesis: Auditoria sistêmica revelou múltiplas categorias de problemas — tooling (ESLint quebrado), drift de schema vs migrations, RLS bypass (intencional mas mal-documentado), bugs lógicos em cascade e health, alguns issues de segurança (SSRF, falta de auth em endpoints), e dead code/inconsistências.
test: Lint/tsc/build + leitura completa de rotas críticas, RLS, lib utilities.
expecting: Plano robusto de remediação por severidade.
next_action: Apresentar diagnóstico ao usuário. NÃO aplicar fixes nesta sessão.

## Symptoms

expected: Sistema multi-tenant Postal-like 100% funcional (auth Supabase, orgs/domains/messages/webhooks, tracking, RLS, schema Drizzle consistente, Express 5 sem regressões, frontend React Query + shadcn).
actual: Desconhecido — auditoria solicitada. Suspeita de regressões acumuladas.
errors: Descobrir via lint, tsc --noEmit, build, schema diff, code review.
reproduction: N/A — auditoria estática.
started: v1.1, Phase 09 schema-hardening marked completed.

## Eliminated

(nenhuma hipótese eliminada — auditoria multi-camada, todas as áreas examinadas)

## Evidence

- timestamp: layer-1
  checked: `npm run lint`
  found: ESLint 8.57.1 retorna "couldn't find a configuration file". Não existe `.eslintrc*` nem `eslint.config.*` na raiz nem em `src/`. Script `lint` no package.json é DEAD CODE — nunca pode passar.
  implication: A guarda "lint --max-warnings 0" prometida pelo CLAUDE.md NÃO está sendo executada. Qualquer CI que confiar nela passa trivialmente errado. Nenhum padrão de qualidade é enforçado.

- timestamp: layer-1
  checked: `npx tsc --noEmit`
  found: 1 erro — `src/components/AppLogo.tsx(12,23): error TS6133: 'isSuccess' is declared but its value is never read.`
  implication: Type-check falha. CI/build deveria pegar isso. Apenas 1 erro = barato de consertar. (build:server passa porque `tsconfig.server.json` exclui `src/components/`.)

- timestamp: layer-1
  checked: `npm run build` (client + server)
  found: Ambos passam. Vite emite warning sobre `<script src="/app-config.js">` sem `type="module"` — mas isso é proposital (script injetado dinamicamente em runtime via `/app-config.js` route).
  implication: Builds funcionam. Warning Vite é cosmético mas indica que o approach de runtime-config força a indexação no template HTML, o que dispara o aviso. Considerar mover para `<script type="text/javascript" src="..."></script>` explícito.

- timestamp: layer-1
  checked: Drizzle migrations vs schema
  found: `drizzle/` contém UM arquivo (`0000_dear_wolverine.sql`, 914 linhas). `supabase/migrations/` tem 16 arquivos (001 a 016). `schema.ts` foi muito evoluído depois do 0000 (PWA assets, useMailbox, outreach module, mail tables, user_notifications). Não há migrations Drizzle gerados para essas mudanças. Migration 013 está marcada DEPRECATED in-file mas ainda existe.
  implication: O fluxo `db:generate` está sub-utilizado — equipe está escrevendo migrations SQL manuais em `supabase/migrations/` em vez de gerar via Drizzle. Isso é OK como estratégia, mas significa que `db:generate` produziria DIFF MASSIVO se rodasse, e que `db:push` agora seria destrutivo. Scripts usam sintaxe Drizzle-kit 0.20 deprecada (`generate:pg`, `push:pg` — em 0.21+ é só `generate`/`push`).

- timestamp: layer-2
  checked: `src/db/index.ts` connection
  found: Postgres-js conecta com `DATABASE_URL` (role de aplicação postgres), NÃO com Supabase auth context. RLS policies baseadas em `auth.uid()` NÃO se aplicam — a role do app bypassa RLS automaticamente (não tem `auth.uid()` setado).
  implication: RLS é "defense in depth" / DB-direct safety net, mas a autorização real é JS (`checkXAccess` em cada rota). Isso é arquitetura válida MAS:
    1. Documentação CLAUDE.md afirma "RLS policies enforce org-scoped data access" — falso/enganoso.
    2. Se alguma rota esquecer o `checkAccess`, NÃO há rede de segurança.
    3. Scripts/jobs background (cron) também bypassam RLS sem dizer isso explicitamente.

- timestamp: layer-2
  checked: RLS migration history (001 + 008 + 016)
  found: Migration 001 referenciava `server_id` e funções `is_server_member/admin`. Migration 008 dropou a tabela `servers` e dropou as funções, mas DEIXOU policies referenciando `server_id` em domains, credentials, routes, messages, deliveries, webhooks, etc. (eram efetivamente quebradas). Migration 016 detectou e consertou — recriou policies usando `organization_id` + `is_org_member`/`is_org_admin`.
  implication: A história está OK desde que migration 016 tenha sido aplicada. Se um deploy partir do 001 sem rodar 008 + 016, RLS fica quebrada. Não há um script idempotente "ensure-rls-current". Risco real em deploy zerado / em ambientes paralelos onde 016 não tenha rodado. Validar via `scripts/verify-rls-policies.ts`.

- timestamp: layer-2
  checked: Cobertura RLS por tabela
  found: Migrations 001+016 cobrem: users, organizations, organization_users, domains, credentials, routes, smtp/http/address_endpoints, messages, deliveries, webhooks, webhook_requests, track_domains, suppressions, statistics. Migration 004 cobre outreach (email_accounts, lead_lists, leads, campaigns, sequences, sequence_steps, campaign_leads, outreach_emails, outreach_analytics) — re-consolidada por 016. Migration 005 cobre outlook_mailboxes. Migration 006 cobre mail tables (mailboxes, mail_folders, mail_messages, mail_filters, signatures, contacts). Migration 009 cobre templates. Migration 014 cobre user_notifications. Migration 007 cobre system_branding.
  implication: TODAS as tabelas no schema.ts têm RLS ativada — bom! Mas a cobertura está espalhada em 8+ migrations, dificultando auditoria. Recomenda-se consolidar em uma migration "rls_current.sql" idempotente.

- timestamp: layer-2
  checked: Validação Zod nos handlers POST/PUT
  found: Auth, organizations, domains, webhooks, messages — todos têm Zod. `outlook.ts`, `mail/mailboxes.ts`, `mail/messages.ts` — têm Zod. `system.ts` — branding/usage não validam body de uploads (multipart manualmente parseado, é normal), mas `PUT /outreach` aceita `{ enabled }` sem Zod (apenas `typeof === 'boolean'`).
  implication: Cobertura Zod boa. Apenas `system.ts PUT /outreach` deveria usar Zod por consistência.

- timestamp: layer-2
  checked: Express 5 idioms (req.params vs req.query)
  found: Padrão correto em todas as rotas (`req.params.id` para path, `req.query.x` para query string). Express 5-beta funciona como Express 4 para esses casos. Sem regressões observadas.
  implication: OK.

- timestamp: layer-2
  checked: Índices — schema.ts (Drizzle) vs sql/indexes.sql vs migrations/013
  found: Migration 013 está marcada DEPRECATED no próprio arquivo mas ainda existe no diretório. `sql/indexes.sql` define todos os índices via `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. `schema.ts` define os mesmos via Drizzle `index()`. **Duplicação intencional**: Drizzle define para tipagem/migration, `sql/indexes.sql` para criação concurrent em produção. Sem conflitos lógicos, mas migration 013 deveria ser DELETADA (não apenas marcada deprecated) para evitar confusão.
  implication: Deletar 013 + adicionar nota em README explicando o pattern (definir em schema.ts E em sql/indexes.sql, db:push pode falhar em índices se rodar em tabela com dados — usar db:indexes via psql).

- timestamp: layer-3
  checked: `src/server/lib/health.ts` — readiness check
  found: BUG — `checkDatabaseHealth()` retorna `{ ok: true | false, ... }`. Mas `health.ts` só checa `dbResult.status === 'fulfilled'`. Quando o DB falha (Promise.allSettled status="fulfilled" mas value.ok=false), `health.ts` reporta `{ ok: true, latencyMs }` ignorando o `.ok=false`.
  implication: Endpoint `/health/ready` pode reportar 200 com banco DERRUBADO. Monitor de produção fica cego para falhas de DB. CRITICAL.

- timestamp: layer-3
  checked: `src/server/lib/tracking.ts` — incrementStat SQL
  found: Usa `${sql.raw(col)}` para nome de coluna — OK porque `col` vem de allowlist `STAT_COLUMNS`. SQL: `INSERT ... DO UPDATE SET ${col} = statistics.${col} + 1`. Funciona, mas frágil — qualquer adição futura à enum precisa atualizar dois lugares.
  implication: MEDIUM. Tipar `StatField` é OK; apenas documentar/centralizar.

- timestamp: layer-3
  checked: `src/server/lib/tracking.ts` — webhook retry/timeout
  found: `fireWebhooks` usa timeout 10s (`AbortSignal.timeout(10_000)`). Não há retry — uma única tentativa. `webhooks.ts POST /:id/test` NÃO usa timeout. webhook_requests é log-only.
  implication: HIGH. Webhooks que falham são perdidos (sem dead-letter, sem retry exponencial). `/test` pode fazer hang infinito do servidor se URL não responder.

- timestamp: layer-3
  checked: `src/server/routes/track.ts` — SSRF/replay
  found: `isPrivateHost` cobre IPv4 10/172/192 e localhost/IPv6 limitados, MAS:
    1. Não resolve DNS antes — DNS rebinding bypass possível (URL aponta para domínio público que resolve para IP privado).
    2. Não cobre `169.254.x.x` link-local exceto metadata server 169.254.169.254 (parcial).
    3. IPv6 só localhost/0.0.0.0 — não cobre `fc00::/7`, `fe80::/10`.
    4. Click tracking NÃO tem replay protection — abrir o mesmo link N vezes dispara N webhooks `link_clicked`. Não há rate-limit por token.
  implication: HIGH para SSRF (admin pode rewrite URLs apontando para infra interna), MEDIUM para webhook flooding.

- timestamp: layer-3
  checked: `src/server/lib/cascade.ts` — deleteOrganizationCascade
  found: CRITICAL bugs:
    1. NÃO deleta `outlook_mailboxes`, `email_accounts`, `lead_lists`, `leads`, `campaigns`, `sequences`, `sequence_steps`, `campaign_leads`, `outreach_emails`, `outreach_analytics` — todos têm FK `organization_id` e ficam ORFÃOS.
    2. NÃO está em transação — falha parcial deixa estado inconsistente.
    3. Apaga `passwordHash = null` para todos os members do org deletado — MAS um user pode ser membro de OUTROS orgs ainda. Bug crítico: deleção de org pode lockar usuário em outros orgs.
    4. Não deleta `user_notifications` para os members.
  implication: CRITICAL. Bug de integridade referencial + bug de UX/segurança (perda de acesso).

- timestamp: layer-3
  checked: `src/server/routes/mail/mailboxes.ts` — `/test-connection` endpoint
  found: CRITICAL — esse endpoint POST recebe credenciais SMTP/IMAP arbitrárias do user e conecta a hosts arbitrários. Há `req.headers['x-user-id']` no resto do arquivo, mas `/test-connection` (linha 358) NÃO verifica `userId`. Significa que QUALQUER token Supabase válido (que passa pelo middleware do `app.use('/api', ...)`) pode usar o servidor como proxy SMTP/IMAP para qualquer host. Combinado com falta de SSRF check do `smtpHost/imapHost`, é uma porta aberta para abuse/credential-stuffing internal.
  implication: CRITICAL. Bloqueia recurso por (1) exigir auth check explícito, (2) validar host não-privado, (3) rate-limit forte.

- timestamp: layer-3
  checked: `src/server/routes/mail/messages.ts` — `/move` endpoint
  found: HIGH — `POST /:mailboxId/messages/:messageId/move` aceita `folderId` no body sem validar se essa folder pertence à mesma mailbox. Linha 648-650: `db.update(mailMessages).set({ folderId: data.folderId }).where(eq(id) AND eq(mailboxId))`. Mensagem fica no DB com folderId apontando para folder de outra mailbox.
  implication: HIGH. Inconsistência referencial — quebra queries de listing por folder. Não é cross-tenant (mailboxId é do user), mas é cross-mailbox dentro do user.

- timestamp: layer-3
  checked: `src/server/routes/mail/mailboxes.ts` — TLS rejectUnauthorized
  found: `tlsOptions: { rejectUnauthorized: false }` em IMAP test connection (linha 405) e em `lib/mail-sync.ts:541`. Aceita certificados auto-assinados / inválidos.
  implication: HIGH. MITM vulnerability ao conectar a IMAP externo. Aceitável para `/test-connection` (user opt-in), mas mail-sync já em produção é mais grave.

- timestamp: layer-3
  checked: `src/server/routes/system.ts` — `PUT /outreach`
  found: HIGH — `db.update(organizations).set({ outreach_enabled: enabled })` SEM WHERE. Atualiza TODAS as orgs platform-wide. Intencional (admin-only toggle global) MAS:
    1. Não retorna count de afetados.
    2. Não tem audit log.
    3. Body não validado por Zod (apenas `typeof === 'boolean'`).
    4. Endpoint deveria estar em rota com nome mais explícito tipo `PUT /system/outreach/global-toggle` para evitar acidente.
  implication: HIGH (data integrity risk se chamado por engano). MEDIUM (ausência de Zod).

- timestamp: layer-3
  checked: `src/server/routes/system.ts` — `/mail-diag` endpoint
  found: HARDCODED `testEmail = 'vanildo@skale.club'` (linhas 568-577). É um diagnostic admin-only mas o teste é específico do dev original, vazado em prod.
  implication: LOW. Cosmético + leak de identidade pessoal.

- timestamp: layer-3
  checked: `src/server/routes/webhooks.ts` — webhook create/test
  found: HIGH — `POST /` aceita `url: z.string().url()` mas não valida que não é IP privado / localhost. Admin pode salvar webhook apontando para infra interna. `POST /:id/test` faz fetch SEM AbortSignal (no timeout), pode fazer hang do request handler.
  implication: HIGH (SSRF via webhook config) + MEDIUM (hang risk).

- timestamp: layer-3
  checked: `src/server/index.ts` — rate limit
  found: Global `/api/` limiter: 500 prod / 2000 dev por IP por 15min. Auth limiter: 5 per IP per 15min em /login e /reset-password. Tracking: 100 per IP per minute em /t/.
  implication: OK para mvp. Considerar limit por USER (não só IP) para evitar shared-IP starvation. Auth limiter agressivo demais (5 em 15min vai bloquear usuários honestos que erram senha 5x).

- timestamp: layer-3
  checked: `src/server/index.ts` — JWT validation no middleware
  found: `supabaseAnonClient.auth.getUser(token)` em cada request — chama Supabase API. Sem cache. Cada request `/api/*` gera 1 chamada Supabase auth. Em alta carga, vira gargalo + custo.
  implication: HIGH (perf). Cache curto (1-5min) por token-hash via LRU resolveria.

- timestamp: layer-4
  checked: `src/server/jobs/index.ts` — cron jobs
  found: 7 jobs cron rodando. `processOutreachSequences` tem mutex em-process (`isSequenceProcessing`). Outros jobs (`processQueue`, `processBounces`, `processReplies`, `cleanupOldMessages`) NÃO têm mutex. Se um job demora mais que o intervalo, dois ticks rodam concorrentemente.
  implication: HIGH para data races (especialmente `processQueue` rodando a cada 1min). Em deploy multi-instance, TODOS os processos rodam o mesmo cron — pior. Precisa lock distribuído (advisory lock Postgres) ou flag `singleton` por process.

- timestamp: layer-4
  checked: `src/server/lib/native-mail.ts` — validateEmailDomainForOrg
  found: Lowercases email mas `domains.name` é armazenado as-is em `POST /domains` (validation accepts any case). Se domain foi cadastrado com `EXAMPLE.COM`, lookup com `example.com` falha.
  implication: MEDIUM. Normalizar `name` no insert E no lookup.

- timestamp: layer-4
  checked: PWA assets
  found: Build emite manifest e SW corretos. `index.html` injeta `<script src="/app-config.js">` runtime-config (sem type=module — Vite warning). PWA precache 52 entries / ~2MB.
  implication: OK. Warning Vite é cosmético.

- timestamp: layer-5
  checked: `helmet` CSP
  found: `helmet.contentSecurityPolicy.getDefaultDirectives()` + override `img-src` `connect-src` para `supabaseOrigin`. Recente fix de external images para `data:`, `https:`, `http:` em img-src. Falta `script-src` explícito — usa default helmet (`'self'`). Falta `frame-ancestors 'none'` para clickjacking.
  implication: MEDIUM. Endurecer CSP — `frame-ancestors`, `object-src none`, manter `img-src http:` apenas se necessário.

- timestamp: layer-5
  checked: Credenciais sendo logadas
  found: `mail-diag` retorna emails de todos os non-admin users. Logs em `findLocalUser` (linhas 131-148, 152, 160-164) imprimem emails no console em produção. `debug: isDev` no DB client está OK.
  implication: MEDIUM. Remover console.log em produção ou wrap com `if (isDev)`.

- timestamp: layer-5
  checked: Suppression list integration
  found: Schema tem `suppressions` tabela. Não encontrado uso em `POST /messages` (sending) — não consulta suppression antes de enfileirar. Bounce processing (`processBounces`) provavelmente adiciona suppression mas não verifiquei.
  implication: HIGH se confirmado — usuário pode enviar mensagens para emails que já bounced/unsubscribed.

- timestamp: layer-6
  checked: Dead code
  found: `eslint` script é dead (sem config). `migration 013` está deprecated mas presente. `scripts/_check-db.ts` e `_setup-user.ts` (prefix `_`) parecem rascunhos. Arquivo vazio `nul` na raiz (artefato Windows).
  implication: LOW. Cleanup recomendado.

- timestamp: layer-6
  checked: Inconsistências de schema
  found: `organizations.owner_id` usa snake_case mas resto da tabela usa camelCase mapping (Drizzle field names). Isso porque a coluna SQL é `owner_id`; mas a property TS é `owner_id` em vez de `ownerId`. Inconsistência cosmética.
  implication: LOW. Renomear field para `ownerId` (mantendo coluna SQL `owner_id`) padroniza com resto do schema.

- timestamp: layer-6
  checked: `outreach_enabled` campo
  found: Mesmo padrão snake_case na property TS — outro caso de inconsistência. `domains.name` deveria estar lowercased + indexed (single unique index org+name pode prevenir dupes case-different).
  implication: LOW.

## Resolution

root_cause: |
  Auditoria sistêmica encontrou DEZ findings classificados como CRITICAL/HIGH e mais ~15 MEDIUM/LOW. Não é um bug único — é débito técnico acumulado em múltiplas dimensões:

  1. **Tooling quebrado** (ESLint sem config = dead script, type-check com 1 erro).
  2. **Bypass de RLS arquitetural** (intencional via `DATABASE_URL` role, mas mal-documentado — CLAUDE.md afirma o contrário).
  3. **Cascade delete incompleto** (perde dados, lockar users de outros orgs).
  4. **Health check broken** (DB falhando reporta OK).
  5. **Segurança**: `/test-connection` sem auth, SSRF em webhooks/track, TLS rejectUnauthorized.
  6. **Concorrência**: cron jobs sem mutex, JWT validation sem cache.
  7. **Inconsistências menores**: snake_case mix, migration 013 deprecated mas presente, vanildo@skale.club hardcoded.

fix: Plano de remediação multi-fase abaixo, NÃO aplicado nesta sessão.

verification: Cada fix tem critério próprio — ver VERIFICATION CHECKLIST.

files_changed: []

# ============================================================================
# FINDINGS (tabela categorizada)
# ============================================================================

## FINDINGS

### CRITICAL (segurança / integridade de dados)

| # | Arquivo:linha | Issue | Causa raiz |
|---|---|---|---|
| C1 | `src/server/routes/mail/mailboxes.ts:358` | `POST /test-connection` SEM auth check (no `if (!userId) return 401`). Aceita SMTP/IMAP host arbitrário e credenciais. | Esquecido — outros endpoints no mesmo arquivo verificam, esse não. |
| C2 | `src/server/lib/cascade.ts` | `deleteOrganizationCascade` (a) não deleta `outlook_mailboxes`/`email_accounts`/outreach/notifications, (b) não é transacional, (c) nulla `passwordHash` para users membros de OUTROS orgs também. | Cascade implementado antes do outreach module e antes de `outlook_mailboxes` serem adicionados. Nunca foi atualizado. |
| C3 | `src/server/lib/health.ts:11-13` | `dbResult.status === 'fulfilled'` ignora `dbResult.value.ok=false`. DB derrubado reporta health OK. | Bug lógico — `checkDatabaseHealth` retorna objeto com `.ok` em vez de throw. health.ts não checa o `.ok`. |
| C4 | `CLAUDE.md` + arquitetura | Doc afirma "RLS policies enforce organization-level data isolation at the database layer". DB connection usa `DATABASE_URL` Postgres role, bypassa RLS. Autorização real é JS-side. | Documentação inconsistente com runtime. Risco: se developer confiar em RLS e esquecer auth-check, há vazamento. |

### HIGH (bug funcional / risco de segurança / perf)

| # | Arquivo:linha | Issue | Causa raiz |
|---|---|---|---|
| H1 | `src/server/routes/webhooks.ts:127-160` | `POST /webhooks` aceita `url` sem validar IP privado (SSRF — admin pode redirecionar para infra interna). | Falta de validação. `z.string().url()` só checa formato. |
| H2 | `src/server/routes/webhooks.ts:331` | `POST /:id/test` faz `fetch(webhook.url)` SEM AbortSignal — hang infinito possível. | Inconsistência com `fireWebhooks` que usa 10s timeout. |
| H3 | `src/server/routes/track.ts:19-28` | `isPrivateHost` (a) só IPv4, faltam IPv6 ULA/link-local + `169.254.0.0/16` completo, (b) sem DNS resolve antes (DNS rebinding). | Implementação incompleta para SSRF check. |
| H4 | `src/server/routes/track.ts:85-138` | Click tracking dispara webhook em todo request — sem replay protection. URL pode ser hit N vezes. | Lógica intencional? Mas missing rate-limit por token. |
| H5 | `src/server/lib/mail-sync.ts:541` | `tlsOptions: { rejectUnauthorized: false }` em IMAP sync de produção. | MITM ao conectar IMAP externo. |
| H6 | `src/server/routes/mail/mailboxes.ts:405` | Mesma flag em `/test-connection`. Acceptable para test-user-driven, mas em conjunto com C1 (sem auth) = grave. | Mesma. |
| H7 | `src/server/index.ts:170-184` | JWT validation chama Supabase a cada request `/api/*`. Sem cache. Gargalo de perf + custo. | Implementação ingênua. |
| H8 | `src/server/jobs/index.ts` | 6 de 7 cron jobs SEM mutex. `processQueue` roda 1/min — overlap se job > 60s. Multi-instance: todos rodam tudo. | Apenas `processOutreachSequences` foi protegida. |
| H9 | `src/server/routes/system.ts:444` | `PUT /system/outreach` faz `db.update(organizations).set({ outreach_enabled }).` SEM WHERE — atualiza TODAS. Sem audit. | Intencional mas perigoso — endpoint nome ambíguo. |
| H10 | `src/server/routes/mail/messages.ts:642-660` | `/move` aceita `folderId` sem verificar que folder pertence à mailbox. Cross-mailbox folder corruption (intra-user). | Falta validação. |
| H11 | `src/server/routes/messages.ts:195-391` (POST /messages) | Não consulta `suppressions` antes de inserir. Pode enviar a emails já marcados bounce/unsubscribe. | Suppression existe na tabela mas não está integrada no flow. |
| H12 | `package.json:23` | Script `lint` é DEAD — sem `.eslintrc` o ESLint falha imediatamente. CI confiando nele passa fake. | Config nunca foi criado/migrado. |

### MEDIUM (qualidade / consistência / risco menor)

| # | Arquivo:linha | Issue | Causa raiz |
|---|---|---|---|
| M1 | `src/components/AppLogo.tsx:12` | `isSuccess` declared but never read — TS6133. | Cleanup esquecido. |
| M2 | `supabase/migrations/013_add_performance_indexes.sql` | Marcado DEPRECATED in-file mas arquivo permanece. Confunde quem lê. | Deletar (não apenas comentar). |
| M3 | `drizzle/` vs `supabase/migrations/` | Apenas 1 Drizzle migration (`0000_dear_wolverine.sql`); schema evoluiu muito sem regenerate. Drift real. | Equipe migrou estratégia para SQL manual sem deprecar `db:generate`. |
| M4 | `package.json` scripts | `drizzle-kit generate:pg` / `push:pg` sintaxe antiga (0.20.17). Em 0.21+ é `generate`/`push`. | Lock em version 0.20.17 mas vai quebrar em upgrade. |
| M5 | RLS migration history | Cobertura RLS espalhada em 8 migrations (001, 002, 004, 005, 006, 007, 009, 014, 016). Não há "rls-current.sql" idempotente. | Crescimento orgânico. |
| M6 | `src/server/lib/tracking.ts:208-286` (fireWebhooks) | Sem retry para webhooks que falham (timeout, 5xx). Apenas log em `webhook_requests`. | Implementação inicial. |
| M7 | `src/server/routes/system.ts:444` | `PUT /outreach` body sem Zod. | Inconsistência. |
| M8 | `src/server/index.ts:62` | `authLimiter` = 5 attempts / 15min — muito agressivo, bloqueia usuários honestos. | Default sane mas conservador. |
| M9 | `src/server/lib/native-mail.ts:113-122` | `validateEmailDomainForOrg` lowercases email mas não normaliza `domains.name`. Case mismatch lock-out. | Lowercase só de um lado. |
| M10 | `helmet` CSP em `src/server/index.ts:38-46` | Falta `frame-ancestors 'none'`, `object-src 'none'`. Permite clickjacking. | Default helmet apenas. |
| M11 | `src/server/lib/native-mail.ts:131-164` | `console.log` em `findLocalUser` SEMPRE — em produção também. Vaza emails em logs. | Debug não wrapped. |
| M12 | `src/server/lib/tracking.ts:266` | `event: event as any` cast — perde tipagem. | Quick fix. |
| M13 | `src/db/schema.ts:62, 63, 391` | `organizations.owner_id`, `outreach_enabled` em snake_case (TS property), resto camelCase. | Inconsistência. |

### LOW (cosmético / dead code)

| # | Arquivo:linha | Issue | Causa raiz |
|---|---|---|---|
| L1 | `src/server/routes/system.ts:568-577` | `testEmail = 'vanildo@skale.club'` hardcoded em diagnostic endpoint. | Dev artifact. |
| L2 | `c:/Users/Vanildo/Dev/skaleclub-mail/nul` | Arquivo vazio `nul` na raiz (artefato Windows redirect). | Acidente Git. |
| L3 | `scripts/_check-db.ts`, `scripts/_setup-user.ts` | Prefix `_` indica rascunho. | Convenção interna. |
| L4 | `index.html` | `<script src="/app-config.js">` sem `type="module"` — warning Vite no build. | Runtime config trade-off. |
| L5 | `src/server/lib/tracking.ts:268-271` | `responseBody.substring(0, 5000)` — magic number. | OK mas extrair constante. |

# ============================================================================
# ROBUST REMEDIATION PLAN
# ============================================================================

## ROBUST REMEDIATION PLAN

### Fase 0 — Pré-requisitos (não destrutivo, antes de tudo)

1. **Run `scripts/verify-rls-policies.ts` e `scripts/verify-indexes.ts`** — confirma que migrations 001-016 estão de fato aplicadas no DB de produção. Output deve ir para o debug file.
2. **Run `scripts/audit-schema-drift.ts`** — confirma se há colunas/tabelas no DB que não estão em schema.ts.
3. **Snapshot do DB de produção** (backup completo antes de qualquer mudança).

Dependência: nada.
Critério "100% resolvido": output de verify-rls + verify-indexes mostra zero pendências.

---

### Fase 1 — Fixes CRITICAL (segurança / integridade)

**Bloco 1.1 — `cascade.ts` (C2)** ⏱ ~3h
- Reescrever `deleteOrganizationCascade` para:
  - Envolver em `db.transaction(async (tx) => { ... })`.
  - Deletar TODAS as tabelas com FK `organization_id`: lista completa abaixo.
    - `outreach_emails`, `outreach_analytics`, `campaign_leads`, `sequence_steps`, `sequences`, `campaigns`, `leads`, `lead_lists`, `email_accounts`, `outlook_mailboxes`, `templates`, `track_domains`, `suppressions`, `statistics`, `webhook_requests` (via webhook), `webhooks`, `deliveries`, `messages`, `domains`, `credentials`, `routes`, `smtp_endpoints`, `http_endpoints`, `address_endpoints`, `organization_users`, `organizations`.
  - **NÃO nullar `passwordHash` para users que estão em outros orgs**. Apenas nullar/deletar mailbox se for o último org. Lógica: para cada member, contar `organizationUsers WHERE userId AND organizationId != deletedOrg`. Se zero → deletar mailbox + nullar passwordHash. Senão → apenas remover membership.
  - Deletar `user_notifications` órfãs (sem FK direta com org — filtrar por metadata?).
- Adicionar teste (mesmo sem framework, script Node verificando estado após delete).

Dependência: Fase 0.

**Bloco 1.2 — `health.ts` (C3)** ⏱ ~30min
- Corrigir `health.ts` para checar `dbResult.value.ok`:
  ```ts
  const database = dbResult.status === 'fulfilled' && dbResult.value.ok
      ? { ok: true, latencyMs: dbResult.value.latencyMs }
      : { ok: false, error: ... }
  ```
- Adicionar smoke test rodando `/health/ready` quando DB derrubado (k6 ou curl manual).

Dependência: nenhuma.

**Bloco 1.3 — `/test-connection` auth (C1)** ⏱ ~15min
- Adicionar `if (!userId) return 401` no início do handler `/test-connection`.
- Adicionar SSRF check (`isPrivateHost` aplicado a smtpHost/imapHost).
- Adicionar rate limit dedicado (5 req/min/user).

Dependência: pode reutilizar `isPrivateHost` extraído de track.ts.

**Bloco 1.4 — RLS doc clarification (C4)** ⏱ ~30min
- Atualizar `CLAUDE.md` para explicitar: "RLS é defense-in-depth. A autorização real é JS-side via `checkXAccess`. Toda nova rota DEVE chamar uma função `checkAccess` antes de retornar dados ou aceitar mutações."
- Criar `src/server/lib/access.ts` consolidando todos os `checkXAccess` (org-scoped, user-scoped, admin-only). Padronizar retorno.

Dependência: pode rodar em paralelo com outras tasks.

Critério "100% resolvido": (a) cascade delete teste manual de 1 org com 3 members + recursos completos → todas as tabelas verificadas vazias após, mailbox/password não tocado em outros orgs; (b) `/health/ready` retorna 503 com DB down; (c) `/test-connection` sem token retorna 401, com IP privado retorna 400; (d) CLAUDE.md atualizado.

---

### Fase 2 — Fixes HIGH

**Bloco 2.1 — SSRF guard centralizado (H1, H3, H6)** ⏱ ~2h
- Mover `isPrivateHost` para `src/server/lib/network-guard.ts`.
- Estender:
  - IPv6: `fc00::/7`, `fe80::/10`, `::1`.
  - IPv4: `169.254.0.0/16` completo.
  - Hostnames suspeitos: `metadata.google.internal`, `instance-data` etc.
  - DNS resolve opcional (`isPrivateHostWithDns`) — usa `dns.promises.resolve4/6` e checa todos os IPs.
- Aplicar em `webhooks.POST` (url), `webhooks.PATCH` (url), `track.ts click`, `mail/mailboxes test-connection` (smtpHost/imapHost).

**Bloco 2.2 — Webhook timeout/retry/log (H2, M6)** ⏱ ~2h
- `webhooks.ts POST /:id/test`: adicionar `AbortSignal.timeout(10_000)`.
- `tracking.ts fireWebhooks`: implementar retry exponential (3 tentativas, 1s/3s/9s) com `webhook_requests.attempts` incrementado.
- Considerar dead-letter queue (tabela `webhook_dead_letter`) quando 3 attempts falham.

**Bloco 2.3 — Replay protection click tracking (H4)** ⏱ ~1h
- Adicionar tabela `track_events (id, messageId, type ['open'|'click'], occurredAt, ipHash)` ou usar coluna `messages.clickedAt` para single-fire.
- `track.ts click`: incrementar contador apenas se 1ª vez em janela de 60s (rate-limit per-token).

**Bloco 2.4 — IMAP TLS hardening (H5)** ⏱ ~30min
- `lib/mail-sync.ts:541`: trocar `rejectUnauthorized: false` por `rejectUnauthorized: true`. Para casos legítimos (self-signed corporate), oferecer opção `mailbox.skipTlsVerify` (default false).

**Bloco 2.5 — JWT cache (H7)** ⏱ ~2h
- `src/server/lib/auth-cache.ts`: LRU cache (lib `lru-cache` ou Map manual) com TTL 60s, key = SHA-256(token), value = user object.
- Middleware: primeiro tenta cache, fallback Supabase. Métricas: log cache-hit-rate.

**Bloco 2.6 — Cron singleton + advisory locks (H8)** ⏱ ~3h
- `src/server/lib/cron-lock.ts`: usar Postgres `pg_try_advisory_lock(BIGINT)` por nome de job.
- Wrapper `runWithLock('processQueue', async () => { ... })` em cada cron callback.
- Multi-instance safe: apenas 1 worker pega o lock.

**Bloco 2.7 — outreach toggle endpoint (H9)** ⏱ ~30min
- Renomear endpoint: `PUT /api/system/outreach/global-toggle`.
- Adicionar Zod `z.object({ enabled: z.boolean() })`.
- Adicionar response: `{ success, affectedRows, previousState }`.
- Adicionar log via `console.log` (ou audit table) com `userId` e timestamp.

**Bloco 2.8 — folder validation no /move (H10)** ⏱ ~15min
- `mail/messages.ts /move`: validar `folderId` pertence a `mailboxId` antes do update.

**Bloco 2.9 — suppression check em send (H11)** ⏱ ~2h
- `messages.ts POST /`: antes de inserir mensagem, consultar `suppressions WHERE organizationId AND emailAddress IN to`. Se algum recipient suppressed: (a) erro 400 com lista, OU (b) filtrar silenciosamente + retornar warning.
- Decidir UX. Recomendado: erro 400 explícito para outgoing manual; silent skip para outreach automation.

**Bloco 2.10 — ESLint config (H12)** ⏱ ~1h
- Criar `.eslintrc.cjs` (ou `eslint.config.js` flat config):
  - `@typescript-eslint/parser`, plugin `react-hooks`, `react-refresh`.
  - Rules: no-unused-vars, no-explicit-any (warn), react-hooks/exhaustive-deps.
- Rodar `npm run lint` — capturar warnings restantes e categorizar.

Dependência: Fase 1 opcional, mas recomendado fazer 1 antes de 2.
Critério "100% resolvido": (a) toda chamada externa com URL valida via `network-guard`; (b) webhooks falham retentam 3x; (c) cron jobs imunes a overlap; (d) `npm run lint` passa com zero warnings (ou whitelist documentada).

---

### Fase 3 — Fixes MEDIUM

**Bloco 3.1 — Type-check fixes (M1, M12)** ⏱ ~15min
- `AppLogo.tsx`: remover `isSuccess` do destructure.
- `tracking.ts`: tipar `event` corretamente (usar enum `webhookEventEnum.enumValues`).

**Bloco 3.2 — Migration cleanup (M2, M3, M4)** ⏱ ~2h
- Deletar `supabase/migrations/013_add_performance_indexes.sql` (move para `archive/`).
- Decidir estratégia Drizzle: (a) rodar `db:generate` agora e commit o diff massivo, ou (b) deprecar Drizzle migrations, manter só supabase/migrations + sql/indexes.sql. Documentar em README.
- Atualizar `package.json`: se mantiver Drizzle, atualizar scripts para sintaxe 0.21+ ANTES de upgrade. Se deprecar, remover `db:generate`/`db:push` do package.json.

**Bloco 3.3 — Consolidar RLS (M5)** ⏱ ~3h
- Criar `supabase/migrations/017_consolidate_rls.sql` — single idempotent script com `DROP POLICY IF EXISTS ... CREATE POLICY ...` para todas as policies atuais (estado final de 001+016).
- Manter migrations antigas (não deletar) por histórico, mas adicionar comentário "superseded by 017".

**Bloco 3.4 — Domain normalization (M9)** ⏱ ~30min
- `domains.POST`: `name: name.toLowerCase().trim()` no insert.
- `validateEmailDomainForOrg`: já lowercases. OK.
- Migration de data: `UPDATE domains SET name = LOWER(name) WHERE name <> LOWER(name)`.

**Bloco 3.5 — CSP hardening (M10)** ⏱ ~30min
- `helmet({ contentSecurityPolicy: { directives: { ..., 'frame-ancestors': ["'none'"], 'object-src': ["'none'"], 'base-uri': ["'self'"] } } })`.

**Bloco 3.6 — Console.log audit (M11)** ⏱ ~1h
- Grep `console.log` em src/server. Wrap em `if (process.env.NODE_ENV !== 'production')` ou remover.
- Casos legítimos (startup msgs) mantidos.

**Bloco 3.7 — Zod no outreach toggle (M7)** ⏱ ~10min
- Feito em Bloco 2.7.

**Bloco 3.8 — authLimiter ajustar (M8)** ⏱ ~10min
- Aumentar para 10 attempts / 15min, ou 20 / 1h. Calibrar com base em logs.

**Bloco 3.9 — Schema field naming (M13)** ⏱ ~1h
- Renomear `owner_id` → `ownerId`, `outreach_enabled` → `outreachEnabled` (TS property, manter coluna SQL).
- Atualizar todos os usos via grep.

Critério "100% resolvido": `tsc --noEmit` zero erros; arquivos deprecated removidos; CSP test via `securityheaders.com` ≥ A; lowercase domains em DB.

---

### Fase 4 — Fixes LOW (cosmético)

**Bloco 4.1 — `mail-diag` dev artifact (L1)** ⏱ ~10min
- Tornar `testEmail` configurável por query param: `?testEmail=user@domain.com`. Default sem teste.

**Bloco 4.2 — Limpeza arquivos (L2, L3)** ⏱ ~10min
- `git rm nul`.
- `scripts/_*.ts`: renomear sem `_` ou deletar se obsoletos.

**Bloco 4.3 — index.html (L4)** ⏱ ~10min
- Trocar `<script src="/app-config.js">` por `<script type="text/javascript" src="/app-config.js" defer></script>` (Vite ignora se não tem `type=module`).

**Bloco 4.4 — Constantes magic numbers (L5)** ⏱ ~15min
- Extrair `MAX_WEBHOOK_RESPONSE_BODY = 5000` em `tracking.ts`.

Critério "100% resolvido": cosmético — code review subjetivo.

---

### Fase 5 — Pós-fix observabilidade

1. Reativar `npm run lint` em CI (after Fase 2 Bloco 2.10).
2. Reativar `npm run tsc --noEmit` em CI.
3. Adicionar `npm run db:audit` em CI (script existe).
4. Setup monitoring: alertar quando `/health/ready` retornar 503.
5. Setup log sink: capturar `console.error` em produção (Sentry/Datadog).

---

# ============================================================================
# VERIFICATION CHECKLIST
# ============================================================================

## VERIFICATION CHECKLIST

### CRITICAL
- [ ] `deleteOrganizationCascade`: criar org de teste com 1 outlook_mailbox, 1 email_account, 1 campaign, 1 user-membro-de-2-orgs. Deletar org. Verificar: (a) zero rows órfãs em todas as tabelas; (b) passwordHash do user-multi-org PRESERVADO; (c) mailbox do user-multi-org PRESERVADA; (d) operação atômica (kill DB no meio → estado consistente).
- [ ] `/health/ready` com DB down → retorna 503 com `database.ok = false`.
- [ ] `POST /api/mail/mailboxes/test-connection` sem token → 401. Com token + smtpHost=`127.0.0.1` → 400 "private host". Com token + host válido → tenta conectar.
- [ ] CLAUDE.md menciona "RLS é defense-in-depth, autorização real é JS-side".

### HIGH
- [ ] SSRF: `POST /webhooks { url: "http://169.254.169.254/" }` → 400.
- [ ] SSRF: `POST /webhooks { url: "http://localhost/" }` → 400.
- [ ] SSRF: `GET /t/click/TOKEN?u=base64(http://10.0.0.1)` → 400.
- [ ] Webhook test endpoint com URL que faz hang → request retorna em ≤10s.
- [ ] Webhook que falha → 3 entries em `webhook_requests` com `attempts=1,2,3`.
- [ ] Click no mesmo tracking URL 10x em 1min → apenas 1 incremento de `linksClicked`.
- [ ] mail-sync com IMAP self-signed → falha por TLS (a menos que opt-in `skipTlsVerify`).
- [ ] Request `/api/messages` com mesmo token 2 vezes seguidas → log mostra cache-hit no 2º.
- [ ] Cron `processQueue` ao executar lentamente → segundo tick é skipped (não overlap).
- [ ] `PUT /api/system/outreach/global-toggle` → response inclui `affectedRows`.
- [ ] `POST /api/mail/mailboxes/MY_MBOX/messages/MSG_ID/move { folderId: OTHER_MBOX_FOLDER }` → 400.
- [ ] `POST /api/messages` com `to: [suppressed@example.com]` → 400 "recipient suppressed".
- [ ] `npm run lint` executa sem "couldn't find config" e termina com 0 warnings.

### MEDIUM
- [ ] `npx tsc --noEmit` → 0 erros.
- [ ] Diretório `supabase/migrations` sem `013_add_performance_indexes.sql`.
- [ ] `package.json` scripts apontam para sintaxe Drizzle correta.
- [ ] `supabase/migrations/017_consolidate_rls.sql` existe e é idempotente (rodar 2x não falha).
- [ ] Inserir domínio `EXAMPLE.COM`, depois `example.com` → segundo retorna 400 "duplicate".
- [ ] Browser DevTools: response headers incluem `Content-Security-Policy: ... frame-ancestors 'none'`.
- [ ] Grep `console.log` em `src/server/` produção → apenas startup messages.
- [ ] Schema fields: `organizations.ownerId`, `organizations.outreachEnabled` (camelCase TS).

### LOW
- [ ] `/api/system/mail-diag` sem query param → não inclui `diagnosticTest`. Com `?testEmail=x@y.z` → inclui.
- [ ] `git ls-files | grep ^nul$` → vazio.
- [ ] Build Vite sem warning "can't be bundled without type=module".

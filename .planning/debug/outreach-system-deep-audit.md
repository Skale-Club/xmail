---
status: resolved
trigger: "Auditoria PROFUNDA do sistema de outreach do SkaleClub Mail"
created: 2026-05-16T00:00:00Z
updated: 2026-05-16T00:00:00Z
---

# Outreach System — Auditoria Profunda

**Data:** 2026-05-16
**Auditor:** Claude Opus 4.7 (debug agent)
**Escopo:** Backend (outreach-sender, template-variables, processOutreachSequences, processReplies, processBounces, cleanupMessages, jobs/index, outreach/index, outreach/campaigns, outreach/email-accounts, outreach/leads, outreach/unsubscribe, outlook, tracking), Frontend (OutreachDashboard, CampaignsPage, SequencesPage, NewSequencePage, InboxesPage, NewInboxPage, LeadsPage, AnalyticsPage, SettingsPage), Schema (`emailAccounts`, `leads`, `campaigns`, `sequences`, `sequenceSteps`, `campaignLeads`, `outreachEmails`, `outreachAnalytics`, `suppressions`), RLS (`004_outreach_rls.sql`, `011_add_outreach_enabled.sql`).

## Sumário Executivo

O módulo de outreach está **funcionalmente quebrado em produção** em vários pontos críticos que se reforçam mutuamente:

1. **Nenhum email de outreach é enviado** após adicionar leads a uma campanha — `campaign_leads.nextScheduledAt` nunca é inicializado, e o processor filtra por `nextScheduledAt <= now` (NULL faz a comparação retornar falso).
2. **Tracking de open/click de outreach é silenciosamente noop** — o pixel/link apontam para `/t/open/:token` que só consulta a tabela `messages` (mensagens transacionais), nunca `outreach_emails`. Métricas de open/click serão sempre 0%.
3. **Endpoint de unsubscribe não está montado** em `src/server/index.ts` e `generateUnsubscribeLink` nunca é injetado em emails — viola CAN-SPAM, GDPR, RFC 8058.
4. **Toda a API de outreach exige `isPlatformAdmin`** no middleware raiz — usuários comuns (members/admins de organização) recebem `403 Forbidden` em tudo, mesmo sendo donos da org.
5. **Outreach pode rodar concorrente com si mesmo** em dois jobs diferentes (cron 5min + flag local) sem advisory lock no Postgres — em multi-instance (mais de um container) o `isSequenceProcessing` em memória não protege.

Esses cinco achados já invalidam o produto em produção. Há mais ~25 outros itens P0/P1.

---

## Achados Críticos (P0 — corrigir já)

### P0-01 — Primeiro email NUNCA dispara: `nextScheduledAt` nunca é setado ao adicionar leads
**Arquivo:** `src/server/routes/outreach/campaigns.ts:965-973`
**Sintoma:** Adicionar leads a uma campanha cria registros em `campaign_leads` com `nextScheduledAt = NULL`. O processor (`processOutreachSequences.ts:81-93`) filtra `lte(campaignLeads.nextScheduledAt, now)`. Em SQL, `NULL <= now()` é `NULL`, que é tratado como `FALSE` no `WHERE`. Resultado: **leads recém-adicionados nunca aparecem na query do processor**.
**Impacto:** Nenhuma campanha jamais envia o primeiro email. Sistema completamente inerte.
**Causa raiz:** O insert em `campaignLeads.values(...)` não inclui `nextScheduledAt`. Não há lógica em "ativar campanha" que faça backfill.
**Fix sugerido:**
```ts
const insertedCampaignLeads = await db.insert(campaignLeads).values(
    newLeadIds.map(leadId => ({
        campaignId,
        leadId,
        assignedEmailAccountId: validatedData.emailAccountId,
        currentStepId: firstStep?.id,
        currentStepOrder: firstStep?.stepOrder || 0,
        nextScheduledAt: new Date(), // <- agendar imediato (ou +1min para não disparar antes do processor)
    }))
).returning()
```
Alternativa: deixar `nextScheduledAt = NULL` enquanto a campanha está em `draft`, e quando o status muda para `active` (em `PUT /:id`) fazer backfill com `UPDATE campaign_leads SET next_scheduled_at = now() WHERE campaign_id = ? AND next_scheduled_at IS NULL AND status = 'new'`.

---

### P0-02 — Tracking de open/click NUNCA grava nada para outreach
**Arquivos:** `src/server/lib/outreach-sender.ts:131-134` (injetando pixel com `campaignLeadId` como token), `src/server/routes/track.ts:47-49` e `:112-114` (rota busca em `messages.token`, não `outreach_emails`).
**Sintoma:** Pixel injetado aponta para `/t/open/${campaignLeadId}`. Rota `/t/open/:token` faz `db.query.messages.findFirst({ where: eq(messages.token, token) })`. `messages` é a tabela de email **transacional** (API messages), não `outreach_emails`. Sempre retorna `null` → noop silencioso.
**Impacto:** Todas as métricas de open/click são sempre **0%**. Dashboards mentem. Quaisquer decisões data-driven (pausar campanha, A/B test) são inválidas. Webhooks `message_opened`/`link_clicked` nunca disparam.
**Causa raiz:** Tracking foi originalmente desenhado para mensagens transacionais; reaproveitamento para outreach esqueceu de bifurcar o lookup.
**Fix sugerido:** Usar prefixo no token para diferenciar (`o:${campaignLeadId}` vs `m:${messageId}`) ou consultar ambas tabelas. Implementar handler:
```ts
const outreachEmail = await db.query.outreachEmails.findFirst({
    where: eq(outreachEmails.campaignLeadId, token),
    orderBy: [desc(outreachEmails.sentAt)],
})
if (outreachEmail) {
    await db.update(outreachEmails)
        .set({ openedAt: outreachEmail.openedAt ?? now, openedCount: sql`opened_count + 1`, updatedAt: now })
        .where(eq(outreachEmails.id, outreachEmail.id))
    await Promise.all([
        db.update(campaignLeads).set({ totalOpens: sql`total_opens + 1` }).where(eq(campaignLeads.id, token)),
        db.update(campaigns).set({ totalOpens: sql`total_opens + 1` }).where(eq(campaigns.id, outreachEmail.campaignId)),
        db.update(emailAccounts).set({ totalOpens: sql`total_opens + 1` }).where(eq(emailAccounts.id, outreachEmail.emailAccountId)),
    ])
    return
}
// fallback: transactional message lookup
```
Adicional: o token = `campaignLeadId` permite **enumeração** (qualquer terceiro que acerte um UUID v4 dispara contagem de open). Melhor usar HMAC: `token = base64url(campaignLeadId + ":" + hmac(secret, campaignLeadId))`.

---

### P0-03 — Rota `/unsubscribe` nunca é montada; List-Unsubscribe nunca é injetado
**Arquivos:** `src/server/routes/outreach/unsubscribe.ts` (router exportado mas nunca importado), `src/server/index.ts:215-234` (registros de rotas — sem `unsubscribeRoutes`), `src/server/lib/outreach-sender.ts:158-166` (mailOptions não inclui `headers['List-Unsubscribe']`).
**Sintoma:** O arquivo `unsubscribe.ts` define um router completo com `GET /:token`, `POST /:token`, `GET /check/:leadId/:campaignId` e a função `generateUnsubscribeLink`. Nada disso é importado/usado em lugar algum. O `mailOptions` enviado via Nodemailer **não tem** `List-Unsubscribe` nem `List-Unsubscribe-Post`.
**Impacto:**
- Viola **CAN-SPAM Act** (necessita opt-out funcional em cada email comercial)
- Viola **GDPR Art. 21**
- Viola requisitos do **Google bulk-sender (Feb 2024)** e **Yahoo** — emails serão classificados como spam ou bloqueados quando enviar mais de 5k/dia para usuários Gmail/Yahoo
- Footer dos emails (se algum link `{{unsubscribeUrl}}` for usado) renderiza string vazia (template interpolation devolve `''` para variáveis desconhecidas)
**Causa raiz:** Implementação parcial — backend de unsubscribe foi escrito mas a integração no envio e o mount no Express foram esquecidos.
**Fix sugerido:**
1. Em `src/server/index.ts` adicionar:
   ```ts
   import unsubscribeRoutes from './routes/outreach/unsubscribe'
   app.use('/unsubscribe', unsubscribeRoutes)
   ```
2. Em `outreach-sender.ts`, gerar o link e injetar:
   ```ts
   import { generateUnsubscribeLink } from '../routes/outreach/unsubscribe'
   const unsubUrl = generateUnsubscribeLink(lead.id, campaign.id, baseUrl)
   // injetar variável {{unsubscribeUrl}} no template
   // adicionar headers
   mailOptions.headers = {
       'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@${campaign.replyToEmail?.split('@')[1] || 'example.com'}?subject=unsubscribe>`,
       'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
   }
   ```
3. Adicionar variável de template `{{unsubscribeUrl}}` em `template-variables.ts`
4. Adicionar uma checagem que rejeita publicar campanha sem `{{unsubscribeUrl}}` no body (ou injetar footer automaticamente)

---

### P0-04 — Middleware bloqueia toda a API outreach para não-platform-admins
**Arquivo:** `src/server/routes/outreach/index.ts:9-26`
**Sintoma:** O middleware raiz do router monta `isPlatformAdmin(userId)` como pré-condição obrigatória. Members/admins de uma org recebem `403` em qualquer chamada a `/api/outreach/*`. As funções `checkOrgMembership` nos sub-routers (`campaigns.ts:64`, `leads.ts:56`, `email-accounts.ts:56`) nunca são alcançadas para non-admins, e a aceitação de `if (admin) return { role: 'admin' as const }` nelas é dead code (qualquer chamada já é platform-admin para chegar lá).
**Impacto:**
- Usuários reais (donos de organização) não conseguem usar o produto
- Frontend tenta listar campanhas/leads/inboxes → recebe `403` → tela "Acesso negado" ou vazia silenciosa
- RLS em PostgreSQL está bem desenhado (`is_outreach_org_member`) e seria correto, mas é inalcançável
**Causa raiz:** Provavelmente o middleware foi adicionado durante desenvolvimento e nunca removido. As checagens granulares são as corretas.
**Fix sugerido:** Remover completamente o middleware admin no `outreach/index.ts`:
```ts
router.use(async (req, res, next) => {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    next()
})
```
Manter as checagens `checkOrgMembership` em cada handler.

---

### P0-05 — Race condition: `currentStepId` é atualizado DUAS vezes no mesmo loop, podendo "pular" um step
**Arquivo:** `src/server/jobs/processOutreachSequences.ts:251-300`
**Sintoma:**
- Linha 251-259: `UPDATE campaign_leads SET currentStepId=<current>` (logo após o envio)
- Linha 286-292: `UPDATE campaign_leads SET currentStepId=<next>` (avança para o próximo)

Se o processo crashar **entre** essas duas updates, o lead fica em estado válido (currentStep = step que acabou de ser enviado), mas `nextScheduledAt` continua no valor antigo (lte now). Na próxima iteração, o idempotency guard (`existingEmailsSet`) salva o dia — desde que `recordOutreachEmail` (linha 237) tenha sido bem-sucedido.

**Pior problema:** Se `recordOutreachEmail` falhar (constraint unique violado, DB transiente), o email já foi enviado mas o registro nunca é criado. Na próxima rodada, o idempotency guard não detecta, e **o mesmo email vai de novo** para o lead.

**Impacto:** Emails duplicados em caso de falhas parciais (DB lento, deploy mid-flight, OOM).
**Causa raiz:** Não há transação envolvendo `sendOutreachEmail` + `recordOutreachEmail`. A criação do registro de outreach acontece DEPOIS do envio (correto para evitar fantoma) mas SEM proteção em caso de crash.
**Fix sugerido:**
1. Criar `outreach_emails` com `status='sending'` ANTES de enviar (idempotency-first):
   ```ts
   // INSERT com ON CONFLICT DO NOTHING garante claim único
   const insertResult = await db.insert(outreachEmails)
       .values({ ...placeholder, status: 'sending' })
       .onConflictDoNothing({ target: [outreachEmails.campaignLeadId, outreachEmails.sequenceStepId] })
       .returning()
   if (insertResult.length === 0) continue  // outra instância pegou
   ```
2. Enviar email
3. UPDATE para `status='sent', messageId, sentAt`
4. Em caso de erro de envio: UPDATE para `status='failed', error`

Isso aproveita o índice unique `outreach_emails_campaign_lead_step_unique` (já existe em schema.ts:896) como advisory lock.

---

### P0-06 — Multi-instance race: `isSequenceProcessing` é in-memory
**Arquivo:** `src/server/jobs/index.ts:9-39`
**Sintoma:** A flag `isSequenceProcessing` está em memória do processo Node. Se houver duas instâncias do container rodando (escala horizontal, blue-green deploy, deploys com overlap), AMBAS rodam `processOutreachSequences()` simultaneamente. O guarda dentro do loop (`existingEmailsSet` em linha 211) é populado uma única vez no início e cada instância tem seu próprio Set → emails duplicados.
**Impacto:** Em produção single-container hoje está OK, mas viola um requisito básico de "stateless web app". Qualquer escala futura quebra. Também: blue-green deploy do GitHub Actions tem janela onde o container `:previous` ainda recebe traffic e está rodando cron.
**Causa raiz:** Falta `pg_advisory_lock` ou uma tabela `job_locks`.
**Fix sugerido:**
```ts
// Pegar lock antes de rodar
const [{ acquired }] = await db.execute(sql`
    SELECT pg_try_advisory_lock(${LOCK_ID_OUTREACH_PROCESSOR}) as acquired
`) as any
if (!acquired) {
    console.log('[jobs] outreach lock held by another instance, skipping')
    return
}
try { await processOutreachSequences() }
finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_ID_OUTREACH_PROCESSOR})`)
}
```
Aplicar o mesmo em `processReplies`, `processBounces`, `cleanupOldMessages`.

---

### P0-07 — Suppressions são lidas mas nunca escritas para outreach
**Arquivos:** `src/server/jobs/processOutreachSequences.ts:124-130` (leitura); pesquisa `db.insert(suppressions` retorna **zero** matches em todo o `src/`.
**Sintoma:** O processor exclui leads em `suppressions` (`suppressedSet.has(...)` em `:173-179`), mas **nada nunca insere em `suppressions`**. Quando um hard-bounce acontece em `markAsBounced` (`processBounces.ts:221-268`), o lead é marcado `bounced` mas o email não vai pra suppression. Se o usuário recriar a campanha ou adicionar o lead numa nova campanha, o sistema **enviará de novo** para um email comprovadamente bouncing.
**Impacto:**
- Reputação de IP/domínio do remetente cai com cada re-tentativa
- ISPs marcam o remetente como spammer
- Sequence "para" para essa campanha mas não para o lead em outras campanhas
**Causa raiz:** Falta um INSERT em `suppressions` no `processBounces.markAsBounced` para hard-bounces, e no `processUnsubscribe` (`unsubscribe.ts:197`).
**Fix sugerido:** Em `markAsBounced` adicionar:
```ts
// Apenas hard-bounces vão para suppressions
if (reason.match(/permanent|hard|550|551|553|user unknown|no such user/i)) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) })
    if (lead) {
        await db.insert(suppressions).values({
            organizationId: ... /* precisa do orgId — passar via params */,
            emailAddress: lead.email.toLowerCase(),
            reason: 'bounce',
        }).onConflictDoNothing()
    }
}
```
E no `processUnsubscribe`, suppression com `reason: 'manual'`.

---

### P0-08 — Detecção de bounces via IMAP: query SQL inválida com `LOWER` em UUID
**Arquivo:** `src/server/jobs/processBounces.ts:188-194`
**Sintoma:**
```ts
sql`LOWER(${outreachEmails.campaignLeadId}) IN (
    SELECT cl.id FROM campaign_leads cl
    JOIN leads l ON cl.lead_id = l.id
    WHERE LOWER(l.email) = LOWER(${email})
)`
```
- `outreach_emails.campaign_lead_id` é UUID, não text. `LOWER(uuid)` no Postgres dispara erro `function lower(uuid) does not exist`.
- Mesmo se funcionasse, está comparando UUID com o resultado da subquery que retorna `cl.id` (também UUID — sem `LOWER` aplicado, então types não batem mesmo com cast implícito).
- O `findFirst` em volta com `where: and(eq(...), sql\`...\`)` provavelmente nunca achou nenhum bounce.

**Impacto:** Bounces via IMAP não funcionam. `processBounces` provavelmente falha silenciosamente (catch externo come o erro) ou consistentemente retorna 0 bounces. `lastSyncAt` é atualizado dando falsa impressão de saúde.

**Causa raiz:** Tentativa de fazer case-insensitive lookup esquecendo que `campaignLeadId` é UUID.
**Fix sugerido:**
```ts
const result = await db.query.outreachEmails.findFirst({
    where: and(
        eq(outreachEmails.emailAccountId, accountId),
        sql`${outreachEmails.campaignLeadId} IN (
            SELECT cl.id FROM campaign_leads cl
            JOIN leads l ON cl.lead_id = l.id
            WHERE LOWER(l.email) = LOWER(${email})
        )`
    ),
    orderBy: [desc(outreachEmails.sentAt)],
    with: { campaignLead: { with: { lead: true } } },
})
```

---

### P0-09 — Subquery Drizzle quebrada em `addLeadsToCampaign`
**Arquivo:** `src/server/routes/outreach/campaigns.ts:957-962`
**Sintoma:**
```ts
const firstStep = await db.query.sequenceSteps.findFirst({
    where: eq(sequenceSteps.sequenceId,
        db.select({ id: sequences.id }).from(sequences).where(eq(sequences.campaignId, campaignId)).limit(1)
    ),
    orderBy: (steps, { asc }) => [asc(steps.stepOrder)],
})
```
- `db.select(...)` retorna um query builder, não um valor escalar. Passar isso para `eq(column, subquery)` no Drizzle não funciona como subquery escalar. Em runtime, vai gerar SQL inválido ou comparação contra string serializada.
- Mesmo conceitualmente: pode haver múltiplas sequences por campanha (a UI permite — `SequencesPage` lista vários). Pegar uma sequence aleatória sem ordering é não-determinístico.

**Impacto:** `firstStep` provavelmente é `undefined` na maioria dos casos → leads são adicionados com `currentStepId = undefined` e `currentStepOrder = 0`. Mesmo se `nextScheduledAt` fosse setado (ver P0-01), o `processOutreachSequences` falharia em `currentStep` lookup (linha 203-208: "No current step for campaign lead").

**Causa raiz:** Refactor incompleto de subquery.
**Fix sugerido:** Resolver em duas queries:
```ts
const firstSequence = await db.query.sequences.findFirst({
    where: eq(sequences.campaignId, campaignId),
    orderBy: [asc(sequences.createdAt)],
})
const firstStep = firstSequence ? await db.query.sequenceSteps.findFirst({
    where: eq(sequenceSteps.sequenceId, firstSequence.id),
    orderBy: [asc(sequenceSteps.stepOrder)],
}) : null

if (!firstStep) {
    return res.status(400).json({
        error: 'Campaign has no sequence steps — create at least one step before adding leads'
    })
}
```

---

### P0-10 — DELETE de campaign falha por FKs sem CASCADE
**Arquivo:** `src/server/routes/outreach/campaigns.ts:550`
**Sintoma:** `await db.delete(campaigns).where(eq(campaigns.id, campaignId))` sem deletar primeiro `outreach_emails`, `campaign_leads`, `sequence_steps`, `sequences`. As FKs em `schema.ts` (`outreachEmails.campaignId`, `campaignLeads.campaignId`, `sequences.campaignId`) **não declaram `onDelete: 'cascade'`** (verificado: nenhuma `.references(() => campaigns.id, { onDelete: 'cascade' })`).
**Impacto:** Tentativa de deletar campanha que já enviou emails → erro Postgres `violates foreign key constraint`. Endpoint retorna 500. Usuário não consegue limpar campanhas antigas. Mesma coisa para `deleteSequence` (campaigns.ts:666-667 deleta steps antes, mas não deleta `campaignLeads.currentStepId` que aponta para esses steps — mais um FK violado).
**Causa raiz:** Schema desenhado sem cascade. Rotas não fazem o teardown manualmente.
**Fix sugerido:** Adicionar `onDelete: 'set null'` ou `'cascade'` no schema (preferível, com migration), OU fazer o teardown manual nas rotas:
```ts
await db.transaction(async (tx) => {
    await tx.delete(outreachEmails).where(eq(outreachEmails.campaignId, campaignId))
    await tx.delete(campaignLeads).where(eq(campaignLeads.campaignId, campaignId))
    const seqs = await tx.query.sequences.findMany({ where: eq(sequences.campaignId, campaignId), columns: { id: true } })
    if (seqs.length) await tx.delete(sequenceSteps).where(inArray(sequenceSteps.sequenceId, seqs.map(s => s.id)))
    await tx.delete(sequences).where(eq(sequences.campaignId, campaignId))
    await tx.delete(campaigns).where(eq(campaigns.id, campaignId))
})
```

---

### P0-11 — "New Campaign" leva a tela preta: rota e página inexistentes (reportado pelo usuário 2026-05-16)

**Arquivos:**
- `src/pages/outreach/CampaignsPage.tsx:244` — botão header `<Link href="/outreach/campaigns/new">New Campaign`
- `src/pages/outreach/CampaignsPage.tsx:335` — empty-state CTA `<Link href="/outreach/campaigns/new">Create Campaign`
- `src/main.tsx:442-455` — rotas registradas: apenas `/outreach/campaigns/:id/sequences/new` e `/outreach/campaigns` (exato)
- `src/pages/outreach/campaigns/` — diretório **não existe**; não há `NewCampaignPage` component

**Sintoma:** Usuário clica em "New Campaign" → URL muda para `/outreach/campaigns/new` → wouter não casa nenhuma `<Route>` → o `<Switch>` cai para o último child (provavelmente um catch-all 404 que não renderiza nada ou que renderiza vazio com layout colapsado) → tela preta.

**Impacto:** **Não é possível criar uma campanha nova pelo UI.** Combinado com P0-04 (API 403) e P0-01 (1º email não dispara), o módulo de outreach está completamente quebrado para o usuário final do início ao fim do funil.

**Causa raiz:** Frontend foi shipped sem implementar a página de criação. Provavelmente assumiu-se que existiria mas nunca foi escrita; ou foi removida durante refactor sem remover os links que apontavam pra ela.

**Fix sugerido:**
1. Criar `src/pages/outreach/campaigns/NewCampaignPage.tsx` com form mínimo: `name`, `description`, `lead_list_id`/`leads` (multi-select), `sequence_id` (opcional, ou wizard que cria sequence inline), `from_email_account_id`, scheduling defaults.
2. Registrar rota em `main.tsx` **antes** de `/outreach/campaigns` (wouter casa em ordem):
   ```tsx
   <Route path="/outreach/campaigns/new">
     <AdminCheck><OrganizationProvider><PageSuspense><NewCampaignPage /></PageSuspense></OrganizationProvider></AdminCheck>
   </Route>
   ```
3. Form chama `POST /api/outreach/campaigns?organizationId=...` (que existe — `campaigns.ts`), redireciona para `/outreach/campaigns/:id` em sucesso.
4. Para o fix ser end-to-end válido, **depende de P0-04** (middleware) ser corrigido, senão o POST retorna 403.

---

## Achados Altos (P1 — próximo ciclo)

### P1-01 — `outreach_enabled` flag é cosmético
**Arquivos:** `src/db/schema.ts:63`, `src/server/routes/system.ts:411-446`.
**Sintoma:** Coluna `organizations.outreach_enabled` existe e tem endpoint admin para toggle. Nenhuma rota ou job verifica esse flag antes de criar/enviar. Desativar não desativa nada.
**Fix:** Adicionar checagem em `processOutreachSequences` (filtrar `campaigns` por `organizations.outreach_enabled = true`), e em `POST /campaigns`, `POST /email-accounts`, `POST /leads`.

### P1-02 — Detecção de reply usa apenas mensagens não-lidas em INBOX
**Arquivo:** `src/server/jobs/processReplies.ts:107`.
**Sintoma:** `search({ seen: false }, { uid: true })` — só pega não lidas, e só no INBOX. Se o usuário ler manualmente no Gmail/Outlook ANTES do cron rodar (15min), o reply é perdido. Replies que caíram em "Spam", "Promotions", "Updates" também não são vistos.
**Impacto:** Sequence continua bombardeando lead que já respondeu (péssima UX, dispara reclamações de spam).
**Fix:** Persistir `lastSeenUid` por (accountId, mailbox) e usar `UID > lastSeenUid` para garantir cobertura. Procurar em todas as folders relevantes (INBOX + abas Gmail). Casar pelo `Message-ID` original (mais robusto) e também por From-address normalizado.

### P1-03 — Match de reply por In-Reply-To é frágil
**Arquivo:** `src/server/jobs/processReplies.ts:120-131`.
**Sintoma:**
- Faz regex `^In-Reply-To:\s*(.+)$/im` no `headers.toString('utf8')` — `headers` é Buffer dos headers, em emails legítimos isso funciona, mas múltiplos In-Reply-To IDs (alguns clientes mandam mais de um) só pegam a primeira linha.
- Extrai `references` se In-Reply-To estiver vazio (bom), mas só pega o PRIMEIRO reference (`extractFirstReference`). RFC 5322 diz que o relevante normalmente é o **último** (root da thread).
- `findOutreachEmailByMessageId` faz `replace(/[<>]/g, '')` mas não normaliza case (alguns servidores reescrevem em lowercase).
**Fix:** Usar a lib `mailparser` para fazer parsing robusto. Tentar todos os IDs em `References`. Comparar case-insensitive.

### P1-04 — `findOutreachEmailByMessageId` em processBounces faz LIKE com substring controlável
**Arquivo:** `src/server/jobs/processBounces.ts:208-219`.
```ts
where: sql`LOWER(${outreachEmails.messageId}) LIKE LOWER(${'%' + cleanMessageId + '%'})`,
```
- `LIKE '%' + cleanMessageId + '%'` faz table-scan completo na `outreach_emails` (sem índice trigram). Custo O(n).
- `cleanMessageId` vem do conteúdo do email de bounce, sem sanitização — não há SQL injection (parâmetro), mas um atacante pode enviar bounces forjados com message-id genérico (`@`) para casar com QUALQUER email do tenant e marcá-los como bouncing.
**Fix:** Comparação exata com normalização. Não usar LIKE. Validar que `cleanMessageId` é não vazio e contém `@`.

### P1-05 — A `recordOutreachEmail` grava `htmlBody` final (com tracking pixel/links reescritos)
**Arquivo:** `src/server/lib/outreach-sender.ts:185-213` + chamada em `processOutreachSequences.ts:245`.
**Sintoma:** `htmlBody: sendResult.finalHtml` salva o HTML COM o pixel injetado e links reescritos para `/t/click/`. O DB armazena um conteúdo enorme por email. Para 100k emails enviados, isso são GBs de HTML duplicado.
**Impacto:** Tamanho do banco explode. Custo de Supabase ($/GB). Backup lento.
**Fix:** Gravar o HTML **antes** da injeção (template original já interpolado) — é o que o sender humano precisa ver, não a versão com tracking.

### P1-06 — Variável `{{unsubscribeUrl}}` não existe no template engine
**Arquivo:** `src/server/lib/template-variables.ts:41-59`.
**Sintoma:** Como não existe, se o usuário usar `{{unsubscribeUrl}}` no template, a interpolação devolve string vazia (linha 108: `return ''`). Quando finalmente o unsubscribe for implementado (P0-03), terá que adicionar essa variável.
**Fix:** Junto com P0-03, adicionar:
```ts
'{{unsubscribeUrl}}': (lead, context) => generateUnsubscribeLink(lead.id, context.campaignId, context.baseUrl),
```
Vai exigir refatorar a assinatura de `interpolateTemplate` para receber contexto.

### P1-07 — Send window não respeita timezone do campaign
**Arquivo:** `src/server/lib/outreach-sender.ts:53-74`.
**Sintoma:** `isWithinSendWindow` usa `now.getHours()` (timezone do servidor — UTC em Hetzner). `campaign.timezone` é lido do schema mas nunca usado para conversão.
**Impacto:** Campanha configurada para enviar 9h-17h "São Paulo" envia 9h-17h UTC (6h-14h SP). Emails chegam às 6 da manhã para o destinatário brasileiro — pior horário possível para deliverability/abertura.
**Fix:** Usar `Intl.DateTimeFormat('en-US', { timeZone: campaign.timezone, hour: 'numeric', minute: 'numeric', hour12: false })` ou lib `date-fns-tz` / `luxon` para extrair hora local.

### P1-08 — `calculateNextScheduledAt` move para próximo dia/semana mas pode pular feriados/timezone DST
**Arquivo:** `src/server/jobs/processOutreachSequences.ts:34-65`.
**Sintoma:** Lógica naive: `next.setHours(startHour, 0, 0, 0)`, `next.setDate(next.getDate() + 1)`. Não considera DST (em fall back, `setHours(9)` pode dar 8h "real"). Não considera feriados.
**Impacto:** Off-by-1 hour em dias de mudança DST. Sem grande impacto, mas perceptível.
**Fix:** Usar `luxon` ou `date-fns-tz`.

### P1-09 — `selectAbVariant` faz hash de `lead.id + step.id` mas o A/B percentage é interpretado errado
**Arquivo:** `src/server/jobs/processOutreachSequences.ts:67-74` e `outreach-sender.ts:107-109`.
**Sintoma:** Comentário diz "percentage for variant A" (`schema.ts:813`). `selectAbVariant` retorna `'a'` se `hashInt % 100 < threshold`, senão `'b'`. Isso bate. Mas em `outreach-sender.ts`:
```ts
const subjectTemplate = abVariant === 'b' && step.subjectB ? step.subjectB : step.subject
```
Se variant é 'b' mas `step.subjectB` está vazio (`null` ou `''`), faz fallback para `step.subject` — mas usa template A. **A análise de A/B depois conta como variant 'b' mesmo tendo usado conteúdo 'a'**. Métricas A/B viram lixo silenciosamente.
**Fix:** Validar que se `abTestEnabled`, então `subjectB` e (htmlBodyB OR plainBodyB) são obrigatórios.

### P1-10 — Validação de templates não previne XSS
**Arquivo:** `src/server/lib/template-variables.ts:91-109`.
**Sintoma:** Custom field value é interpolado direto via `String(value)`. Se um lead tiver `customFields = { "name": "<script>alert(1)</script>" }`, isso entra cru no HTML do email. Esse HTML então é injetado em outro HTML do destinatário. Maioria dos clientes de email sanitiza, mas alguns (especialmente webmail customizado, Apple Mail antigo) renderiza JS.
**Impacto baixo (clientes modernos protegem)** mas:
- Quebra layout de email se conteúdo de custom field tiver `<` `>` literais sem escape
- Pode ser usado para template injection — colocar `</p><img src=evil>` num customField escapa o esquema do template
**Fix:** Auto-escape HTML em interpolação para HTML body. Manter raw para subject/plainBody.

### P1-11 — `paginate` em `paginate(db, sequences, {...})` lista sequences cruzando vários campaigns sem garantia de RLS
**Arquivo:** `src/server/routes/outreach/campaigns.ts:258-271`.
**Sintoma:** Faz `inArray(sequences.campaignId, campaignIds)` (correto), mas usando service-role DB (Drizzle no servidor não passa pelo RLS). Auth é só feita no middleware (`checkOrgMembership` do orgId da query). Se o frontend mandar `?organizationId=A` mas o user enviar UUIDs roubados de orgB em algum body, ele só vê sequences da org A. **OK** — mas o middleware geral (`outreach/index.ts`, ver P0-04) sendo isPlatformAdmin já filtra tudo. Quando P0-04 for corrigido, importante revisar que TODAS as queries filtram pelo orgId do usuário, não confiar só no que vem da URL.

### P1-12 — Token de unsubscribe não é HMAC-assinado
**Arquivo:** `src/server/routes/outreach/unsubscribe.ts:17-29`.
**Sintoma:**
```ts
function encodeToken(data) { return Buffer.from(JSON.stringify(data)).toString('base64url') }
function decodeToken(token) { try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf-8')) } catch { return null } }
```
- Token é base64 plano. Qualquer um pode forjar tokens para descadastrar qualquer lead em qualquer campaign sem verificação.
- Timestamp incluído (`{ leadId, campaignId, timestamp }`) mas nunca validado (expiração).
- Endpoint `GET /:token` é processado sem rate-limit específico (depende do limit global de `/`).
**Impacto:**
- Atacante pode iterar leadIds (se descobrir um) e descadastrá-los em massa — sabotando campanhas.
- Bots/scanners que rastreiam links em emails (Outlook Safelinks, Gmail prefetch) podem disparar unsubscribe sem intenção do usuário (Google solucionou parcialmente para email scanners, mas há histórico de falsos positivos).
- Note: prefetch de imagem de open-tracking sempre dispara, então é OK; mas unsubscribe deve idealmente exigir POST.
**Fix:**
1. Assinar com HMAC: `token = base64url(payload) + '.' + hmac(secret, base64url(payload))`
2. Validar timestamp (token expira em 60 dias?)
3. Para CAN-SPAM/RFC 8058 one-click, o POST é o requerido, o GET deve mostrar página de confirmação com botão (proteção contra prefetch).

### P1-13 — `processReplies` faz `fetchOne(uid.toString(), { headers: [...] })` mas tipos da `imapflow` esperam UID numérico
**Arquivo:** `src/server/jobs/processReplies.ts:114-117`.
**Sintoma:** `uids` em `:107` retorna `number[]` (ou `bigint`). `uid.toString()` força string. ImapFlow espera number ou range string. Funciona por sorte (string vira range de 1 UID).
**Fix:** `await client.fetchOne(uid, { headers: [...] }, { uid: true })`

### P1-14 — `cleanupOldMessages` deleta `outreachEmails` antigos com retention global de 30 dias
**Arquivo:** `src/server/jobs/cleanupMessages.ts:7,50-65`.
**Sintoma:** `RETENTION_DAYS = parseInt(process.env.MESSAGE_RETENTION_DAYS || '30')`. Mesma retention para mensagens transacionais e outreach. Deletar registro de outreach impede:
- Histórico do lead (qual sequence/step recebeu)
- Re-attribution de bounces que chegam tardiamente (alguns ISPs mandam DSN dias depois)
- Análise de longo prazo

**Pior**: Deletar a linha `outreach_emails` sem deletar a FK em `campaign_leads.currentStepId` pode quebrar relacionamentos. Vai funcionar pois `currentStepId` aponta para `sequence_steps`, não `outreach_emails`, mas atributos como `firstContactedAt`/`lastContactedAt` em `campaign_leads` continuam — analytics fica desconectado.

**Fix:** Retention separado e maior para outreach (180 dias?). Soft-delete em vez de hard-delete (`deletedAt` + view filtrada).

### P1-15 — Stats `/api/outreach/campaigns/stats` faz aggregation em `campaignLeads` mas `totalEmails = stats.contacted`
**Arquivo:** `src/server/routes/outreach/campaigns.ts:200-218`.
**Sintoma:** Define `totalEmails = Number(stats.contacted) || 0`. Mas `contacted` é o COUNT de `campaign_leads` com status `!= 'new'`, ou seja, número de **leads** contactados, não de **emails enviados** (se um lead recebeu 5 steps, conta 1, não 5).
**Impacto:** "Total Emails" no dashboard mostra número errado (sempre subestimado quando há multi-step).
**Fix:** Usar `count(*)` de `outreach_emails`:
```ts
const emailsResult = await db.select({ count: sql<number>`count(*)` })
    .from(outreachEmails)
    .where(inArray(outreachEmails.campaignId, campaignIds))
const totalEmails = Number(emailsResult[0]?.count || 0)
```

### P1-16 — Email `from` envelope não bate com header `From` em alguns providers
**Arquivo:** `src/server/lib/outreach-sender.ts:159-166`.
**Sintoma:** `mailOptions.from = '"Display Name" <user@gmail.com>'`. Nodemailer usa esse como header `From` e também como envelope-from (MAIL FROM). Gmail/Office365 reescrevem o envelope com endereço do usuário autenticado de qualquer jeito, mas providers SMTP genéricos preservam — se o `account.email` não bate com o domínio autenticado, SPF falha.
**Impacto:** SPF fail → marcado como spam.
**Fix:** Setar explicitamente `envelope: { from: account.email, to: [lead.email] }` e/ou validar que `displayName + email` é consistente.

### P1-17 — Sem rate-limit por inbox (ignora `minMinutesBetweenEmails` / `maxMinutesBetweenEmails`)
**Arquivos:** `src/db/schema.ts:662-663` (campos existem), `processOutreachSequences.ts` (não usa).
**Sintoma:** Cron roda a cada 5min e dispara até 200 emails (`PENDING_LEADS_LIMIT = 200`) em rajada. `minMinutesBetweenEmails` e `maxMinutesBetweenEmails` são definidos no schema mas nunca lidos.
**Impacto:** Burst → spam-filter de Gmail/Outlook detecta. Acabamos com IP/domain blocklisted.
**Fix:** Após cada send, agendar próximo via `account.lastSentAt + random(min, max) minutes`. Filtrar `pendingLeads` para excluir leads cujo `assignedEmailAccount.lastSentAt > now - account.minMinutes`.

### P1-18 — Sem warmup real
**Arquivos:** `schema.ts:665-667` (`warmupEnabled, warmupDays, warmupCurrentDay`), código não usa em lugar nenhum.
**Sintoma:** Campos existem, default `warmupEnabled = true`. Não há lógica que limite send volume gradualmente ao longo dos primeiros 14 dias.
**Impacto:** Promessa quebrada na UI (`NewInboxPage` mostra "Enable warmup mode (gradually increase sending volume)"). Inbox novo dispara cheio → flagged.
**Fix:** Implementar curva de warmup. Dia N: limite `= dailySendLimit * (N / warmupDays)`. Atualizar `warmupCurrentDay` em job diário (não existe).

### P1-19 — `markAsReplied` faz `Promise.all` de 5 updates desacopladas — sem transação
**Arquivo:** `src/server/jobs/processReplies.ts:200-234`.
**Sintoma:** Se uma das 5 updates falha (DB momentaneamente caí), as outras já commitaram → estado inconsistente. Lead status `replied` mas `outreach_emails.repliedAt` não setado, ou vice-versa.
**Fix:** `db.transaction(async (tx) => { ... await Promise.all([tx.update(...), ...]) })`.

### P1-20 — Não há rate-limit no endpoint público `/unsubscribe/:token`
**Arquivo:** `src/server/index.ts:75` (`/t/` tem trackingLimiter, `/unsubscribe` quando montado não terá).
**Sintoma:** Quando P0-03 for corrigido, `/unsubscribe/:token` precisa de rate-limit (DoS, enumeração).
**Fix:** Reutilizar `trackingLimiter` ou criar `unsubscribeLimiter`.

---

## Melhorias e Oportunidades (P2)

### P2-01 — Falta validação Zod no PUT de leads para `email`
`leads.ts:29-42` em `updateLeadSchema` não inclui `email` (correto — não permite mudar email). Mas se enviado, é ignorado silenciosamente. Melhor `passthrough` rejeitar.

### P2-02 — Frontend `OutreachDashboard` chama `/api/outreach/campaigns?...&limit=5` mas pagina default é 25 com Zod refusando `limit < 1`. Atualmente OK, mas registrar como contrato.

### P2-03 — Reply count: incrementa `totalReplies` mas não verifica se já foi processado anteriormente
`processReplies.ts:208`: `totalReplies + 1`. Se o mesmo UID for processado duas vezes (por algum bug de IMAP state — Gmail reusa UIDs após expunge), conta replies duplicados. Adicionar idempotency check: `WHERE replied_at IS NULL`.

### P2-04 — `cleanupOldMessages` faz N DELETE separados em loop (linhas 38-40, 60-62, 132-134)
Usar batch DELETE com `inArray`:
```ts
await db.delete(deliveries).where(inArray(deliveries.messageId, messageIds))
await db.delete(messages).where(inArray(messages.id, messageIds))
```

### P2-05 — `incrementAccountStats` é chamado com `'totalSent'` mas incrementa AMBOS `totalSent` E `currentDailySent` (comentado mas confuso)
`outreach-sender.ts:255-258`. Melhor separar em função própria `incrementSent(accountId)` com nome auto-explicativo.

### P2-06 — Sequência sem steps não rejeita addLeads
`addLeadsToCampaign` (`campaigns.ts:902+`): se a campanha não tem sequence/steps, ainda insere com `currentStepId: undefined`. Resultado: processor (P0-09) reclama "No current step". Melhor: bloquear no POST.

### P2-07 — Frontend `NewSequencePage` permite criar sequence sem steps via UI direta (usa `steps` array iniciado com 1 elemento). Mas não valida que pelo menos 1 step tem subject + body.
Existe validação em `SequencesPage` dialog (linha 249), mas não em `NewSequencePage`.

### P2-08 — Email envelope-from não tem `Return-Path` explícito
Nodemailer/recipients sem Return-Path explícito → bounces voltam para o Envelope-From, que pode não ser monitorado. Para outreach: configurar `envelope.from = bounce+<campaignLeadId>@skale.club` (VERP) e processar via SMTP inbound (já temos infra em `:25`).

### P2-09 — IMAP connection: sem connection pooling ou retry com backoff
`processReplies.ts` e `processBounces.ts` abrem nova conexão IMAP a cada execução, sem retry. Falha transiente (timeout, network blip) → próximo cron tenta de novo (15-30min depois). Melhor: 3 retries com exponential backoff.

### P2-10 — Sem dashboard de status do processor (UI)
Não há tela admin que mostre "última execução do processOutreachSequences, X leads processados, Y emails enviados, Z erros". Operador não tem visibilidade do sistema.

### P2-11 — Logs em `console.log` / `console.error` — sem structured logging
Em produção (Hetzner Docker), logs vão para stdout. Sem timestamps, sem level, sem JSON. Trace de problema multi-step é difícil. Adicionar `pino` com bindings (campaignId, leadId).

### P2-12 — `campaignLead.totalReplies` é incrementado mas nunca usado (existe `lead.totalReplies` e `campaign.totalReplies` redundantes)
Schema tem 3 contadores de reply. Manter um (`outreach_emails.repliedAt` é a source-of-truth, agregação por COUNT).

### P2-13 — `sequenceStep.totalSent/Opens/Clicks/Replies` nunca são incrementados
`schema.ts:815-818` define os campos. Nenhum job/route incrementa. Métricas por-step não funcionam (relevante para descobrir qual step é o melhor).

### P2-14 — Soft-bounce não retenta
Bounce tipo `soft` (greylisting, mailbox full) marca lead como `bounced` permanentemente. Deveria retentar em N horas (configurável), com cap de 3 tentativas, então marcar como hard bounce.

### P2-15 — `incrementStat` em `tracking.ts` usa categoria de message (não outreach) mesmo no contexto outreach
Se P0-02 for resolvido, o stat correto para outreach open/click precisaria ir para `outreachAnalytics`, não `statistics`.

### P2-16 — Frontend `SettingsPage` define interface `OutreachSettings` mas o backend não tem endpoint
`SettingsPage.tsx:18-39` define settings global de outreach (`defaultTimezone`, `trackOpens` etc.). Não vi rota correspondente. Provável que a página esteja mostrando mock/default sem persistir.

### P2-17 — Não há test suite — projeto declara explicitamente "No testing framework is currently configured"
Pelo menos os parsers (`parseBounceMessage`, `interpolateTemplate`, `selectAbVariant`) deveriam ter testes unitários. Risco de regressão é altíssimo.

### P2-18 — `processBounces` usa `desc` mas importado de drizzle-orm — não está usado
`processBounces.ts:19` importa `desc` mas é usado apenas dentro de `with: { orderBy: [desc(...)] }`. OK, mas duplicate import existe?

### P2-19 — Variável de provider `account.provider` é checada com `=== 'outlook'` mas Gmail OAuth não existe
`outreach-sender.ts:136`: só Outlook. Gmail OAuth não está implementado, mas `NewInboxPage` lista Gmail como preset de SMTP (linhas 67-73) com user/pass — exige App Password. UX não esclarece isso.

---

## Pontos fortes

1. **Idempotency guard** em `processOutreachSequences.ts:211-214` usando `existingEmailsSet` previne envio duplicado dentro da mesma batch — boa defesa.
2. **A/B variant determinístico** via MD5 hash (`selectAbVariant`) — não muda variant em re-tentativas, consistente com expectativa do usuário.
3. **Batch-loading** de campaigns, sequences, steps, suppressions e existing emails antes do loop (linhas 99-142) — bom para performance em vez de N+1.
4. **RLS bem estruturado** com helper functions SECURITY DEFINER (`is_outreach_org_member`, `is_campaign_org_member`, `is_sequence_org_member`, `is_campaign_lead_org_member`) — design correto, mesmo que o middleware HTTP atualmente bypasse.
5. **Encryption** de SMTP/IMAP passwords e Outlook refresh tokens via `encryptSecret/decryptSecret` — campos sensíveis protegidos.
6. **SSRF protection** em `/t/click/:token` (`isPrivateHost` rejeita IPs internos) — boa defesa contra abuso do redirect.
7. **Constraints** no schema (`sequence_steps_delay_hours_positive`, `sequence_steps_order_positive`, `outreach_emails_campaign_lead_step_unique`) — defesa em profundidade.
8. **`canSendFromAccount`** valida `currentDailySent >= dailySendLimit` antes de tentar enviar — respeita a quota.
9. **`processOutreachSequences` skipa campaigns não-active e leads `unsubscribed/bounced/replied`** — para sequence corretamente quando deveria.
10. **`fetchOne` IMAP usa lock por mailbox** (`getMailboxLock`) — boa prática IMAP.
11. **Outlook OAuth token refresh** com skew (`REFRESH_SKEW_MS`) e fallback para refresh token antigo se o IDP não devolver novo — robusto.
12. **Frontend usa React Query** consistentemente em todas as páginas de outreach — invalidation funciona em mutations.

---

## Próximos passos sugeridos (priorizados)

**Fase 1 — Desbloquear produção (1-2 dias):**
1. Corrigir P0-04 (remover middleware admin que bloqueia tudo)
2. Corrigir P0-01 (setar `nextScheduledAt` ao adicionar leads)
3. Corrigir P0-09 (subquery quebrada em firstStep) — caso contrário P0-01 não adianta
4. Corrigir P0-10 (CASCADE / teardown manual em delete campaign)
5. Smoke test: criar org → adicionar inbox → criar campaign → criar sequence → adicionar lead → confirmar email chega

**Fase 2 — Conformidade legal/deliverability (3-5 dias):**
6. Corrigir P0-03 (montar /unsubscribe + injetar List-Unsubscribe + adicionar variável `{{unsubscribeUrl}}` + página de confirmação one-click POST)
7. Corrigir P0-07 (inserir em suppressions em bounce/unsubscribe)
8. Corrigir P0-02 (tracking de open/click realmente registrar para outreach)
9. P1-12 (HMAC no token de unsubscribe)
10. P1-07 (timezone no send window)

**Fase 3 — Robustez (1 semana):**
11. P0-05 / P0-06 (idempotency-first + advisory lock)
12. P0-08 (bounce SQL LOWER em UUID)
13. P1-04 (LIKE com substring perigosa em messageId)
14. P1-17, P1-18 (rate limit por inbox + warmup real)
15. P1-19 (transação em markAsReplied/markAsBounced)
16. P1-02 / P1-03 (reply detection mais robusta)

**Fase 4 — Qualidade e observabilidade:**
17. P2-11 (structured logging)
18. P2-17 (testes unitários para parsers + processor)
19. P2-10 (dashboard de status do job)
20. P1-01 (`outreach_enabled` realmente desativar)

---

## ROOT CAUSE FOUND

**Top 5 achados que precisam virar issue imediatamente:**

1. **P0-01** Primeiro email NUNCA dispara — `nextScheduledAt` não é setado ao adicionar leads.
2. **P0-04** Middleware `isPlatformAdmin` no `outreach/index.ts` bloqueia 403 para todos os users normais. Produto inacessível para os clientes reais.
3. **P0-03** Unsubscribe não montado + List-Unsubscribe ausente. Viola CAN-SPAM/RFC 8058. Gmail/Yahoo classificarão como spam em escala.
4. **P0-02** Tracking de open/click de outreach é silenciosamente noop — rota busca em `messages.token`, não em `outreach_emails`. Dashboards mentem 0%.
5. **P0-07** Suppressions nunca recebem INSERT em bounce/unsubscribe — reputação do remetente se degrada com re-tentativas.

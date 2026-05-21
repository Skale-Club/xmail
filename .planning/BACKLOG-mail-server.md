# Mail Server — Backlog (pendências de 2026-04-15)

Itens que ficaram para outra iteração. Priorizados por impacto em "Thunderbird usável de verdade".

## Alta prioridade

### 1. TLS em desenvolvimento local
**Problema:** Sem `MAIL_TLS_CERT_PATH`/`MAIL_TLS_KEY_PATH`, IMAP/SMTP/MX sobem em plaintext. Thunderbird recusa conectar em `SSL/TLS` conforme anunciado pelo endpoint `/api/system/mail-server-info`.

**O que fazer:**
- Documentar workflow com `mkcert`: `mkcert -install && mkcert mail.local`
- Atualizar README/docs com passo-a-passo
- (Opcional) script `npm run dev:certs` que gera certs self-signed se não existirem

**Impacto:** bloqueia teste end-to-end com cliente externo em ambiente de dev.

---

### 2. Reconciliar histórico Supabase (migrations 015-017)
**Problema:** Remoto tem migrations 015, 016, 017 aplicadas mas sem arquivos locais. Tive que renomear a nova de `014_` para `018_` para contornar. Impede `supabase db push` limpo no futuro.

**O que fazer:**
- Opção A (segura): `supabase db pull --db-url "$DATABASE_URL"` para recriar os arquivos 015-017 a partir do schema remoto
- Opção B (invasiva): `supabase migration repair --status reverted 015 016 017 --db-url "$DATABASE_URL"` se as migrations 015-017 são desconhecidas/descartáveis

**Impacto:** próximas migrations via Supabase CLI continuarão exigindo workaround.

---

### 3. ESLint sem configuração
**Problema:** `npm run lint` falha com "couldn't find a configuration file". Pré-existente antes das mudanças deste ciclo.

**O que fazer:**
- Criar `.eslintrc.cjs` ou `eslint.config.js` compatível com ESLint 8 usado no projeto
- Decidir ruleset (típico: `@typescript-eslint/recommended` + `react-hooks`)
- Rodar `npm run lint` em CI

**Impacto:** sem lint automático, regressões de estilo/qualidade passam.

---

### 3.1. ~~Missing @types/html-to-text~~ (FEITO em 2026-04-15)
Resolvido: `npm install -D @types/html-to-text@9.0.4`. Type-check passa limpo agora.

---

## Média prioridade

### 4. DKIM signing no SMTP submission outbound
**Problema:** Mensagens relayadas para endereços externos não são assinadas com DKIM. Caem em spam de Gmail/Outlook.

**O que fazer:**
- Integrar [`dkim-signer`](https://www.npmjs.com/package/dkim-signer) ou equivalente no `smtp-server.ts` em `relayMessage()` e `deliverViaRoutes()`
- Ler selector + chave privada de `src/db/schema.ts` tabela `domains` (já tem campos `dkim_selector`, `dkim_private_key`)
- Assinar o buffer `rawEmail` antes de passar pro nodemailer

**Impacto:** deliverability externa comprometida sem isso.

---

### 5. SPF/DMARC/ARC verification no MX receiver
**Problema:** MX receiver aceita qualquer remetente sem verificar SPF/DMARC. Permite spoofing livre.

**O que fazer:**
- Usar [`mailauth`](https://www.npmjs.com/package/mailauth) no `mx-server.ts` `onData` para parsear headers Received/Authentication-Results
- Adicionar header `Authentication-Results` na parsed email
- Rejeitar no `onRcptTo` ou marcar como spam se SPF=fail + DMARC=reject

**Impacto:** segurança — inbox fica vulnerável a phishing.

---

### 6. Greylisting / rate-limit no MX receiver
**Problema:** MX receiver aceita qualquer IP externo sem proteção contra spam bots. Porta 25 pública atrai enxame.

**O que fazer:**
- Rate-limit por IP remoto em `onConnect`/`onMailFrom`
- Greylisting opcional: rejeitar primeira tentativa de par (IP, from, to) com `451 4.7.1 Try again later`, aceitar retry após 5 min
- Blocklist de IPs conhecidos (Spamhaus DNSBL?)

**Impacto:** operação em produção vai ser inundada de spam sem isso.

---

### 7. Persistir raw RFC 2822 em vez de reconstruir
**Problema:** `buildRawMessage()` em `imap-server.ts` reconstrói mensagens a partir de campos normalizados. Perde headers originais (Return-Path, Received, DKIM-Signature etc.), fidelidade baixa.

**O que fazer:**
- Adicionar coluna `raw_mime bytea` em `mail_messages`
- SMTP/MX storeMessage grava o buffer raw original junto
- IMAP FETCH BODY[] retorna `raw_mime` direto quando presente; fallback para reconstrução em mensagens antigas

**Impacto:** interoperabilidade com clientes que dependem de headers específicos (DKIM, encryption, etc.) fica parcial.

---

## Baixa prioridade / nice-to-have

### 8. IMAP IDLE: emitir FLAGS changes, não só EXISTS
Atual emite apenas `* N EXISTS` em novas mensagens. Per RFC 2177, também deve emitir `* N FETCH (FLAGS ...)` em mudanças de flags e `* N EXPUNGE` em deleções. Já disparamos os eventos (`kind: 'flags'`, `'expunge'`), só falta handler emitir as respostas adequadas.

### 9. Pagination no FETCH
FETCH `1:*` em folder com 100k mensagens carrega tudo em memória. Stream via cursor/batches.

### 10. LIST-EXTENDED, STATUS=SIZE, CONDSTORE, QRESYNC
Extensões modernas que Thunderbird aproveita mas não exige. Ganho: sync mais rápido em mailboxes grandes.

### 11. Webmail badge counts
`mailFolders.totalCount`/`unreadCount` agora são mantidos pelo servidor, mas conferir se o hook do webmail (React Query?) invalida corretamente após operações via IMAP externo. Pode precisar de polling ou SSE.

### 12. POP3 server
Não implementado. Nenhum plano a curto prazo — IMAP é suficiente para 99% dos clientes modernos.

### 13. CardDAV / CalDAV
Fora de escopo atual. Se clientes quiserem sync de contatos/calendário, avaliar `radicale` embutido ou servidor separado.

### 14. Sieve filtering (RFC 5228)
Filtros server-side. Hoje temos `mail_filters` table mas só executada pelo webmail. Expor via ManageSieve (porta 4190) permitiria Thunderbird configurar regras.

---

## Concluído neste ciclo (referência)

- IMAP server: TLS implícito + STARTTLS, rate-limit, EXPUNGE correto, APPEND funcional, IDLE (EXISTS delta), UIDVALIDITY/UIDNEXT, AUTHENTICATE PLAIN/LOGIN, UID FETCH/STORE/COPY/SEARCH corretos, allocateNextUid atômico, recomputeFolderCounts, NAMESPACE, graceful shutdown, buffer limit 10MB
- SMTP submission: TLS (465 implícito, 587 STARTTLS), rate-limit, allocateNextUid
- MX receiver (opt-in `ENABLE_MX_RECEIVER=true`) em porta 25/2525
- Autodiscovery: Thunderbird autoconfig XML, Outlook Autodiscover XML, Apple `.mobileconfig`
- UI: card dinâmico "Connect Thunderbird/Outlook/Apple Mail" consumindo `/api/system/mail-server-info`
- Migration 018 aplicada via `postgres` driver (CLI com pooler dá prepared-statement error)

-- 059 — normaliza colunas jsonb duplo-codificadas (2026-08-15)
--
-- O Supavisor infere um parâmetro JSONB como jsonb antes de o postgres-js enviá-lo. Como o valor já
-- passou por JSON.stringify (pelo Drizzle, ou à mão no INSERT em SQL cru), ele era codificado uma
-- SEGUNDA vez e a coluna guardava uma STRING JSON em vez de objeto/array. `lib/jsonb.ts` existe
-- exatamente para isso (`::text::jsonb`), e os writes do caminho de prospecção já o usavam — os de
-- lead e os de mail não. Corrigido em código no commit que acompanha esta migration.
--
-- Por que passou despercebido: o ORM faz JSON.parse na leitura, então o round-trip é simétrico e a
-- aplicação funciona. Quem enxerga a diferença é o SQL do servidor — numa linha duplo-codificada
-- `jsonb_exists` é sempre false, `->>` é sempre null, `|| '{}'::jsonb` devolve array em vez de
-- objeto, e `jsonb_object_keys` levanta "cannot call on a scalar".
--
-- Consequência concreta: o merge de re-import em routes/outreach/leads.ts protege a atribuição de
-- primeiro toque com jsonb_exists(custom_fields, 'source_run_id'). Essa guarda nunca teria
-- disparado, deixando um run posterior roubar em silêncio a atribuição do run que achou o lead.
--
-- `#>> '{}'` extrai o texto do escalar JSON e o recast o reinterpreta uma única vez. Idempotente
-- por construção: o WHERE só alcança linhas ainda no formato errado, então reexecutar não faz nada.
-- Seguro para a aplicação durante o rollout porque o ORM lê as duas formas corretamente.

-- leads
UPDATE public.leads
SET custom_fields = (custom_fields #>> '{}')::jsonb
WHERE jsonb_typeof(custom_fields) = 'string';

UPDATE public.leads
SET icp_score_breakdown = (icp_score_breakdown #>> '{}')::jsonb
WHERE jsonb_typeof(icp_score_breakdown) = 'string';

-- mail_messages
UPDATE public.mail_messages
SET to_addresses = (to_addresses #>> '{}')::jsonb
WHERE jsonb_typeof(to_addresses) = 'string';

UPDATE public.mail_messages
SET cc_addresses = (cc_addresses #>> '{}')::jsonb
WHERE jsonb_typeof(cc_addresses) = 'string';

UPDATE public.mail_messages
SET bcc_addresses = (bcc_addresses #>> '{}')::jsonb
WHERE jsonb_typeof(bcc_addresses) = 'string';

UPDATE public.mail_messages
SET headers = (headers #>> '{}')::jsonb
WHERE jsonb_typeof(headers) = 'string';

UPDATE public.mail_messages
SET attachments = (attachments #>> '{}')::jsonb
WHERE jsonb_typeof(attachments) = 'string';

-- outreach_provider_events
UPDATE public.outreach_provider_events
SET to_addresses = (to_addresses #>> '{}')::jsonb
WHERE jsonb_typeof(to_addresses) = 'string';

UPDATE public.outreach_provider_events
SET cc_addresses = (cc_addresses #>> '{}')::jsonb
WHERE jsonb_typeof(cc_addresses) = 'string';

UPDATE public.outreach_provider_events
SET headers = (headers #>> '{}')::jsonb
WHERE jsonb_typeof(headers) = 'string';

UPDATE public.outreach_provider_events
SET attachments = (attachments #>> '{}')::jsonb
WHERE jsonb_typeof(attachments) = 'string';

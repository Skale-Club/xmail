-- 051 — Warm-up engine (mesh de caixas próprias)
--
-- Até aqui "warm-up" no Xmail era só uma rampa de teto diário, e o contador avançava por
-- calendário: uma caixa que nunca enviou nada "graduava" sozinha e recebia limite cheio. Esta
-- migration dá base para aquecimento REAL: tráfego próprio entre as caixas cadastradas na
-- plataforma (IceMail/Google, nativas dos domínios de projeto, Gmail pessoal via IMAP), com
-- detecção de pasta (Inbox vs Spam), resgate de spam, resposta em thread e ARQUIVAMENTO ao fim
-- do ciclo — o inbox de quem participa não vira um caos.
--
-- Decisões de produto (2026-08-14):
--   * A participação é um campo do CADASTRO NORMAL de inbox (email_accounts), não uma tabela
--     paralela de "seeds". Qualquer caixa com credencial entra no mesh; caixas podem existir SÓ
--     para warm-up (warmup_only) e ficam proibidas de campanha.
--   * O Message-ID é a chave de correlação da detecção. Nenhum header X-Warmup: marcador próprio
--     denunciaria o tráfego como sintético exatamente para os filtros que queremos convencer.
--
-- Idempotente. Aditiva: nada é removido e nenhum default muda comportamento existente.

-- 1. Participação no mesh + procedência + atestação ---------------------------

ALTER TABLE public.email_accounts
    ADD COLUMN IF NOT EXISTS warmup_source text NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS warmup_only boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS warmup_started_at timestamp,
    ADD COLUMN IF NOT EXISTS warmup_sent_today integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS warmup_attested_at timestamp,
    ADD COLUMN IF NOT EXISTS warmup_attested_by uuid REFERENCES public.users(id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_warmup_source_check'
    ) THEN
        ALTER TABLE public.email_accounts
            ADD CONSTRAINT email_accounts_warmup_source_check
            CHECK (warmup_source IN ('none', 'internal', 'vendor', 'provider'));
    END IF;
END $$;

COMMENT ON COLUMN public.email_accounts.warmup_source IS
    'Quem aquece esta caixa: none (ninguém), internal (mesh do Xmail — envia, recebe, responde, arquiva), vendor (ferramenta externa por IMAP/SMTP), provider (veio pré-aquecida). Só ''internal'' participa do mesh.';
COMMENT ON COLUMN public.email_accounts.warmup_only IS
    'Caixa existe apenas para aquecimento. Nunca pode ser atribuída a leads de campanha; o gate de ativação e os enrolls rejeitam.';
COMMENT ON COLUMN public.email_accounts.warmup_sent_today IS
    'Envios de aquecimento hoje. Contador SEPARADO de current_daily_sent: aquecimento não consome cota de campanha, mas conta como dia de envio real para a rampa (resetDailyLimits).';
COMMENT ON COLUMN public.email_accounts.warmup_attested_at IS
    'Quando um humano atestou aquecimento feito FORA do Xmail (vendor/provider) — o contador interno nunca veria esse tráfego.';

CREATE INDEX IF NOT EXISTS idx_email_accounts_warmup_mesh
    ON public.email_accounts (warmup_source, status)
    WHERE warmup_source = 'internal';

-- 2. Mensagens de aquecimento -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.warmup_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Org da caixa REMETENTE (o mesh é global do operador; cada linha pertence a um tenant).
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    from_account_id uuid NOT NULL REFERENCES public.email_accounts(id) ON DELETE CASCADE,
    to_account_id uuid NOT NULL REFERENCES public.email_accounts(id) ON DELETE CASCADE,
    to_address text NOT NULL,
    subject text NOT NULL,
    -- Correlação do passo de leitura. Único: um Message-ID repetido quebraria a detecção.
    message_id text NOT NULL,
    thread_root_message_id text,
    status text NOT NULL DEFAULT 'pending',
    sent_at timestamp,
    detected_at timestamp,
    -- 'inbox' | 'spam' | 'missing' — o dado que realmente importa medir no aquecimento.
    detected_folder text,
    rescued_at timestamp,
    replied_at timestamp,
    archived_at timestamp,
    last_error text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT warmup_messages_message_id_unique UNIQUE (message_id),
    CONSTRAINT warmup_messages_status_check
        CHECK (status IN ('pending', 'sent', 'delivered', 'rescued', 'replied', 'archived', 'failed')),
    CONSTRAINT warmup_messages_folder_check
        CHECK (detected_folder IS NULL OR detected_folder IN ('inbox', 'spam', 'missing'))
);

CREATE INDEX IF NOT EXISTS idx_warmup_messages_org_sent
    ON public.warmup_messages (organization_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_warmup_messages_from_account_sent
    ON public.warmup_messages (from_account_id, sent_at DESC);
-- Fila do passo de leitura/limpeza: enviadas, resgatadas ou respondidas ainda não arquivadas.
CREATE INDEX IF NOT EXISTS idx_warmup_messages_awaiting_groom
    ON public.warmup_messages (to_account_id, sent_at)
    WHERE status IN ('sent', 'rescued', 'delivered', 'replied');

-- 3. RLS (defense-in-depth; o app usa a role do DATABASE_URL e fura RLS — o isolamento real
--    é o organization_id em cada query, ver CLAUDE.md) -------------------------

ALTER TABLE public.warmup_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warmup_messages_org_members ON public.warmup_messages;
CREATE POLICY warmup_messages_org_members ON public.warmup_messages
    FOR ALL USING (
        organization_id IN (
            SELECT organization_id FROM public.organization_users WHERE user_id = auth.uid()
        )
    );

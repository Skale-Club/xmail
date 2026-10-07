-- Alertas de resposta no Telegram: estado do último aviso por conversa.
--
-- O que NÃO está aqui de propósito: se a conversa está pendente, lida, respondida, resolvida
-- ou arquivada. Isso o Unified Inbox já diz sozinho (outreach_conversations.status /
-- archived_at / last_inbound_at / last_outbound_at e outreach_conversation_reads). Um segundo
-- modelo de estado divergiria do primeiro na primeira vez que o Vanildo respondesse por outro
-- caminho. Esta tabela guarda só o que nenhuma tabela existente sabe: QUANDO o último aviso
-- saiu e sobre QUAL resposta, para espaçar os lembretes de 2 em 2 horas e não repetir o aviso
-- imediato quando o gancho de processReplies e o job de varredura chegam à mesma resposta.
--
-- Uma linha por conversa (unique organization_id + conversation_id). reply_message_id é a
-- mensagem de entrada (outreach_conversation_messages.id) sobre a qual o último aviso falou:
-- uma resposta NOVA na mesma conversa tem outro id e dispara um aviso imediato novo, mesmo que
-- a conversa tenha sido resolvida e reaberta entre uma e outra.
--
-- Sem CREATE INDEX CONCURRENTLY e sem BEGIN/COMMIT: o runner já envolve cada arquivo numa
-- transação (CLAUDE.md, "Applying").

CREATE TABLE IF NOT EXISTS inbox_reply_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES outreach_conversations(id) ON DELETE CASCADE,
    reply_message_id uuid NOT NULL,
    first_alerted_at timestamptz NOT NULL DEFAULT now(),
    last_alerted_at timestamptz NOT NULL DEFAULT now(),
    alert_count integer NOT NULL DEFAULT 1,
    last_kind text NOT NULL DEFAULT 'first',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inbox_reply_alerts_kind_check CHECK (last_kind IN ('first', 'reminder', 'summary')),
    CONSTRAINT inbox_reply_alerts_count_check CHECK (alert_count >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_reply_alerts_conversation_unique
    ON inbox_reply_alerts (organization_id, conversation_id);

-- RLS só como defesa em profundidade (CLAUDE.md, "Authentication Flow"): a role do app ignora
-- RLS e a autorização real é JS. Sem políticas de escrita: só o app grava aqui.
ALTER TABLE public.inbox_reply_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_reply_alerts_select ON public.inbox_reply_alerts;
CREATE POLICY inbox_reply_alerts_select ON public.inbox_reply_alerts FOR SELECT TO authenticated
    USING (public.is_platform_admin() OR public.is_org_member(organization_id));

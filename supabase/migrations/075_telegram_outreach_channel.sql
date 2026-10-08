-- Segundo canal do Telegram: avisos de outreach (respostas de prospect e cartoes de aprovacao)
-- vao para um chat proprio, e o chat atual fica so com operacao (deploy, erros, watchdog).
--
-- Os dois campos sao opcionais. Sem telegram_outreach_chat_id o app usa o chat de operacao
-- (telegram_chat_id) tambem para outreach, entao nada se perde antes da configuracao.
-- telegram_outreach_thread_id so vale para grupo com Topicos ligados e acompanha o chat de
-- outreach; nunca e aplicado ao chat de operacao.
--
-- O id costuma ser gravado pelo proprio bot: quando e adicionado a um grupo, o Xmail pergunta ao
-- dono (no chat privado de operacao) se aquele grupo deve receber os avisos de outreach.
--
-- Idempotente; sem BEGIN/COMMIT e sem CREATE INDEX CONCURRENTLY (o runner ja envolve o arquivo
-- numa transacao, ver CLAUDE.md, "Applying").

ALTER TABLE system_integrations
    ADD COLUMN IF NOT EXISTS telegram_outreach_chat_id TEXT,
    ADD COLUMN IF NOT EXISTS telegram_outreach_thread_id TEXT;

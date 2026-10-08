-- Follow-ups de sequência podem sair com o assunto em branco: o e-mail vai como resposta na
-- mesma conversa (`Re: <assunto do e-mail anterior>`, In-Reply-To/References do anterior; ver
-- src/server/lib/outreach-threading.ts).
--
-- A 040 exigia assunto não vazio em todo passo de e-mail (`sequence_steps_content_valid`). Aqui o
-- assunto continua NOT NULL, mas pode ser '' quando step_order > 1. O passo 1 segue exigindo
-- assunto no banco. "Primeiro passo de e-mail" de verdade (uma sequência pode abrir com um delay)
-- é regra do código: validateSequenceForActivation e o schema Zod de sequences.
--
-- Só afrouxa a regra: toda linha que já existe continua válida, então o ADD CONSTRAINT não falha
-- por dado antigo. Idempotente (DROP IF EXISTS + ADD). Sem BEGIN/COMMIT: o runner já envolve cada
-- arquivo numa transação (CLAUDE.md, "Applying").
--
-- ATENÇÃO: o código novo grava assunto '' em passos > 1. Sem esta migration aplicada, esse
-- salvamento falha na constraint antiga (erro 500, nada é gravado, nenhum e-mail sai errado).

ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_content_valid;
ALTER TABLE sequence_steps
    ADD CONSTRAINT sequence_steps_content_valid CHECK (
        (
            type = 'email'
            AND subject IS NOT NULL AND (btrim(subject) <> '' OR step_order > 1)
            AND (
                (plain_body IS NOT NULL AND btrim(plain_body) <> '')
                OR (html_body IS NOT NULL AND btrim(html_body) <> '')
            )
        )
        OR (
            type <> 'email'
            AND subject IS NULL AND plain_body IS NULL AND html_body IS NULL
            AND subject_b IS NULL AND plain_body_b IS NULL AND html_body_b IS NULL
        )
    );

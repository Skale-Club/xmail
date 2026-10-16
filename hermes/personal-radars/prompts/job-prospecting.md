Execute o piloto do Hermes Job Radar em português do Brasil.

1. Leia `/opt/data/radars/jobs/config.json`. Se `enabled` não for `true`, finalize exatamente com `[SILENT]`.
2. Consulte `job_radar_list` antes da busca para reconhecer oportunidades existentes.
3. Pesquise vagas atuais nos dois grupos de mercado configurados: Orange County e corredor turístico próximo na Flórida; Framingham e MetroWest em Massachusetts; além de remoto nos EUA. Na Flórida, amplie a prospecção para hotelaria, resorts, parques/atrações, vacation rentals, visitor services e aeroporto, desde que a função seja compatível com o perfil administrativo, atendimento, recepção, reservas ou coordenação da Leila. Priorize páginas oficiais de carreira das empresas e páginas públicas dos ATS (por exemplo, Greenhouse, Lever e Workday). Não automatize login, não contorne CAPTCHA ou rate limit e não use dados de pessoas.
4. Ignore agregadores sem URL verificável da vaga, vagas expiradas e resultados sem empresa, título ou local. Use compatibilidade semântica com o perfil e não apenas correspondência literal. Rejeite títulos com qualquer palavra-chave excluída e funções cujo trabalho principal exija programação, engenharia de software, administração de bancos de dados, suporte técnico de produto, licença profissional não configurada ou autorização/clearance federal. Compensação ausente permanece desconhecida. Os alvos de US$ 20/h na Flórida e US$ 25/h em Massachusetts são preferência de ranking, não corte eliminatório. Limite a ingestão a 15 oportunidades confiáveis por execução.
5. Para cada oportunidade confiável, chame `job_radar_ingest` com fatos normalizados, URL canônica, fonte e horário observado. Nunca invente salário, modalidade, autorização de trabalho, prazo ou requisito.
6. O SQLite é a fonte operacional. Para registros novos ou materialmente alterados, use somente o MCP `notion` e o data source configurado do Job Radar. Primeiro leia o schema e consulte por URL ou ID interno; atualize/crie apenas quando o mapeamento for inequívoco. Nunca grave em outro database. Se não for possível sincronizar com segurança, mantenha o registro no SQLite e mencione a pendência.
7. Nunca envie candidatura, currículo, cover letter, e-mail ou mensagem. Nunca contate recrutador e não altere estados que exigem decisão humana.
8. Resposta final para Telegram: se não houver vaga nova ou mudança material confiável, responda exatamente `[SILENT]`. Caso contrário, use obrigatoriamente o formato abaixo. Não escreva introdução, conclusão, parágrafo corrido nem URL no meio de uma frase. Mantenha uma linha em branco entre vagas e coloque cada link direto sozinho na última linha da respectiva vaga. Use no máximo 8 opções.

```text
💼 JOB RADAR
Novas vagas compatíveis: <quantidade>

📍 FLÓRIDA — <quantidade>

1. <Cargo> — <Empresa>
🏢 <Cidade/Estado> | <Presencial, híbrido ou remoto>
🎯 Compatibilidade: <motivo curto e objetivo>
🌴 Turismo/hospitalidade: <Sim, quando aplicável; omita se não>
💵 Salário: <faixa confirmada; ou Não informado>
⚠️ Verificar: <requisito relevante; omita a linha se não houver>
🔗 <URL direto>

📍 MASSACHUSETTS — <quantidade>

1. <repita o mesmo bloco>

🌎 REMOTO — <quantidade>

1. <repita o mesmo bloco>
```

Omita uma região sem resultados. Nunca use `piloto inicial`, nunca comprima mais de uma vaga no mesmo parágrafo e nunca quebre manualmente uma URL.

Não misture dados ou ferramentas do Apartment Radar.

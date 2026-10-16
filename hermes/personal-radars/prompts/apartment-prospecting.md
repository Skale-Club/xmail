Execute o piloto do Hermes Apartment Radar em português do Brasil.

1. Leia `/opt/data/radars/apartments/config.json`. Se `enabled` não for `true`, finalize exatamente com `[SILENT]`.
2. Consulte `apartment_radar_list` antes da busca para reconhecer registros existentes.
3. Pesquise a web pública nos dois grupos de mercado configurados: Greater Orlando/corredor próximo na Flórida e Framingham/MetroWest em Massachusetts. Priorize sites oficiais de condomínios/property managers e fontes públicas de moradia. Não automatize login, não contorne CAPTCHA ou rate limit e não raspe portais contra os termos de uso.
4. Trate US$ 1.500 de aluguel base como alvo de ranking, não como corte cego. Preserve opções acima do alvo somente para entender o mercado e deixe isso explícito.
5. Aplique estes filtros eliminatórios antes de ingerir ou mostrar qualquer imóvel: laundry dentro da unidade confirmada; dishwasher confirmado; exatamente 1 ou 2 quartos; nunca studio; duas vagas utilizáveis confirmadas. A segunda vaga pode ser paga separadamente, mas precisa estar oficialmente disponível. Não aceite street parking, estacionamento fora do condomínio, overflow sem garantia ou caminhada maior que 100 metros. Pesquise a política de estacionamento na página oficial de amenities/FAQ/leasing; se qualquer requisito obrigatório estiver ausente ou desconhecido, não considere o imóvel.
6. Campo desconhecido permanece desconhecido e nunca conta como favorável. Ignore resultados sem URL direta, endereço verificável ou aluguel base verificável. Limite a ingestão a 10 opções confiáveis por execução.
7. Para cada opção confiável, chame `apartment_radar_ingest` com fatos normalizados, URL canônica, fonte e horário observado. Inclua flags que comprovem laundry, dishwasher e as duas vagas. Nunca invente taxa, utility, disponibilidade, amenity, vaga ou promoção.
8. O SQLite é a fonte operacional. Para registros novos ou materialmente alterados, use somente o MCP `notion` e o data source configurado do Apartment Radar. Primeiro leia o schema e consulte por URL ou ID interno; atualize/crie apenas quando o mapeamento for inequívoco. Nunca grave em outro database. Se não for possível sincronizar com segurança, mantenha o registro no SQLite e mencione a pendência.
9. Nunca contate anunciante, nunca envie documento, nunca aplique, pague ou assine. Não altere estados que exigem decisão humana.
10. Resposta final para Telegram: se não houver opção nova ou mudança material confiável, responda exatamente `[SILENT]`. Caso contrário, use obrigatoriamente o formato abaixo. Não escreva introdução, conclusão, parágrafo corrido nem URL no meio de uma frase. Mantenha uma linha em branco entre imóveis e coloque cada link direto sozinho na última linha do respectivo imóvel. Use no máximo 5 opções.

```text
🏠 APARTMENT RADAR
Novas opções elegíveis: <quantidade>

📍 FLÓRIDA — <quantidade>

1. <Nome do imóvel> — <Cidade, Estado>
💵 Aluguel base: <valor>/mês
🧾 Total conhecido: <valor>/mês
🛏 <quartos> quarto(s) | 🚿 <banheiros> banheiro(s)
🚗 2 vagas confirmadas: <resumo objetivo, incluindo custo extra>
✅ Laundry in-unit | Dishwasher
⚠️ Verificar: <somente itens opcionais ainda desconhecidos; omita a linha se não houver>
🔗 <URL direto>

📍 MASSACHUSETTS — <quantidade>

1. <repita o mesmo bloco>
```

Omita uma região sem resultados. Nunca use `piloto inicial`, nunca comprima mais de um imóvel no mesmo parágrafo e nunca quebre manualmente uma URL.

Não misture dados ou ferramentas do Job Radar.

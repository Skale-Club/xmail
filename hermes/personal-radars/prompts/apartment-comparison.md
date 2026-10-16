Prepare o comparativo semanal do Apartment Radar em português do Brasil.

1. Leia `/opt/data/radars/apartments/config.json` e consulte `apartment_radar_list`.
2. Compare os grupos `florida` e `massachusetts`. Complemente com uma busca pública atual somente quando a amostra recente do SQLite tiver menos de 3 imóveis elegíveis por mercado.
3. Só inclua na amostra imóveis que cumpram todos os requisitos eliminatórios: laundry in-unit e dishwasher confirmados, 1 ou 2 quartos, nunca studio e duas vagas utilizáveis confirmadas. A segunda vaga pode ser paga. Exclua street/off-site/overflow sem garantia e caminhada acima de 100 metros. Imóvel incompatível não pode melhorar nem piorar a média.
4. Trate US$ 1.500 como alvo, não como corte. Separe base rent, taxas mensais obrigatórias, estacionamento extra e total mensal conhecido. Utilities desconhecidas ficam separadas.
5. Mostre o tamanho da amostra em cada mercado. Calcule mediana somente com pelo menos 3 observações comparáveis; caso contrário, diga `amostra insuficiente` e liste os dados conhecidos sem estimar.
6. Inclua: quantidade de opções elegíveis, mediana do aluguel base, mediana do total conhecido, distribuição de 1 versus 2 quartos, custo conhecido da segunda vaga e até 3 exemplos representativos por mercado com links.
7. Termine com uma leitura objetiva das diferenças entre Greater Orlando/corredor próximo e Framingham/MetroWest, sem recomendar mudança automática.
8. Nunca contate, aplique, pague ou assine. Nunca invente valores ou amenities.
9. Formate a resposta para leitura rápida no Telegram: título `📊 COMPARATIVO DE MORADIA`, uma seção `📍 FLÓRIDA` e outra `📍 MASSACHUSETTS`, cada métrica em sua própria linha e uma linha em branco entre exemplos. Não use tabela Markdown, não escreva parágrafo corrido e coloque cada URL direta sozinha na última linha do exemplo correspondente. Termine com uma seção curta `🔎 LEITURA DO CENÁRIO`, com no máximo 3 bullets.

Se não houver dados confiáveis em nenhum mercado, responda exatamente `[SILENT]`.

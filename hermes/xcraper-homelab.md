# Xcraper pelo Home Lab — o que o Hermes precisa saber

Atualizado em 2026-10-07. Substitui o que o `xcraper-access-pattern.md` diz sobre Apify ser o caminho padrão.

## A regra em uma frase

**Toda raspagem do Google Maps sai pelo Home Lab: `scrapeType: "homelab"` em todo `POST /scrape`.**
Apify (`standard`, `enriched`) só com pedido explícito do Vanildo naquele momento.

## Por quê

- O Home Lab é um computador do Vanildo, em casa, rodando o raspador `gosom/google-maps-scraper`. Custo zero por raspagem.
- O Apify cobra por resultado. O crédito gratuito acabou: em 2026-10-07 restavam US$ 0,002 no ciclo, que renova em 12/10. Uma chamada sem `scrapeType` cai em `standard` (Apify) e falha com "Your remaining usage of $0.002205 this billing cycle...".
- O Home Lab já traz o e-mail do site de cada empresa. Não existe motivo para pedir `enriched`.

## Como chamar

```
POST $XCRAPER_SERVICE_URL/scrape
X-Service-Key: $XCRAPER_SERVICE_KEY
{"query": "barbershops", "location": "Waltham, MA", "maxResults": 30, "scrapeType": "homelab", "niche": "barbershop"}
```

`niche` é obrigatório na prática desde 2026-10-08: é o tipo de negócio da busca (slug minúsculo, inglês, singular: `barbershop`, `nail_salon`). É ele que separa os públicos do Meta por nicho. Slug inválido volta 400.

Respostas possíveis:

| Situação | Resposta | O que fazer |
|---|---|---|
| Home Lab livre | `202`, `status: "running"`, `queued: false` | Acompanhar até terminar |
| Home Lab ocupado | `202`, `status: "queued"`, `queued: true`, `queuePosition: N` | **Não reenviar.** Só acompanhar; ela começa sozinha |
| Home Lab fora do ar | `502`, mensagem citando o homelab | Avisar o Vanildo. **Não** trocar para Apify por conta própria |
| Configuração faltando | `503` "not configured" | Avisar o Vanildo |
| Usuário não é o dono | `403` "restricted to the account owner" | Não deve acontecer pela chave de serviço; avisar |
| `scrapeType` errado | `400` com a lista `standard`, `enriched`, `homelab` | Usar `homelab` |

O campo `apifyRunId` da resposta guarda o id do trabalho no Home Lab. O nome é antigo, não significa que foi pelo Apify.

## Acompanhar: a parte que mais importa

`GET $XCRAPER_SERVICE_URL/scrape/<searchId>` até `status` ser `completed` ou `failed`.

1. **Uma raspagem por vez.** O Home Lab divide a máquina com a casa (Immich, Home Assistant, câmeras), então roda com uma aba e limite de memória e processador. Duas buscas ao mesmo tempo viram fila.
2. **A fila só anda quando alguém consulta.** O Xcraper não tem relógio próprio: quem empurra a próxima busca da fila é a consulta de status. Se você pedir 3 cidades e parar de acompanhar, as que estão na fila ficam paradas. Consulte a cada 30 a 60 segundos até a última terminar.
3. **Demora é normal.** Para cada empresa o raspador abre o site atrás do e-mail, uma de cada vez. Tempos de referência:

   | `maxResults` | Tempo aproximado |
   |---|---|
   | 10 | poucos minutos |
   | 30 | ~5 a 10 min |
   | 50 | ~10 a 15 min |
   | 100 | ~20 a 30 min |

   Enquanto roda, o status fica `running` com `progress: 50` parado: isso **não** é travamento. Não use comando com limite de 3 minutos para acompanhar; rode o acompanhamento em segundo plano ou com tempo longo. Em 2026-10-07 o seu acompanhamento foi cortado em 182 s e a busca de Waltham terminou certinha depois.
4. **Limites:** busca na fila há mais de 24 h expira com "expired in the homelab queue". Busca rodando além de ~40 min é dada como falha.
5. Ao terminar, o Xcraper já enviou tudo ao Xphere (bloco `xphere` na resposta: `created`, `updated`, `skipped`). `POST /scrape/<id>/push` só se o envio falhou.

## Como planejar uma prospecção grande

- Prefira várias buscas de 20 a 50 resultados por cidade, em sequência, a uma busca gigante.
- Pode mandar várias de uma vez: elas entram na fila na ordem. Mas acompanhe até a última.
- Não mande dezenas de uma vez: além de atrasar, uma fila longa demais pode estourar as 24 h.
- **Repetir cidade é permitido, em dois casos (regra do Vanildo, 2026-10-07):**
  1. **Cidade grande** (ex.: Boston): uma rodada não pega todas as empresas. Mas a mesma busca exata devolve
     a mesma lista (o Google Maps tem teto de ~120 empresas por busca e ordem fixa). A rodada seguinte tem
     que **mudar o recorte**: por bairro ("barbershop in Dorchester, MA", "barbershop in South Boston, MA")
     ou por termo vizinho ("barber", "men's haircut"). Cada recorte traz uma lista diferente.
  2. **Mesma cidade depois de alguns meses** (referência: 6 meses): aí repetir igual é o certo. As que já
     existem são só atualizadas e as que abriram nesse tempo entram como novas.
- Fora desses dois casos, repetir a mesma busca logo em seguida só atualiza o que existe (Waltham em
  2026-10-07: 10 atualizadas, 0 novas).

## O que NÃO fazer

- Não chamar `scraper.skale.club` direto. Ele é protegido pela Cloudflare e só o Xcraper tem a credencial. O Hermes fala só com o Xcraper.
- Não vasculhar o código do site do Xcraper nem o GitHub para descobrir rotas. Está tudo aqui.
- Não usar `standard`/`enriched` para "testar" ou "comparar" sem o Vanildo pedir: gasta Apify.
- Não reenviar uma busca que está na fila.

## O que já é filtrado sozinho

E-mail de plataforma de agendamento (`help.us@booksy.com`, Vagaro, Square, Squire e outras plataformas, 19 domínios no total) nunca é tratado como e-mail da barbearia: o Xphere não verifica (não gasta crédito), não importa e não matricula. Aparece como `platform_email`.

## O que aconteceu em 2026-10-07 (para referência)

1. O Vanildo pediu um teste pelo Home Lab.
2. Primeira chamada sem `scrapeType`: caiu no Apify e falhou por falta de crédito.
3. Segunda chamada com um `scrapeType` inválido: `400`.
4. Terceira com `"homelab"`, Waltham, 10 resultados: começou na hora, o acompanhamento foi cortado em 3 min, a busca terminou depois com 10 salvos e 10 atualizados no Xphere.
5. Antes disso, um teste feito pelo Claude Code com duas buscas seguidas (Framingham e Natick) provou a fila: a segunda entrou como `queued`, posição 1, e começou sozinha quando a primeira terminou.

# Contrato Xphere → Xmail

> **Para que serve:** os dois sistemas são acoplados por JSON informal, e em 2026-08-15 foram
> encontradas **três divergências de contrato**, todas por acidente e todas silenciosas. Este doc é
> a fonte de verdade sobre o que o Xphere precisa enviar. Toda mudança aqui exige atualizar
> `src/server/lib/prospecting/external-run.ts` e os testes de contrato.
>
> Última revisão: **2026-08-15**.

## Por que este doc existe

As três divergências encontradas, e o que cada uma custou:

| Divergência | Consequência | Como foi descoberta |
|---|---|---|
| Xmail lê `source_run_id`, Xphere manda `xcraper_run_id` | **Todo** run de xcraper com `outcome_* = 0` para sempre; custo-por-resposta dividido por zero | Por acaso, ao auditar a atribuição |
| `websiteInsights` nunca enviado | `{{websiteInsight}}` renderiza vazio, deixando um buraco no corpo do e-mail | Ao ler os textos da campanha |
| Cobertura de e-mail sem campo no payload | Impossível responder "que % tem e-mail?" — decisão de custo recorrente feita às cegas | Ao tentar responder a pergunta |
| A skill do Hermes manda usar campos que o `prospects_list` não devolve | O agente não consegue produzir a segmentação comercial e reporta "PENDING" | Ao chamar a ferramenta direto |

O denominador comum: **nenhuma delas dá erro**. O Xmail aceita o payload, grava o que reconhece e
ignora o resto em silêncio. Um campo que não chega é indistinguível de um campo que chegou vazio.

## Endpoint 1 — `POST /api/outreach/prospecting/external-runs`

Registra o run em si. Auth por `x-service-key`, `?organizationId=` obrigatório.
Idempotente por `(organizationId, provider, externalRunId)`; repetir a chamada reconcilia contagens
sem reprocessar o ledger de custo.

```jsonc
{
  "provider": "xcraper",                    // obrigatório, único valor aceito hoje
  "externalRunId": "88b084af-…",            // obrigatório — o searchId do Xcraper.
                                            // É a chave de atribuição: precisa ser IDÊNTICO ao
                                            // custom_fields.source_run_id dos leads (endpoint 2).
  "label": "barbershops — Marlborough, MA",
  "query": "barbershop",
  "location": "Marlborough, MA",
  "template": "enriched",                   // 'standard' | 'enriched'
  "actorId": "WnMxbsRLNbPeYL6ge",
  "resultCount": 25,
  "importedCount": 25,
  "enrichedCount": 18,                      // ⚠️ NUNCA ENVIADO HOJE — ver abaixo
  "costUsd": 0.1551,                        // custo TOTAL real reportado pelo Apify, não unitário
  "hypothesis": { "premise": "…", "expected": {…}, "basis": "…" },
  "coverage": {                             // ⚠️ NUNCA ENVIADO HOJE — ver abaixo
    "emailFound": 18,
    "emailVerified": 11,
    "byWebPresence":     { "owned_website": 9, "booking_platform": 7, "social_only": 5 },
    "byBookingPlatform": { "booksy": 4, "square": 3 },
    "unclassified": 4
  }
}
```

### O que falta o Xphere mandar

**`enrichedCount`** — quantos resultados passaram por enriquecimento de contato. Sem ele o
`enriched_count` fica em zero mesmo num run `enriched`, que é um valor perfeitamente plausível e
por isso escondeu o problema. É o número que responde "vale a pena pagar por `enriched`?".

**`coverage`** — a distribuição que decide o que fazer com o run. Um run com 10% de e-mail e 80%
sem site próprio é um run **forte** de Website/Xkedule e **fraco** de cold email; sem `coverage` os
dois casos são indistinguíveis.

> **`unclassified` nunca deve ser somado a "sem site".** Desconhecido é desconhecido. Tratá-lo como
> ausência inventa cobertura comercial que ninguém mediu. O Xmail mantém o campo separado por isso.

Enquanto não chegarem, os campos ficam ausentes e **visíveis**: o alerta
`enriched_count_never_populated` em `lib/outreach-silence.ts` dispara no health endpoint. Ausência
nunca é preenchida com zero como se fosse medição.

## Endpoint 2 — `POST /api/outreach/leads/bulk-import`

Cria as linhas da lista de envio. Máximo 1000 por chamada.

```jsonc
{
  "leads": [{
    "email": "appointments@thebarbery.net",   // obrigatório; normalizado para minúsculas
    "companyName": "The Barbery",
    "phone": "+1…",
    "website": "https://thebarbery.net/",
    "location": "75 Main St, Hudson, MA 01749",   // endereço completo; {{city}} é derivado dele
    "source": "xcraper:88b084af-…",               // `<provider>:<runId>`
    "customFields": {
      "source_run_id": "88b084af-…",              // ⚠️ A CHAVE DE ATRIBUIÇÃO
      "email_status": "ok",
      "email_verified_at": "2026-08-15T12:00:00Z",
      "email_verification_provider": "millionverifier",
      "websiteInsights": { "en": "…", "pt": "…" }  // ⚠️ NUNCA ENVIADO HOJE
    }
  }]
}
```

### `source_run_id` — a chave que quebrou tudo

O job de outcome credita um lead ao run por:

```sql
leads.custom_fields->>'source_run_id' = prospecting_runs.idempotency_key
```

O Xphere carimba `xcraper_run_id`. O Xmail passou a **tolerar** os apelidos conhecidos e a extrair
o id do próprio `source` (`lib/prospecting/source-run-id.ts`), então o pipeline funciona hoje —
mas a tolerância é uma rede de segurança, não o contrato. **Mande `source_run_id`.**

Vale a mesma regra de primeiro toque que o Xmail aplica: uma vez gravado, nunca é sobrescrito por
re-import. Deixar um run posterior reivindicar o lead faria dois runs contarem o mesmo humano.

### `websiteInsights` — objeto multilíngue

`{ "en": "…", "pt": "…" }`, não string. A campanha escolhe o idioma no envio pelo
`content_language`, então o mesmo lead pode aparecer em campanhas de idiomas diferentes sem
retrabalho. Uma string simples cai no caminho legado `websiteInsight` e perde essa capacidade.

Hoje o campo não chega, e o `{{websiteInsight}}` do step 1 da campanha piloto renderiza **vazio**,
deixando um parágrafo em branco no meio do e-mail — exatamente onde estaria a personalização que
justifica a abordagem.

## Endpoint 3 (sentido inverso) — `prospects_list` do MCP do Xphere

Não é o Xphere chamando o Xmail, mas é o mesmo acoplamento informal e a mesma classe de
divergência, então mora aqui.

**O que a ferramenta devolve hoje** (verificado em 2026-08-15 contra os 77 prospects de xcraper,
todos os campos presentes em 100% das linhas):

```
id · name · kind · source_type · email · emailDndBlocked · website · score · engagement_status
```

**O que a skill do Hermes mandava usar e não existe:** `web_presence_summary`,
`has_owned_website`, `web_presence`, `booking_platform` — e também `location`, `city` e `phone`.

Consequência: a segmentação comercial que decide entre cold email e proposta de Website/Xkedule
**não pode ser produzida pelo agente**. Foi por isso que a nota do maestro do run de Marlborough
registrou a cobertura como `PENDING` — o Hermes tentou, não achou, e (corretamente) reportou
indisponível em vez de estimar.

> **Ausente em `prospects_list` ≠ ausente no Xphere.** O `meta_audience_sync` projeta
> identificadores no servidor, então o telefone quase certamente existe lá. O que falta é a
> **visibilidade** do agente, não o dado. Confundir as duas coisas leva a "o Xphere não tem
> telefone", que é falso e mandaria arrancar um canal que funciona.

**O que o Xphere precisa expor:** `web_presence_type`, `booking_platform` e `location` em
`prospects_list`, ou uma ferramenta de agregação equivalente. Enquanto não expuser, qualquer
número de presença web é heurística sobre a URL crua — útil para orientar, nunca para reportar
como medição.

## Invariantes, com prova

```bash
# 1. O schema aceita os campos de cobertura (esperado: verde)
npx vitest run src/server/lib/prospecting/__tests__/external-run.test.ts
```

```bash
# 2. A chave de atribuição resolve a partir de todos os apelidos (esperado: verde)
npx vitest run src/server/lib/prospecting/__tests__/source-run-id.test.ts
```

```sql
-- 3. Nenhum lead sem chave de atribuição (esperado: 0)
SELECT count(*) FROM leads WHERE custom_fields->>'source_run_id' IS NULL;
```

```sql
-- 4. Nenhum run enriched sem contagem de enriquecimento (esperado: 0 quando o Xphere cumprir)
SELECT count(*) FROM prospecting_runs
WHERE search_filters->>'template' = 'enriched' AND coalesce(enriched_count, 0) = 0;
```

```bash
# 5. Quais campos o prospects_list REALMENTE devolve. Rode antes de escrever qualquer procedimento
#    que dependa de um campo do Xphere — foi pular esta checagem que produziu a 4ª divergência.
#    A credencial do MCP vive no config.yaml do Hermes; o `initialize` é obrigatório antes de
#    qualquer chamada, e pulá-lo devolve `-32001 Unauthorized`, que se parece com erro de auth.
docker exec hermes python3 -c "
import yaml; c=yaml.safe_load(open('/opt/data/config.yaml'))
m=(c.get('mcp_servers') or c.get('mcp'))['xphere']; print(m['url']); print(m['headers']['Authorization'])"
# → POST initialize, depois tools/call prospects_list, e inspecione as chaves de TODOS os itens
#   (não só do primeiro: um campo opcional pode faltar em uma linha e existir em outra).
```

## Manutenção

Atualize quando mudar qualquer campo dos dois payloads. Se um campo novo for adicionado ao schema
Zod sem entrar aqui, o próximo leitor vai descobrir a divergência do mesmo jeito que as três
primeiras foram descobertas: por acidente, meses depois, com o dado já corrompido.

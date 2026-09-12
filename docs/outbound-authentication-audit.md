# Autenticação de saída — auditoria e plano

> Escrito em 2026-09-12, depois de o warm-up sair de 0% para 11,4% de spam no Gmail e de
> três hipóteses minhas caírem uma atrás da outra. O plano começa pelo instrumento porque a
> falha de fundo não é nenhuma das três: é que **ninguém no sistema consegue ver o que o
> destinatário recebeu**.

## O que está medido

Mesh de warm-up, 7 dias, 1400 mensagens, separado por direção:

| Direção | Total | Inbox | Spam |
|---|---|---|---|
| Gmail (`tryskaleclub.com`) → nossas caixas nativas | 280 | 280 | 0% |
| Nossas caixas nativas entre si | 420 | 420 | 0% |
| **Nossas caixas nativas → Gmail** | **700** | **617** | **11,4%** |

Só a terceira linha mede alguma coisa. As duas primeiras terminam num servidor nosso, que
aceita quase tudo, então 0% ali não é notícia — é a ausência de um juiz.

A degradação é datada: dez dias em 0,0% (29/08 a 08/09), depois 9,5% (09/09), 14,5%
(10/09), 12,0% (11/09), 8,3% (12/09). O primeiro spam sustentado foi às 18:00 de 09/09.

E é **uniforme**: nove domínios remetentes entre 10% e 14%, oito assuntos com taxas
equivalentes, cinco caixas de destino entre 14 e 18 marcações em 140. Uniformidade em todas
as dimensões descarta reputação de um domínio e descarta conteúdo de um assunto. É sistêmico.

## As três hipóteses que caíram, e por que caíram

Registradas porque o padrão do erro importa mais que os erros.

1. **"O nodemailer 10 quebrou a assinatura de mensagem pré-montada."** O deploy foi às 13:47
   de 09/09, quatro horas antes do primeiro spam, e o envio nativo entrega bytes prontos
   (`{ envelope, raw }` em `native-send.ts:68`). Testei localmente contra o nodemailer
   10.0.1 instalado: ele assina mensagem pré-montada **e** mensagem montada por ele. Falso.
2. **"DKIM está passando, então não é autenticação."** A amostra que usei eram mensagens de
   um grupo do Google, não do warm-up. O "38 de 40 passa" não descrevia o tráfego em questão.
   Descartei a hipótese certa com dado errado.
3. **"As mensagens nativas chegam sem assinatura."** Cinco de seis mensagens de warm-up
   recebidas em caixa nativa não tinham `DKIM-Signature` nem `Authentication-Results`. Mas
   toda essa amostra é entrega interna, que não atravessa SMTP — não prova nada sobre o que
   sai para fora. Artefato de amostragem, de novo.

O que **não** caiu, e segue verdadeiro: todos os 11 domínios têm chave DKIM e estão
`verified`; toda entrega registra `DKIM enabled: selector=skaleclub`; o caminho `smtp` (que
sai pelo Google) está em 0%.

## O defeito de fundo

O sistema afirma `DKIM enabled` e não tem como confirmar o que chegou do outro lado. Três
investigações erradas em uma tarde é o sintoma, não a doença. É o mesmo padrão do detector
de silêncio que nunca falava e do campo de saúde que mentia: **uma afirmação sem medição**.

---

## Fase 1 — Instrumento antes de conserto

Sem isto, qualquer conserto abaixo é fé.

1. **Relatórios DMARC voltando para nós.** Hoje o `rua` de `skale.club` aponta para
   `dmarc.mailgun.org`, `inbox.ondmarc.com` e `dmarc.brevo.com` — três terceiros, nenhum
   nosso, e ninguém lê. Os relatórios agregados do Gmail dizem, por domínio e por dia,
   quantas mensagens passaram SPF, quantas passaram DKIM e sob qual política. É a medição
   que falta, e ela já existe: só está endereçada para fora. Acrescentar um endereço nosso
   ao `rua` dos 9 domínios e um job que leia, agregue e exponha.
2. **Google Postmaster Tools** para os 9 domínios. Dá taxa de spam reportada por usuário,
   reputação de domínio e de IP, e erros de autenticação, direto da fonte que está julgando.
   Exige verificação por TXT, uma vez por domínio.
3. **Captura crua de um assento de teste.** Uma caixa em cada provedor grande (Gmail,
   Outlook, Yahoo) que recebe uma cópia de cada campanha e **guarda os bytes como chegaram**.
   É o que teria respondido em cinco minutos a pergunta que me custou a tarde inteira.

Critério de pronto: dado um envio, conseguir responder "passou DKIM no destinatário?" sem
inferir.

## Fase 2 — Verificar o que foi assinado, não a intenção de assinar

O log diz `DKIM enabled` antes de entregar. Isso registra intenção.

- Em `native-send.ts` e em todo caminho de saída, depois de montar e assinar e **antes** de
  entregar, verificar a própria mensagem com `dkimVerify` do `mailauth` (já é dependência,
  já usada em `verifyInbound`). Falhou a autoverificação: não entrega, registra erro,
  alerta. Uma mensagem que não passa na nossa própria verificação não vai passar na do Gmail.
- Custo: uma verificação de assinatura por mensagem, na ordem de milissegundos. Irrelevante
  frente a 200 mensagens por dia; medir antes de assumir se o volume crescer.
- Teste que monte uma mensagem real pelo caminho de produção e afirme sobre os **bytes**:
  existe `DKIM-Signature`, o `d=` é o domínio do remetente, o `s=` é o selector esperado, e
  a assinatura verifica. Não sobre a variável de configuração.

## Fase 3 — Requisitos de remetente em massa (Gmail e Yahoo, 2024)

Valem para quem manda volume, e a campanha vai mandar.

- **DMARC existe nos 9 domínios, todos em `p=none`.** `none` satisfaz o requisito mínimo e
  não protege nada. Progressão: com os relatórios da fase 1 na mão e alinhamento confirmado,
  subir para `quarantine` e depois `p=reject`. Não subir antes dos relatórios: `reject` com
  alinhamento quebrado derruba o próprio e-mail legítimo.
- **`List-Unsubscribe` e `List-Unsubscribe-Post` de um clique.** `outreach-provider.ts` já
  tem o suporte (RFC 8058). Confirmar que o caminho **nativo** também emite os dois
  cabeçalhos, não só o Outlook/Graph, e travar isso em teste sobre os bytes.
- **Taxa de reclamação abaixo de 0,3%.** Só observável pelo Postmaster Tools da fase 1.
- **Alinhamento de `Return-Path`** com o domínio do `From`, para DMARC passar por SPF além
  de por DKIM. Verificar o que o caminho direto usa como envelope-from.

## Fase 4 — Fazer o mesh medir alguma coisa

Metade do volume do warm-up (as 420 mensagens entre caixas nossas) não mede entregabilidade:
o juiz é o nosso próprio servidor. A outra metade mede, e é a que revelou o problema.

- Reequilibrar o mesh para que a maioria das mensagens vá para caixas em provedores
  externos, que são quem julga de verdade.
- **As caixas que vão enviar campanha não estão sendo aquecidas.** As nove `info@` somam 8
  mensagens em 30 dias e estão no dia 0 de 14; as sementes (`contato@`, `agenda@`) estão no
  dia 14 mandando 57/dia. A decisão de manter `info@` fora do mesh foi deliberada — é caixa
  que gente lê — mas o efeito é que a caixa que vai disparar a campanha nunca enviou nada.
  Decidir explicitamente: ou aquecer `info@` com volume baixo, ou enviar a campanha por uma
  caixa aquecida e aceitar que `info@` fica só para resposta humana.
- Limite diário: as `info@` estão em 50/dia com histórico zero. Para um endereço de dia
  zero, 10 a 15 é o teto sensato, subindo ao longo de duas semanas.

## Fase 5 — Detectar esta classe de falha sozinho

O detector de silêncio já existe e já roda a cada 5 minutos. Regras novas:

- `outbound_dkim_unverified`: qualquer mensagem que falhe a autoverificação da fase 2.
- `warmup_spam_rate_rising`: taxa de spam do mesh acima de um limiar **medido**, não
  chutado. A série de 14 dias acima dá a linha de base: 0,0% por dez dias, com um pico
  isolado de 1,0% em 06/09. Um limiar de 3% teria disparado em 09/09, no mesmo dia.
- `dmarc_report_gap`: nenhum relatório agregado processado em 48h, o que significa que o
  instrumento da fase 1 parou e voltamos a voar cego.

## Ordem

Fase 1 primeiro, e sozinha. Sem ela não dá para saber se a fase 2 consertou alguma coisa nem
se o problema de 09/09 ainda existe. As fases 2 e 3 podem ir em paralelo depois. A 4 é
decisão de operação, não de código. A 5 fecha.

## O que não fazer

Não mandar campanha antes da fase 1. Se o warm-up — conteúdo manso, entre contas conhecidas,
sem link e sem imagem — está caindo 11,4% no Gmail, cold email para desconhecido cai mais. E
sem instrumento, a campanha vira o experimento, com a lista real como custo.

---

## Fase 1 — o que já está feito (2026-09-12)

### `rua` apontando para nós, nos 9 domínios

Cada `_dmarc.<domínio>` ganhou `mailto:dmarc@skale.club` como **primeiro** destino do
`rua`. A política ficou intocada em `p=none` e nenhum destino anterior foi removido — os
três terceiros do `skale.club` (`dmarc.mailgun.org`, `inbox.ondmarc.com`,
`dmarc.brevo.com`) continuam lá.

### O defeito que quase repetiu o padrão: autorização de destino externo

Publicar `rua=mailto:dmarc@skale.club` no `_dmarc` de `xphere.app` **não basta**. A RFC
7489 §7.1 exige que o domínio de destino autorize explicitamente receber relatórios de
outro domínio, publicando

```
<domínio-remetente>._report._dmarc.skale.club   TXT   "v=DMARC1"
```

na zona do destinatário. Sem esse registro, Google, Yahoo e Microsoft **não enviam nada** —
e não avisam. Os oito registros estavam ausentes:

```
xphere.app._report._dmarc.skale.club       AUSENTE
xtimator.com._report._dmarc.skale.club     AUSENTE
xareable.com._report._dmarc.skale.club     AUSENTE
xkedule.com._report._dmarc.skale.club      AUSENTE
stuscle.com._report._dmarc.skale.club      AUSENTE
endenemy.com._report._dmarc.skale.club     AUSENTE
fluenverse.com._report._dmarc.skale.club   AUSENTE
skleanings.com._report._dmarc.skale.club   AUSENTE
```

Os oito foram publicados na zona `skale.club` e resolvem em `8.8.8.8`. `skale.club` não
precisa do seu: o destino é o próprio domínio.

**Este era o mesmo defeito que o plano existe para consertar.** O `rua` afirmaria que os
relatórios vêm para nós; oito dos nove nunca chegariam; e o job da fase 1 leria uma caixa
vazia e reportaria zero — que é um valor válido, e por isso a ausência se disfarçaria de
operação normal. Quem procurasse a causa três semanas depois começaria pela hipótese
errada, como já aconteceu três vezes nesta auditoria. A regra `dmarc_report_gap` da fase 5
teria falado; mas só depois de 48h de cegueira, e só se alguém tivesse publicado o
`_report._dmarc` primeiro.

### Google Postmaster Tools — 12 domínios verificados

Todos os 12 estão `Verified`. Os quatro últimos (`xareable.com`, `xkedule.com`,
`xphere.app`, `xtimator.com`) carregavam o token de **outro** domínio: eu tinha assumido
que o token de verificação era por conta, e ele é **por domínio**. Cada um teve o TXT
errado removido e o próprio publicado antes de verificar.

Primeiro dado real que o instrumento devolveu, em `xphere.app` → Compliance status:

| Requisito | Status |
|---|---|
| SPF and DKIM authentication | Compliant |
| From: header alignment | Compliant |
| DMARC authentication | **Needs work** |
| Encryption | Compliant |
| User-reported spam rate | Compliant |
| DNS records | Compliant |

O `Needs work` do DMARC é leitura velha do painel (`Last updated Jun 13`): os nove domínios
têm `v=DMARC1; p=none` publicado e resolvendo hoje. Vale reconferir quando o painel
atualizar — se continuar vermelho com o registro no ar, aí é achado, não defasagem.

### O que falta na fase 1

- Aplicar `067_dmarc_aggregate_reports.sql` em produção e rodar
  `scripts/seed-dmarc-mailbox.ts` para criar `dmarc@skale.club`. Os relatórios começam a
  chegar ~24h depois da mudança de DNS.
- Assento de captura crua em Gmail/Outlook/Yahoo (item 3 da fase 1), ainda não feito.

# Caça aos erros antes de acelerar a campanha

Lista viva. Regra combinada com o Vanildo em 2026-10-07: rodar devagar, com poucas barbearias, e corrigir cada
problema que aparecer antes de aumentar o volume. Cada linha diz o que aconteceu, o efeito, e o estado.

## Corrigidos

| # | Achado | Efeito se não tivesse sido pego | Correção |
|---|---|---|---|
| 1 | Reserva da conta quebrava com `timestamp <= interval` | **Nenhuma** campanha enviava | `b83f901`, cast `::timestamp` + teste |
| 2 | Registro do envio quebrava (`queryClient.json` com `prepare: false`) | E-mail saía, mas o lead nunca ia para o passo 2; evento não chegava ao Xphere; lembretes da caixa unificada também quebrados | `c5279b0`, `JSON.stringify(...)::jsonb` |
| 3 | Aviso imediato de resposta travava esperando a própria transação | Telegram só avisava na varredura de 5 min | `6544e9d`, aviso depois da transação + teste |
| 4 | `{{city}}` virava "United States" nos endereços novos do Xphere | Frase da visita: "around the corner from United States" | `59bfc62` |
| 5 | Gancho "sem agendamento online" falso para N. Fadez e Neighborhood Barbers (o analisador não viu Squire/Booksy) | Dizer ao dono que o site dele não tem agendamento, quando tem | Dados corrigidos nos 2 leads; **ver aberto #A** |
| 6 | Hermes montou campanha nova com texto próprio ("Hi there", sem link, sem descadastro) | Texto não aprovado; travaria na ativação por falta de descadastro | Live Pilot 02 recebeu a sequência aprovada; **ver aberto #B** |
| 7 | Hermes chamava o Xcraper sem `scrapeType` → Apify sem crédito | Raspagem falhava | Regras do homelab no manual dele (`hermes/xcraper-homelab.md`); **ver aberto #C** |
| 8 | Endereço postal nos e-mails | Decisão do Vanildo: não quer endereço físico | Removido de todas as campanhas (ciente do CAN-SPAM) |

## Abertos

| # | Achado | Risco | Próximo passo |
|---|---|---|---|
| A | Gancho "sem agendamento" depende do analisador do Xphere, que erra em sites Squarespace/Wix | Afirmação falsa ao dono | Conferir o site antes de ligar o gancho, ou deixar o gancho desligado nos leads novos até o analisador melhorar |
| B | Hermes não tinha como ler nem editar o texto de campanha existente (só criar rascunho novo) | Campanhas duplicadas com texto improvisado | Em construção: escopo `campaigns:copy` + ferramentas de leitura, edição e reversão, com aviso de travessão/"Hi there"/endereço |
| C | Xcraper usa `standard` (Apify) quando o `scrapeType` não vem | Cair no Apify sem querer | Trocar o padrão da rota de serviço para `homelab` |
| D | Leitura das caixas fica 30 min de castigo depois de um erro de IMAP (ex.: reinício no deploy) | Resposta demora até 35 min para ser vista | Evitar deploy com campanha rodando; avaliar castigo menor para erro de tempo esgotado |
| E | Follow-ups saem sem `In-Reply-To` | E-mail 2 chega como conversa nova, não "Re:" | Decidir se quer encadear |
| F | Salvar a sequência pela tela do Xmail zera a espera variável (3 a 5 dias) | Follow-ups com espera fixa | Ajustar a tela ou só editar por script/Hermes |
| G | Link de descadastro nunca foi clicado num teste real | Descadastro quebrado = problema legal e de reputação | Clicar no link do e-mail de teste e conferir supressão |
| H | Fila do homelab só anda quando alguém consulta | Busca parada se ninguém acompanhar | Hermes instruído a acompanhar até a última; avaliar um relógio no Xcraper |
| I | Limite diário: 15 por caixa Icemail, 5 caixas = 75/dia | Teto de volume | Subir aos poucos conforme reputação |

## Testes de envio reais

| Data | Campanha | Destino | Resultado |
|---|---|---|---|
| 2026-10-07 | Teste (1 lead) | skale.club@gmail.com | Caixa de entrada; resposta detectada; passo 2 cancelado; Telegram avisou (pela varredura) |
| 2026-10-07 | Live Pilot 02 (3 leads, Newton) | 3 barbearias reais | Pronta, aguardando "vai" |

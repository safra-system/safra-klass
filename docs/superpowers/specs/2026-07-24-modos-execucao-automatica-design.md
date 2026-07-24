# Modos de Execução Automática do Safra Klass

## Objetivo

Separar o processamento automático em dois modos mutuamente exclusivos:

1. **Apenas classificação**: calcula e persiste a classificação dos clientes sem movimentar carteira e sem acessar o Bitrix.
2. **Classificação com movimentação**: preserva o fluxo automático atual, incluindo classificação, regras de carteira, redistribuição, Bitrix e relatórios habilitados.

O sistema terá um único agendamento automático. Nunca haverá dois jobs principais concorrentes nem dois modos ativos simultaneamente.

O modo de execução manual do processamento geral não será implementado nesta versão. Ele fica reservado para uma evolução futura, sem opção de interface, endpoint ou comportamento parcial nesta entrega.

## Estados válidos

O agendamento principal será representado por uma flag `ativo` e um campo enumerado `modo`.

| `ativo` | `modo` | Comportamento efetivo |
|---|---|---|
| `false` | qualquer valor válido | Nenhuma execução do cron principal |
| `true` | `CLASSIFICACAO` | Executa somente classificação |
| `true` | `MOVIMENTACAO` | Executa classificação e o fluxo completo de movimentação |

Valores ausentes ou inválidos serão normalizados no backend. Para compatibilidade, uma configuração antiga com `cron_config.ativo = true` e sem `modo` será interpretada como `MOVIMENTACAO`, preservando o comportamento anteriormente configurado.

## Organização da interface

O bloco de agendamento será organizado desta forma:

```text
Agendamento Automático
├── Ativar execução
├── Modo
│   ├── Apenas classificação
│   └── Classificação com movimentação
├── Data e hora
├── Frequência
└── Filiais
```

Os modos serão apresentados como opções exclusivas. A interface não enviará dois booleanos independentes.

Quando `CLASSIFICACAO` estiver selecionado:

- os parâmetros de movimentação ficarão visualmente desabilitados;
- uma mensagem explicará que os valores continuam salvos, mas não serão usados;
- controles que enviam conteúdo ao Bitrix, incluindo disparo manual de PDF nessa tela, ficarão desabilitados;
- sazonalidade continuará habilitada.

Quando `MOVIMENTACAO` estiver selecionado, todos os parâmetros do fluxo completo voltarão a ficar disponíveis.

## Regras comuns aos dois modos

Os dois modos compartilham:

- filiais selecionadas;
- período usado na consulta de desempenho;
- cálculo de notas e média ponderada;
- determinação da faixa;
- conversão da faixa para `CODREDE`;
- sazonalidade e seus meses inicial e final;
- persistência da classificação no WinThor;
- registro de upgrade para auditoria e proteção de uma movimentação completa futura;
- logs e resumo do lote.

A sazonalidade não terá flag própria. Um downgrade durante o período protegido não será gravado, em nenhum dos modos.

## Modo `CLASSIFICACAO`

O fluxo será:

```text
Consultar desempenho no WinThor
→ calcular classificação
→ aplicar sazonalidade
→ comparar classificação calculada e atual
→ atualizar CATEGORIA e CODREDE quando necessário
→ registrar resultado
→ encerrar
```

### Gravações permitidas

- `PCCLIENT.CATEGORIA`;
- `PCCLIENT.CODREDE`;
- registros de auditoria da classificação e de upgrades no PostgreSQL.

### Efeitos expressamente proibidos

- alterar `PCCLIENT.CODUSUR1`;
- alterar `PCCLIENT.CODATV1`;
- consultar ou gravar qualquer informação no Bitrix;
- alimentar ou remover registros da fila `clientes_rotativos`;
- aplicar decisão de carteira rotativa ou longo prazo;
- enviar clientes para o RCA 118;
- executar a Etapa 5;
- registrar histórico como se uma movimentação tivesse ocorrido;
- gerar ou enviar PDFs de carteira.

`dias_protecao_upgrade` não bloqueará a classificação. O upgrade será registrado para que uma futura execução completa possa respeitar a proteção, mas o parâmetro pertence ao domínio de movimentação.

## Modo `MOVIMENTACAO`

Este modo preservará o fluxo atual:

```text
Classificar
→ aplicar sazonalidade
→ verificar proteção de upgrade
→ verificar negociação ativa no Bitrix
→ decidir grupo de carteira
→ sincronizar fila rotativa
→ movimentar longo prazo quando aplicável
→ executar redistribuição da Etapa 5
→ sincronizar RCA e responsável no Bitrix
→ gerar registros e relatórios habilitados
```

Todos os parâmetros atuais de prazos, RCA, segmentos, fases do Bitrix, mapeamentos e PDF pertencem a este modo.

Se a persistência da classificação falhar para um cliente, o processamento desse cliente será interrompido antes de qualquer movimentação de carteira. Os demais clientes do lote poderão continuar.

## Política de Bitrix

O modo `CLASSIFICACAO` terá política de Bitrix `DENY`: nenhuma leitura ou gravação automática será realizada.

O modo `MOVIMENTACAO` terá política `ALLOW` para as operações já existentes, respeitando as configurações específicas do Bitrix e de PDF.

As operações manuais e deliberadas da tela separada de substituição de carteira não fazem parte do cron principal e permanecem fora deste escopo.

## Correção automática do cadastro WinThor

A correção `PRC_CORRIGIR_PCCLIENT_CAMPOS` continuará como um job técnico independente. Ela não é o classificador: usa o `CODREDE` já existente para corrigir somente `PCCLIENT.CATEGORIA`.

Sua organização será:

```text
Manutenção do Cadastro WinThor
├── Ativar conferência CATEGORIA × CODREDE
├── Intervalo
├── Sincronizar classificação no Bitrix
└── Executar correção agora
```

Regras:

- a correção Oracle poderá executar com o cron principal desligado ou em qualquer modo;
- a descrição da tela será corrigida para não afirmar que o job altera `CODATV1` ou `CODREDE`;
- a sincronização de classificação no Bitrix será uma flag explícita;
- a sincronização Bitrix só será efetiva quando o cron principal estiver ativo em `MOVIMENTACAO`;
- em `CLASSIFICACAO` ou com o cron principal desligado, a correção poderá ajustar o WinThor, mas não escreverá no Bitrix;
- o botão “Executar correção agora” respeitará a mesma política, sem atalhos;
- o intervalo de um minuto continuará disponível, acompanhado de aviso sobre o custo de varrer todos os clientes ativos.

## Persistência e compatibilidade

As novas configurações permanecerão no `extra_config` JSONB de `parametros_sistema`, evitando migração estrutural de banco:

```json
{
  "cron_config": {
    "ativo": false,
    "modo": "CLASSIFICACAO",
    "datetime": "",
    "frequency": "monthly"
  },
  "winthor_fix_config": {
    "ativo": true,
    "intervalo_minutos": 15,
    "sincronizar_bitrix": false
  }
}
```

O backend será a fonte de verdade: normalizará valores legados, validará modos e calculará permissões efetivas. A interface apenas refletirá essa política.

## Arquitetura

Será criado um módulo pequeno de política de execução responsável por:

- enumerar os modos;
- normalizar configurações antigas;
- validar o payload da API;
- informar capacidades efetivas, como `podeMovimentarCarteira`, `podeUsarBitrix` e `podeEnviarPdf`.

O serviço de movimentação receberá uma política explícita. A seleção do modo acontecerá antes do processamento do lote, e não por condicionais dispersas em cada integração.

O fluxo classificatório será isolado do fluxo de efeitos de carteira. Métodos que gravam `CODUSUR1`, chamam Bitrix ou executam a Etapa 5 também terão guardas locais como segunda camada de proteção.

## Concorrência

Existirá somente um job principal. Uma trava em memória impedirá que uma nova ocorrência comece enquanto a anterior ainda estiver executando no mesmo processo Node.

O job independente de correção WinThor poderá continuar agendado, mas sua gravação no Bitrix será calculada pela política efetiva. A atualização Oracle de classificação usará uma única instrução para manter `CATEGORIA` e `CODREDE` consistentes por cliente.

## Tratamento de erros

- configuração inválida será rejeitada pela API com mensagem clara;
- falha de classificação impedirá efeitos posteriores para aquele cliente;
- falha isolada de um cliente não encerrará todo o lote;
- qualquer tentativa proibida pela política será registrada e ignorada antes da integração externa;
- falha no Bitrix após uma movimentação Oracle será registrada como resultado parcial, pois não existe transação distribuída entre Oracle, PostgreSQL e Bitrix;
- logs identificarão modo, início, fim, quantidades e etapas ignoradas.

## Testes

Os testes serão isolados de Oracle, PostgreSQL e Bitrix por dependências simuladas.

Casos mínimos:

1. configuração legada ativa sem modo normaliza para `MOVIMENTACAO`;
2. configuração nova aceita somente `CLASSIFICACAO` ou `MOVIMENTACAO`;
3. `CLASSIFICACAO` atualiza apenas `CATEGORIA` e `CODREDE`;
4. `CLASSIFICACAO` preserva `CODATV1` e `CODUSUR1`;
5. sazonalidade bloqueia downgrade nos dois modos;
6. `CLASSIFICACAO` não consulta nem grava no Bitrix;
7. `CLASSIFICACAO` não sincroniza fila nem executa Etapa 5;
8. `MOVIMENTACAO` preserva o fluxo completo atual;
9. falha ao persistir classificação impede movimentação do cliente;
10. correção WinThor não grava Bitrix em `CLASSIFICACAO`;
11. correção WinThor só grava Bitrix quando a política efetiva permite;
12. API e interface preservam parâmetros desabilitados ao alternar o modo;
13. trava de execução impede sobreposição do cron principal.

## Fora do escopo

- criar um terceiro modo de execução manual do processamento geral;
- criar botões ou endpoints para disparar manualmente os modos `CLASSIFICACAO` ou `MOVIMENTACAO`;
- transformar as operações manuais de substituição em uma trava global;
- criar transação distribuída entre Oracle, PostgreSQL e Bitrix;
- alterar fórmulas de pontuação ou faixas;
- alterar a regra de sazonalidade;
- criar novos relatórios de classificação;
- alterar a periodicidade escolhida pelo usuário.

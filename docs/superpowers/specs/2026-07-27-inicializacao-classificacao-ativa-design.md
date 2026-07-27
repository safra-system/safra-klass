# Inicialização Única em Apenas Classificação

## Objetivo

Na primeira inicialização desta versão, o agendamento principal deve ser
gravado como ativo no modo `CLASSIFICACAO`. A atualização deve preservar
data, frequência, filiais e todos os demais parâmetros já configurados.

Depois dessa inicialização, qualquer escolha salva pelo usuário passa a ser
definitiva: desligar o agendamento ou selecionar `MOVIMENTACAO` não pode ser
desfeito em reinicializações futuras.

## Abordagem escolhida

A inicialização será feita no backend e registrada no JSONB `extra_config`:

```json
{
  "_system_migrations": {
    "cron_classificacao_ativa_v1": true
  }
}
```

Uma atualização PostgreSQL atômica verificará a ausência do marcador e, na
mesma instrução:

- definirá `cron_config.ativo = true`;
- definirá `cron_config.modo = "CLASSIFICACAO"`;
- preservará `datetime`, `frequency` e as demais propriedades existentes;
- gravará o marcador versionado.

O salvamento normal dos parâmetros preservará `_system_migrations`, mesmo
que a interface não envie essa chave interna.

## Fluxo

1. O backend solicita os parâmetros antes de configurar o CRON.
2. O repositório tenta aplicar a inicialização versionada.
3. Sem marcador, a atualização é aplicada uma vez.
4. Com marcador, nenhuma configuração do usuário é alterada.
5. O agendador lê a configuração já inicializada.
6. Salvamentos posteriores mantêm o marcador e respeitam o usuário.

Para uma base ainda sem registro de parâmetros, a interface e o payload
inicial usarão `ativo: true` e `modo: "CLASSIFICACAO"`. O primeiro salvamento
também gravará o marcador.

## Segurança e falhas

- A inicialização não inventará data ou horário.
- Sem `datetime`, o controle aparecerá ativo, mas nenhum job será agendado.
- Se a inicialização falhar, o backend não deve iniciar o CRON principal com
  a configuração antiga; o erro será registrado para impedir movimentação
  involuntária.
- Processos concorrentes podem tentar aplicar a atualização, mas a condição
  atômica permite que somente o primeiro altere a configuração.
- A correção técnica independente do WinThor permanece fora desta mudança.

## Interface e preview

O fallback da interface e a fixture do preview iniciarão com:

```json
{
  "ativo": true,
  "modo": "CLASSIFICACAO",
  "datetime": "",
  "frequency": "monthly"
}
```

Após carregar dados reais, a tela continuará refletindo exclusivamente o
valor persistido.

## Testes

- configuração sem marcador é inicializada como ativa e classificatória;
- data, frequência, filiais e demais parâmetros são preservados;
- configuração marcada não é alterada;
- escolha posterior do usuário permanece após nova leitura;
- salvamento preserva o marcador interno;
- falha na inicialização impede o agendamento principal;
- fallback e preview exibem ativo + `CLASSIFICACAO`.

## Fora do escopo

- criar um modo manual;
- escolher automaticamente data ou horário;
- alterar parâmetros de movimentação, sazonalidade ou correção WinThor;
- executar a classificação imediatamente ao abrir a página.

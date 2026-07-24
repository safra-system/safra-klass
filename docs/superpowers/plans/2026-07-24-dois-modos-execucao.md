# Dois Modos de Execução Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar dois modos automáticos exclusivos: classificação sem efeitos de carteira/Bitrix e classificação com o fluxo completo atual de movimentação.

**Architecture:** Uma política central transforma `cron_config` em capacidades explícitas. O classificador sempre roda antes dos efeitos de carteira; o serviço encerra cedo no modo `CLASSIFICACAO` e conserva o fluxo existente no modo `MOVIMENTACAO`.

**Tech Stack:** Node.js 24, CommonJS, `node:test`, Express, node-cron, OracleDB e PostgreSQL.

## Global Constraints

- Não criar modo ou endpoint de execução manual nesta versão.
- `CLASSIFICACAO` só pode alterar `PCCLIENT.CATEGORIA` e `PCCLIENT.CODREDE`.
- `CLASSIFICACAO` não pode consultar nem gravar Bitrix, alterar RCA, usar fila, executar Etapa 5 ou enviar PDF.
- `MOVIMENTACAO` deve preservar as leituras e gravações Bitrix já existentes.
- Sazonalidade vale nos dois modos e não recebe flag própria.
- Configuração legada ativa sem `modo` equivale a `MOVIMENTACAO`.
- Testes nunca devem acessar Oracle, PostgreSQL ou Bitrix reais.

---

### Task 1: Política central e infraestrutura segura de testes

**Files:**
- Create: `execution-policy.js`
- Create: `tests/unit/execution-policy.test.js`
- Create: `tests/unit/all.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `EXECUTION_MODES`, `normalizeCronConfig(raw)` e `createExecutionPolicy(raw)`.
- `createExecutionPolicy()` retorna `enabled`, `mode`, `canClassify`, `canMoveWallet`, `canReadBitrix`, `canWriteBitrix`, `canUseQueue`, `canRunStage5` e `canSendPdf`.

- [ ] **Step 1: Escrever testes que exijam os dois modos e a compatibilidade legada**

```js
test('configuração ativa legada preserva movimentação', () => {
  assert.equal(normalizeCronConfig({ ativo: true }).modo, EXECUTION_MODES.MOVIMENTACAO);
});

test('classificação nega todos os efeitos de movimentação', () => {
  const policy = createExecutionPolicy({ ativo: true, modo: EXECUTION_MODES.CLASSIFICACAO });
  assert.equal(policy.canClassify, true);
  assert.equal(policy.canMoveWallet, false);
  assert.equal(policy.canReadBitrix, false);
  assert.equal(policy.canWriteBitrix, false);
  assert.equal(policy.canRunStage5, false);
});

test('movimentação preserva o fluxo completo', () => {
  const policy = createExecutionPolicy({ ativo: true, modo: EXECUTION_MODES.MOVIMENTACAO });
  assert.equal(policy.canMoveWallet, true);
  assert.equal(policy.canReadBitrix, true);
  assert.equal(policy.canWriteBitrix, true);
  assert.equal(policy.canRunStage5, true);
});
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test tests/unit/execution-policy.test.js`

Expected: FAIL com `Cannot find module '../../execution-policy'`.

- [ ] **Step 3: Implementar a política mínima e configurar somente testes isolados**

```js
const EXECUTION_MODES = Object.freeze({
  CLASSIFICACAO: 'CLASSIFICACAO',
  MOVIMENTACAO: 'MOVIMENTACAO'
});

function normalizeCronConfig(raw = {}) {
  const ativo = raw?.ativo === true;
  const valid = Object.values(EXECUTION_MODES).includes(raw?.modo);
  const modo = valid ? raw.modo : (ativo ? EXECUTION_MODES.MOVIMENTACAO : EXECUTION_MODES.CLASSIFICACAO);
  return { ...raw, ativo, modo };
}
```

`tests/unit/all.test.js` importa explicitamente cada arquivo unitário aprovado. Set `package.json` script to `node --test tests/unit/all.test.js`, evitando que os scripts legados da raiz sejam descobertos.

- [ ] **Step 4: Confirmar GREEN**

Run: `npm.cmd test`

Expected: todos os testes em `tests/unit` passam e nenhum script legado é executado.

### Task 2: Persistência normalizada da configuração

**Files:**
- Modify: `rotativo-repository.js:1128-1263`
- Create: `tests/unit/rotativo-repository-config.test.js`

**Interfaces:**
- Consumes: `normalizeCronConfig(raw)`.
- Produces: `obterParametrosSistema().cron_config` sempre normalizado e `extra_config.cron_config.modo` persistido.

- [ ] **Step 1: Escrever testes com pool PostgreSQL falso**

```js
test('leitura normaliza configuração ativa sem modo para MOVIMENTACAO', async () => {
  const repo = createRepositoryWithRows([{ extra_config: { cron_config: { ativo: true } } }]);
  const params = await repo.obterParametrosSistema();
  assert.equal(params.cron_config.modo, 'MOVIMENTACAO');
});

test('salvamento preserva os parâmetros desabilitados e grava o modo', async () => {
  const { repo, capturedQueries } = createCapturingRepository();
  await repo.salvarParametrosSistema(fullPayload({ modo: 'CLASSIFICACAO' }));
  const extra = JSON.parse(capturedQueries.at(-1).params[8]);
  assert.equal(extra.cron_config.modo, 'CLASSIFICACAO');
  assert.deepEqual(extra.rcas_rotativa, [10, 110]);
});
```

- [ ] **Step 2: Confirmar RED**

Run: `node --test tests/unit/rotativo-repository-config.test.js`

Expected: FAIL porque o repositório ainda devolve/persiste `cron_config` sem normalização.

- [ ] **Step 3: Injetar pool em testes e aplicar a normalização na leitura e escrita**

```js
constructor(logger, options = {}) {
  this.logger = logger || console;
  this.pool = options.pool || new Pool({ connectionString: requiredConnectionString() });
}
```

Usar `normalizeCronConfig(extra.cron_config)` em `obterParametrosSistema()` e `normalizeCronConfig(params.cron_config)` em `salvarParametrosSistema()`.

- [ ] **Step 4: Confirmar GREEN**

Run: `npm.cmd test`

Expected: política e persistência passam sem conexão externa.

### Task 3: Separar classificação dos efeitos de carteira

**Files:**
- Modify: `movimentacao-carteira-service.js:34-1089`
- Create: `tests/unit/movimentacao-carteira-service.test.js`

**Interfaces:**
- Consumes: `policy` produzida por `createExecutionPolicy()`.
- Produces: `processarCliente({ ..., policy })` e `processarTodosClientesElegiveis({ ..., policy })`.
- `_atualizarClassificacao(codcli, codRede, categoria)` grava somente `CODREDE` e `CATEGORIA`.

- [ ] **Step 1: Escrever testes do modo `CLASSIFICACAO`**

```js
test('classificação persiste somente categoria e rede e encerra', async () => {
  const { service, calls } = createServiceHarness();
  const result = await service.processarCliente(classificationInput());
  assert.deepEqual(calls.classificationUpdate, [{ codcli: 1, codRede: 13, categoria: 'OURO' }]);
  assert.equal(calls.bitrix.length, 0);
  assert.equal(calls.wallet.length, 0);
  assert.equal(calls.queue.length, 0);
  assert.equal(result.modoExecucao, 'CLASSIFICACAO');
});

test('falha ao persistir classificação impede efeitos posteriores', async () => {
  const { service, calls } = createServiceHarness({ classificationError: new Error('oracle') });
  await assert.rejects(service.processarCliente(classificationInput()), /oracle/);
  assert.equal(calls.wallet.length, 0);
  assert.equal(calls.bitrix.length, 0);
});
```

- [ ] **Step 2: Confirmar RED**

Run: `node --test tests/unit/movimentacao-carteira-service.test.js`

Expected: FAIL porque `processarCliente` ainda não recebe política e continua executando efeitos.

- [ ] **Step 3: Injetar dependências e isolar a etapa classificatória**

```js
constructor(logger, dependencies = {}) {
  this.logger = logger || console;
  this.performance = dependencies.performance || new PerformanceClientes();
  this.rotativoRepo = dependencies.rotativoRepo || new RotativoRepository(this.logger);
  this.clienteRepo = dependencies.clienteRepo || new ClienteRepository();
  this.bitrixService = dependencies.bitrixService || new BitrixService(this.logger);
  this.rcaRepo = dependencies.rcaRepo || new RcaRepository(this.logger);
}
```

Separar avaliação, sazonalidade, persistência e registro de upgrade. A proteção de upgrade, decisões de carteira e Bitrix só são consultados após `if (!policy.canMoveWallet) return resultadoClassificacao`.

- [ ] **Step 4: Escrever e confirmar testes do modo `MOVIMENTACAO`**

```js
test('movimentação conserva proteção, fila, RCA e Bitrix', async () => {
  const { service, calls } = createServiceHarness({ mode: 'MOVIMENTACAO', diasSemCompra: 100 });
  await service.processarCliente(movementInput());
  assert.equal(calls.protection.length, 1);
  assert.equal(calls.queue.length, 1);
  assert.equal(calls.wallet.length, 1);
  assert.equal(calls.bitrixWrites.length, 1);
});
```

Run first: `node --test tests/unit/movimentacao-carteira-service.test.js`

Expected RED: fluxo ainda não está condicionado pela política.

Run after implementation: `npm.cmd test`

Expected GREEN: ambos os modos passam.

### Task 4: Lote, trava de sobreposição e agendador

**Files:**
- Create: `automatic-execution-runner.js`
- Create: `tests/unit/automatic-execution-runner.test.js`
- Modify: `server.js:3305-3501`

**Interfaces:**
- Produces: `createAutomaticExecutionRunner(dependencies).run()` e `.isRunning()`.
- Consumes: parâmetros atuais, política, período, serviço de clientes e serviço de relatório.

- [ ] **Step 1: Testar despacho, PDF e sobreposição**

```js
test('classificação passa policy segura e não gera PDF', async () => {
  const harness = createRunnerHarness({ modo: 'CLASSIFICACAO' });
  await harness.runner.run();
  assert.equal(harness.calls.process[0].policy.mode, 'CLASSIFICACAO');
  assert.equal(harness.calls.pdf.length, 0);
});

test('segunda ocorrência é ignorada enquanto a primeira executa', async () => {
  const harness = createBlockingRunnerHarness();
  const first = harness.runner.run();
  const second = await harness.runner.run();
  assert.deepEqual(second, { skipped: true, reason: 'EXECUTION_IN_PROGRESS' });
  harness.release();
  await first;
});
```

- [ ] **Step 2: Confirmar RED**

Run: `node --test tests/unit/automatic-execution-runner.test.js`

Expected: FAIL porque o runner ainda não existe.

- [ ] **Step 3: Implementar o runner e fazer o CRON apenas dispará-lo**

```js
async function run() {
  if (running) return { skipped: true, reason: 'EXECUTION_IN_PROGRESS' };
  running = true;
  try {
    const params = await paramsRepository.obterParametrosSistema();
    const policy = createExecutionPolicy(params.cron_config);
    if (!policy.enabled) return { skipped: true, reason: 'DISABLED' };
    return await processBatch({ params, policy });
  } finally {
    running = false;
  }
}
```

O `server.js` continua calculando a expressão CRON, mas delega o corpo da tarefa ao runner singleton.

- [ ] **Step 4: Confirmar GREEN**

Run: `npm.cmd test`

Expected: modos, PDF e trava passam.

### Task 5: Interface dos dois modos e defesa no backend

**Files:**
- Modify: `public/config-parametros.html:98-337`
- Modify: `public/js/config-parametros.js:1-814`
- Modify: `public/css/config-parametros.css`
- Create: `tests/unit/config-execution-mode-contract.test.js`
- Modify: `server.js:3130-3167`

**Interfaces:**
- Produces: radios exclusivos `cron_modo` com valores `CLASSIFICACAO` e `MOVIMENTACAO`.
- Blocos de movimento usam `data-movement-only`; sazonalidade e filiais não usam esse atributo.

- [ ] **Step 1: Escrever contrato estático da interface**

```js
test('interface expõe somente os dois modos aprovados', () => {
  assert.match(html, /value="CLASSIFICACAO"/);
  assert.match(html, /value="MOVIMENTACAO"/);
  assert.doesNotMatch(html, /value="MANUAL"/);
});

test('payload envia um único campo modo', () => {
  assert.match(script, /modo:\s*getSelectedExecutionMode\(\)/);
});
```

- [ ] **Step 2: Confirmar RED**

Run: `node --test tests/unit/config-execution-mode-contract.test.js`

Expected: FAIL porque os controles e `cron_config.modo` ainda não existem.

- [ ] **Step 3: Implementar radios, preservação de valores e bloqueio visual**

```js
function getSelectedExecutionMode() {
  return document.querySelector('input[name="cron_modo"]:checked')?.value || 'CLASSIFICACAO';
}

function updateExecutionModeUi() {
  const classificationOnly = getSelectedExecutionMode() === 'CLASSIFICACAO';
  document.querySelectorAll('[data-movement-only]').forEach((block) => {
    block.classList.toggle('execution-section-disabled', classificationOnly);
    block.setAttribute('aria-disabled', String(classificationOnly));
  });
}
```

O JavaScript lê os valores diretamente ao salvar, mesmo quando os controles estão visualmente indisponíveis, para não apagar parâmetros existentes.

- [ ] **Step 4: Validar no backend e confirmar GREEN**

`POST /api/parametros` normaliza `cron_config` antes de salvar; um payload não pode ativar dois comportamentos porque existe somente um enum.

Run: `npm.cmd test`

Expected: contratos de UI e backend passam.

### Task 6: Correção WinThor, Bitrix e regressão final

**Files:**
- Modify: `winthor-cadastro-correcao-service.js:670-896`
- Modify: `server.js:3154-3425`
- Modify: `public/config-parametros.html:249-298`
- Modify: `public/js/config-parametros.js:541-691`
- Create: `tests/unit/winthor-correction-policy.test.js`

**Interfaces:**
- `executarCorrecao({ forceRecreateProcedure, sincronizarBitrix })`.
- A sincronização da correção só recebe `true` quando cron ativo, modo `MOVIMENTACAO` e a flag específica estiver ativa.

- [ ] **Step 1: Testar a política da correção**

```js
test('correção não sincroniza Bitrix em CLASSIFICACAO', async () => {
  const harness = createCorrectionHarness({ modo: 'CLASSIFICACAO', sincronizar_bitrix: true });
  await harness.run();
  assert.equal(harness.calls[0].sincronizarBitrix, false);
});

test('correção pode sincronizar Bitrix no modo completo', async () => {
  const harness = createCorrectionHarness({ modo: 'MOVIMENTACAO', sincronizar_bitrix: true });
  await harness.run();
  assert.equal(harness.calls[0].sincronizarBitrix, true);
});
```

- [ ] **Step 2: Confirmar RED, implementar a flag e confirmar GREEN**

Run RED: `node --test tests/unit/winthor-correction-policy.test.js`

Expected: FAIL porque a correção sincroniza Bitrix sempre que o serviço existe.

Run GREEN: `npm.cmd test`

Expected: todos os testes unitários passam sem acesso externo.

- [ ] **Step 3: Fazer verificação completa e revisão de efeitos**

Run:

```powershell
npm.cmd test
Get-ChildItem -Recurse -Filter *.js |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  ForEach-Object { node --check $_.FullName }
npm.cmd ls --depth=0
git diff --check
```

Expected: testes sem falhas, todos os JavaScripts válidos, dependências resolvidas e diff sem erros de whitespace.

- [ ] **Step 4: Commitar em unidades revisáveis**

```powershell
git add execution-policy.js automatic-execution-runner.js tests package.json package-lock.json
git commit -m "Add automatic execution policy"
git add movimentacao-carteira-service.js rotativo-repository.js server.js winthor-cadastro-correcao-service.js
git commit -m "Separate classification from wallet movement"
git add public/config-parametros.html public/js/config-parametros.js public/css/config-parametros.css
git commit -m "Add automatic execution mode controls"
```

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createAutomaticExecutionRunner } = require('../../automatic-execution-runner');

function createHarness(options = {}) {
  const calls = {
    params: 0,
    movementFactories: 0,
    reportFactories: 0,
    calculatePeriod: 0,
    process: [],
    pdf: [],
    delays: []
  };

  const configs = options.configs || [{
    cron_config: { ativo: true, modo: options.mode || 'CLASSIFICACAO' },
    filiais_cron: options.filiais || [1, 3, 5, 6],
    rcas_rotativa: options.rcas || [10, 110],
    pdf_config: options.pdfConfig || { ativo: false, modo_teste: false, id_tester: 0 }
  }];

  let configIndex = 0;
  const paramsRepository = {
    async obterParametrosSistema() {
      calls.params += 1;
      const index = Math.min(configIndex, configs.length - 1);
      configIndex += 1;
      return configs[index];
    }
  };

  const processImpl = options.processImpl || (async () => ({ total: 2 }));
  const createMovementService = () => {
    calls.movementFactories += 1;
    return {
      async processarTodosClientesElegiveis(input) {
        calls.process.push(input);
        return processImpl(input);
      }
    };
  };

  const createReportService = () => {
    calls.reportFactories += 1;
    return {
      async processarRelatorioVendedor(rca, targetId) {
        calls.pdf.push({ rca, targetId });
      }
    };
  };

  const runner = createAutomaticExecutionRunner({
    paramsRepository,
    createMovementService,
    createReportService,
    calculatePeriod() {
      calls.calculatePeriod += 1;
      return {
        DataIni: '01/01/2025',
        DataFim: '31/12/2025',
        competencia: '2025-12'
      };
    },
    async delay(milliseconds) {
      calls.delays.push(milliseconds);
    },
    logger: {
      log() {},
      error() {}
    }
  });

  return { runner, calls };
}

test('CLASSIFICACAO passa policy segura ao lote e nunca cria relatório', async () => {
  const { runner, calls } = createHarness({
    mode: 'CLASSIFICACAO',
    pdfConfig: { ativo: true, modo_teste: true, id_tester: 999 }
  });

  const result = await runner.run();

  assert.equal(result.skipped, false);
  assert.equal(result.mode, 'CLASSIFICACAO');
  assert.equal(calls.process.length, 1);
  assert.equal(calls.process[0].policy.mode, 'CLASSIFICACAO');
  assert.equal(calls.process[0].skipBitrixEtapa5, true);
  assert.equal(calls.reportFactories, 0);
  assert.deepEqual(calls.pdf, []);
});

test('MOVIMENTACAO preserva Bitrix da Etapa 5 e envia PDFs habilitados', async () => {
  const { runner, calls } = createHarness({
    mode: 'MOVIMENTACAO',
    rcas: [121, 122],
    pdfConfig: { ativo: true, modo_teste: true, id_tester: 456 }
  });

  const result = await runner.run();

  assert.equal(result.mode, 'MOVIMENTACAO');
  assert.equal(calls.process[0].policy.canWriteBitrix, true);
  assert.equal(calls.process[0].skipBitrixEtapa5, false);
  assert.equal(calls.reportFactories, 1);
  assert.deepEqual(calls.pdf, [
    { rca: 121, targetId: 456 },
    { rca: 122, targetId: 456 }
  ]);
  assert.deepEqual(calls.delays, [2000, 2000]);
});

test('MOVIMENTACAO sem PDF ativo não cria serviço de relatório', async () => {
  const { runner, calls } = createHarness({
    mode: 'MOVIMENTACAO',
    pdfConfig: { ativo: false, modo_teste: false, id_tester: 0 }
  });

  await runner.run();

  assert.equal(calls.reportFactories, 0);
  assert.deepEqual(calls.pdf, []);
});

test('configuração legada ativa sem modo executa MOVIMENTACAO', async () => {
  const { runner, calls } = createHarness({
    configs: [{
      cron_config: { ativo: true },
      filiais_cron: [5],
      pdf_config: { ativo: false }
    }]
  });

  const result = await runner.run();

  assert.equal(result.mode, 'MOVIMENTACAO');
  assert.equal(calls.process[0].policy.mode, 'MOVIMENTACAO');
  assert.equal(calls.process[0].skipBitrixEtapa5, false);
});

test('configuração inativa encerra antes de calcular período ou criar serviços', async () => {
  const { runner, calls } = createHarness({
    configs: [{ cron_config: { ativo: false, modo: 'MOVIMENTACAO' } }]
  });

  const result = await runner.run();

  assert.deepEqual(result, { skipped: true, reason: 'DISABLED' });
  assert.equal(calls.calculatePeriod, 0);
  assert.equal(calls.movementFactories, 0);
  assert.equal(calls.reportFactories, 0);
});

test('segunda ocorrência é ignorada enquanto a primeira executa', async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const { runner } = createHarness({
    processImpl: async () => blocked
  });

  const first = runner.run();
  assert.equal(runner.isRunning(), true);
  const second = await runner.run();

  assert.deepEqual(second, { skipped: true, reason: 'EXECUTION_IN_PROGRESS' });
  release({ total: 1 });
  await first;
  assert.equal(runner.isRunning(), false);
});

test('erro libera a trava para a próxima execução', async () => {
  let attempts = 0;
  const { runner } = createHarness({
    processImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('falha do lote');
      return { total: 1 };
    }
  });

  await assert.rejects(runner.run(), /falha do lote/);
  assert.equal(runner.isRunning(), false);

  const next = await runner.run();
  assert.equal(next.skipped, false);
  assert.equal(attempts, 2);
});

test('cada execução relê a configuração e aplica a policy atual', async () => {
  const { runner, calls } = createHarness({
    configs: [
      {
        cron_config: { ativo: true, modo: 'CLASSIFICACAO' },
        filiais_cron: [1],
        pdf_config: { ativo: false }
      },
      {
        cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
        filiais_cron: [6],
        pdf_config: { ativo: false }
      }
    ]
  });

  await runner.run();
  await runner.run();

  assert.equal(calls.params, 2);
  assert.deepEqual(calls.process.map((call) => call.policy.mode), [
    'CLASSIFICACAO',
    'MOVIMENTACAO'
  ]);
  assert.deepEqual(calls.process.map((call) => call.CodFilial), [[1], [6]]);
});

test('CRON principal do servidor delega a execução ao runner singleton', () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'server.js'),
    'utf8'
  );
  const taskStart = serverSource.indexOf('const tarefa = async () =>');
  const scheduleStart = serverSource.indexOf(
    'cronJobAtual = cron.schedule',
    taskStart
  );
  const taskSource = serverSource.slice(taskStart, scheduleStart);

  assert.match(serverSource, /createAutomaticExecutionRunner/);
  assert.match(serverSource, /const automaticExecutionRunner\s*=/);
  assert.match(taskSource, /await automaticExecutionRunner\.run\(\)/);
  assert.doesNotMatch(taskSource, /new MovimentacaoCarteiraService/);
  assert.doesNotMatch(taskSource, /new RelatorioService/);
  assert.doesNotMatch(taskSource, /skipBitrixEtapa5:\s*true/);
});

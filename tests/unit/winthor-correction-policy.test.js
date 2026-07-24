const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeWinthorFixConfig,
  createWinthorCorrectionPolicy
} = require('../../execution-policy');
const { createWinthorCorrectionRunner } = require('../../winthor-correction-runner');
const WinthorCadastroCorrecaoService = require('../../winthor-cadastro-correcao-service');

const silentLogger = { log() {}, error() {} };

test('normaliza configuração WinThor legada de forma conservadora', () => {
  assert.deepEqual(normalizeWinthorFixConfig(), {
    ativo: true,
    intervalo_minutos: 15,
    sincronizar_bitrix: false
  });
  assert.equal(normalizeWinthorFixConfig({ intervalo_minutos: 1 }).intervalo_minutos, 1);
  assert.equal(normalizeWinthorFixConfig({ intervalo_minutos: 30 }).intervalo_minutos, 30);
  assert.equal(normalizeWinthorFixConfig({ intervalo_minutos: 2 }).intervalo_minutos, 15);
  assert.equal(normalizeWinthorFixConfig({ ativo: false }).ativo, false);
  assert.equal(normalizeWinthorFixConfig({ sincronizar_bitrix: 'true' }).sincronizar_bitrix, false);
});

test('matriz da policy só permite Bitrix no modo completo com flag explícita', () => {
  const policy = (cron_config, winthor_fix_config) => createWinthorCorrectionPolicy({
    cron_config,
    winthor_fix_config
  });
  assert.equal(policy({ ativo: false, modo: 'MOVIMENTACAO' }, { sincronizar_bitrix: true }).canSyncBitrix, false);
  assert.equal(policy({ ativo: true, modo: 'CLASSIFICACAO' }, { sincronizar_bitrix: true }).canSyncBitrix, false);
  assert.equal(policy({ ativo: true, modo: 'MOVIMENTACAO' }, { sincronizar_bitrix: false }).canSyncBitrix, false);
  assert.equal(policy({ ativo: true, modo: 'MOVIMENTACAO' }, { sincronizar_bitrix: true }).canSyncBitrix, true);
  assert.equal(policy({ ativo: true }, { sincronizar_bitrix: true }).canSyncBitrix, true);
  assert.equal(policy({ ativo: true }, {}).canSyncBitrix, false);
});

function createRunnerHarness(configs, serviceOverrides = {}) {
  const calls = { reads: 0, corrections: [], rollbacks: [] };
  const queue = [...configs];
  const correctionService = {
    async executarCorrecao(options) {
      calls.corrections.push(options);
      return { ambiente: 'TESTE', totalLidos: 1, totalCorrigidos: 1 };
    },
    async executarRollbackLegado(options) {
      calls.rollbacks.push(options);
      return { ambiente: 'TESTE', logsLegadosEncontrados: 1, correcaoPosRollback: null };
    },
    ...serviceOverrides
  };
  const paramsRepository = {
    async obterParametrosSistema() {
      calls.reads += 1;
      return queue.length > 1 ? queue.shift() : queue[0];
    }
  };
  return {
    calls,
    runner: createWinthorCorrectionRunner({ paramsRepository, correctionService, logger: silentLogger })
  };
}

test('runner relê config e manual corrige Oracle mesmo com agenda técnica desligada', async () => {
  const harness = createRunnerHarness([{
    cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
    winthor_fix_config: { ativo: false, sincronizar_bitrix: true }
  }]);
  await harness.runner.runCorrection({ source: 'MANUAL' });
  assert.equal(harness.calls.reads, 1);
  assert.deepEqual(harness.calls.corrections, [{
    forceRecreateProcedure: false,
    sincronizarBitrix: true
  }]);
});

test('runner ignora correção automática quando agenda técnica está desligada', async () => {
  const harness = createRunnerHarness([{
    cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
    winthor_fix_config: { ativo: false, sincronizar_bitrix: true }
  }]);
  const result = await harness.runner.runCorrection({ source: 'CRON' });
  assert.deepEqual(result, { skipped: true, reason: 'DISABLED' });
  assert.equal(harness.calls.corrections.length, 0);
});

test('runner não trata origem desconhecida como atalho manual', async () => {
  const harness = createRunnerHarness([{
    cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
    winthor_fix_config: { ativo: false, sincronizar_bitrix: true }
  }]);
  const result = await harness.runner.runCorrection({ source: 'OUTRA' });
  assert.deepEqual(result, { skipped: true, reason: 'DISABLED' });
  assert.equal(harness.calls.corrections.length, 0);
});

test('uma trava cobre correção e rollback e é liberada depois de erro', async () => {
  let rejectFirst;
  const pending = new Promise((_resolve, reject) => { rejectFirst = reject; });
  const harness = createRunnerHarness([{
    cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
    winthor_fix_config: { ativo: true, sincronizar_bitrix: false }
  }], {
    async executarCorrecao(options) {
      harness.calls.corrections.push(options);
      return pending;
    }
  });
  const first = harness.runner.runCorrection({ source: 'CRON' });
  assert.equal(harness.runner.isRunning(), true);
  assert.deepEqual(await harness.runner.runRollback({ source: 'MANUAL' }), {
    skipped: true,
    reason: 'EXECUTION_IN_PROGRESS'
  });
  rejectFirst(new Error('falha esperada'));
  await assert.rejects(first, /falha esperada/);
  assert.equal(harness.runner.isRunning(), false);
});

test('rollback em andamento bloqueia correção e também libera a trava em erro', async () => {
  let rejectRollback;
  const pending = new Promise((_resolve, reject) => { rejectRollback = reject; });
  const harness = createRunnerHarness([{
    cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
    winthor_fix_config: { ativo: true, sincronizar_bitrix: false }
  }], {
    async executarRollbackLegado(options) {
      harness.calls.rollbacks.push(options);
      return pending;
    }
  });
  const first = harness.runner.runRollback({ source: 'MANUAL' });
  assert.deepEqual(await harness.runner.runCorrection({ source: 'MANUAL' }), {
    skipped: true,
    reason: 'EXECUTION_IN_PROGRESS'
  });
  rejectRollback(new Error('rollback falhou'));
  await assert.rejects(first, /rollback falhou/);
  assert.equal(harness.runner.isRunning(), false);
});

test('rollback força serviço puro e pós-correção recalcula policy dentro da trava', async () => {
  const harness = createRunnerHarness([
    {
      cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
      winthor_fix_config: { ativo: true, sincronizar_bitrix: false }
    },
    {
      cron_config: { ativo: true, modo: 'MOVIMENTACAO' },
      winthor_fix_config: { ativo: true, sincronizar_bitrix: true }
    }
  ]);
  const result = await harness.runner.runRollback({
    source: 'MANUAL',
    executarCorrecaoPosRollback: true,
    limit: 10
  });
  assert.equal(harness.calls.reads, 2);
  assert.equal(harness.calls.rollbacks[0].executarCorrecaoPosRollback, false);
  assert.equal(harness.calls.rollbacks[0].limit, 10);
  assert.equal(harness.calls.corrections[0].sincronizarBitrix, true);
  assert.equal(result.correcaoPosRollback.totalCorrigidos, 1);
});

function createCorrectionServiceHarness({ sincronizarBitrix, recoverOnce = false } = {}) {
  const calls = [];
  let poolAttempt = 0;
  const bitrixService = {
    async buscarContatosPorCampo() {
      calls.push('bitrix-read');
      return [];
    },
    async atualizarContatoCampos() {
      calls.push('bitrix-write');
      return true;
    }
  };
  const service = new WinthorCadastroCorrecaoService({ logger: silentLogger, bitrixService });
  service.garantirProcedure = async ({ force } = {}) => { calls.push('procedure:' + Boolean(force)); };
  service._garantirTabelaLogPostgres = async () => { calls.push('infra'); };
  service._registrarLogsCorrecao = async () => { calls.push('logs'); return 1; };
  service._atualizarPayloadBitrixLog = async () => {};
  service._isProcedureRecoverableError = (error) => error?.message === 'recoverable';
  service._getPool = async () => ({
    async getConnection() {
      poolAttempt += 1;
      const attempt = poolAttempt;
      let executeCount = 0;
      return {
        async execute() {
          executeCount += 1;
          if (recoverOnce && attempt === 1 && executeCount === 1) throw new Error('recoverable');
          if (executeCount === 1) {
            calls.push('oracle-read');
            return { rows: [{
              CODCLI: 1,
              CATEGORIA_ATUAL: 'PRATA',
              CATEGORIA_CORRIGIDA: 'OURO',
              CODATV1_ATUAL: 1,
              CODATV1_CORRIGIDO: 1,
              CODREDE_ATUAL: 11,
              CODREDE_CORRIGIDO: 11
            }] };
          }
          calls.push('oracle-update');
          return { outBinds: { p_total_lidos: 1, p_total_corrigidos: 1 } };
        },
        async close() { calls.push('close'); }
      };
    }
  });
  return { calls, service, run: () => service.executarCorrecao({ sincronizarBitrix }) };
}

test('serviço não toca Bitrix quando sync é falso e informa bloqueio', async () => {
  const harness = createCorrectionServiceHarness({ sincronizarBitrix: false });
  const result = await harness.run();
  assert.equal(harness.calls.includes('bitrix-read'), false);
  assert.equal(harness.calls.includes('bitrix-write'), false);
  assert.equal(result.bitrixSync.permitido, false);
  assert.match(result.bitrixSync.motivo, /pol[ií]tica/i);
  assert.ok(harness.calls.indexOf('oracle-update') < harness.calls.indexOf('logs'));
});

test('serviço sincroniza Bitrix somente depois de Oracle e log quando permitido', async () => {
  const harness = createCorrectionServiceHarness({ sincronizarBitrix: true });
  const result = await harness.run();
  assert.equal(result.bitrixSync.permitido, true);
  assert.equal(harness.calls.filter((item) => item === 'bitrix-read').length, 1);
  assert.ok(harness.calls.indexOf('oracle-update') < harness.calls.indexOf('logs'));
  assert.ok(harness.calls.indexOf('logs') < harness.calls.indexOf('bitrix-read'));
});

test('retry recuperável preserva explicitamente a permissão Bitrix', async () => {
  const harness = createCorrectionServiceHarness({ sincronizarBitrix: true, recoverOnce: true });
  const result = await harness.run();
  assert.equal(result.bitrixSync.permitido, true);
  assert.equal(harness.calls.filter((item) => item === 'bitrix-read').length, 1);
});

test('guarda local bloqueia integração antes da primeira chamada', async () => {
  const service = new WinthorCadastroCorrecaoService({
    logger: silentLogger,
    bitrixService: {
      async buscarContatosPorCampo() { throw new Error('não deveria chamar'); }
    }
  });
  const result = await service._sincronizarClassificacaoBitrix(
    [{ codcli: 1, categoria_nova: 'OURO', codrede_novo: 11 }],
    { ambiente: 'TESTE', execId: '1', permitido: false }
  );
  assert.equal(result.permitido, false);
  assert.equal(result.totalProcessados, 0);
});

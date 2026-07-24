const assert = require('node:assert/strict');
const test = require('node:test');

const RotativoRepository = require('../../rotativo-repository');

const silentLogger = {
  log() {},
  error() {}
};

function createRepositoryWithRows(rows) {
  const pool = {
    async connect() {
      return {
        async query() {
          return { rows };
        },
        release() {}
      };
    }
  };

  return new RotativoRepository(silentLogger, { pool });
}

function createCapturingRepository() {
  const capturedQueries = [];
  const pool = {
    async connect() {
      return {
        async query(query, params) {
          capturedQueries.push({ query, params });
          return { rows: [] };
        },
        release() {}
      };
    }
  };

  return {
    repo: new RotativoRepository(silentLogger, { pool }),
    capturedQueries
  };
}

function fullPayload(cron_config) {
  return {
    dias_rotativa: 31,
    dias_longo_prazo: 60,
    dias_protecao_upgrade: 60,
    meses_sazonalidade_inicio: 10,
    meses_sazonalidade_fim: 3,
    fases_bitrix_bloqueio: [],
    mapa_bitrix: {},
    rca_segmento_map: {},
    rcas_rotativa: [10, 110],
    filiais_cron: [1],
    cron_config,
    pdf_config: { ativo: false, modo_teste: false, id_tester: 0 },
    winthor_fix_config: { ativo: true, intervalo_minutos: 15, sincronizar_bitrix: true }
  };
}

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
  assert.equal(extra.winthor_fix_config.sincronizar_bitrix, true);
});

test('leitura preserva modo válido, agendamento e flag WinThor', async () => {
  const repo = createRepositoryWithRows([{
    extra_config: {
      cron_config: {
        ativo: true,
        modo: 'CLASSIFICACAO',
        datetime: '2026-08-02T23:32',
        frequency: 'monthly'
      },
      winthor_fix_config: {
        ativo: false,
        intervalo_minutos: 30,
        sincronizar_bitrix: true
      }
    }
  }]);
  const params = await repo.obterParametrosSistema();
  assert.deepEqual(params.cron_config, {
    ativo: true,
    modo: 'CLASSIFICACAO',
    datetime: '2026-08-02T23:32',
    frequency: 'monthly'
  });
  assert.deepEqual(params.winthor_fix_config, {
    ativo: false,
    intervalo_minutos: 30,
    sincronizar_bitrix: true
  });
});

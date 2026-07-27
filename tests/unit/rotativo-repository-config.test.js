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

function createRepositoryWithStoredExtra(extra_config) {
  const row = { extra_config };
  const pool = {
    async connect() {
      return {
        async query(query, params) {
          if (query.includes('UPDATE parametros_sistema')) {
            const configuraCronComJsonb = /jsonb_build_object\('ativo', true, 'modo', 'CLASSIFICACAO'\)/.test(query);
            const gravaMarcadorComJsonb = /jsonb_build_object\('cron_classificacao_ativa_v1', true\)/.test(query);
            if (!configuraCronComJsonb || !gravaMarcadorComJsonb) {
              throw new Error('A inicializacao deve enviar objetos JSONB validos ao PostgreSQL.');
            }

            const migrations = row.extra_config?._system_migrations || {};
            if (!migrations.cron_classificacao_ativa_v1) {
              row.extra_config = {
                ...row.extra_config,
                cron_config: {
                  ...row.extra_config?.cron_config,
                  ativo: true,
                  modo: 'CLASSIFICACAO'
                },
                _system_migrations: {
                  ...migrations,
                  cron_classificacao_ativa_v1: true
                }
              };
            }
            return { rows: [] };
          }

          if (query.includes('INSERT INTO parametros_sistema')) {
            const incomingExtra = JSON.parse(params[8]);
            const preservesMigrations = query.includes('{_system_migrations}')
              && query.includes('parametros_sistema.extra_config');
            row.extra_config = {
              ...incomingExtra,
              _system_migrations: preservesMigrations
                ? {
                  ...(row.extra_config?._system_migrations || {}),
                  ...(incomingExtra._system_migrations || {})
                }
                : incomingExtra._system_migrations
            };
            return { rows: [] };
          }

          return { rows: [row] };
        },
        release() {}
      };
    }
  };

  return {
    repo: new RotativoRepository(silentLogger, { pool }),
    getExtra: () => row.extra_config
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
  const repo = createRepositoryWithRows([{
    extra_config: {
      cron_config: { ativo: true },
      _system_migrations: { cron_classificacao_ativa_v1: true }
    }
  }]);

  const params = await repo.obterParametrosSistema();

  assert.equal(params.cron_config.modo, 'MOVIMENTACAO');
});

test('inicializa uma vez como classificacao ativa preservando o agendamento', async () => {
  const { repo, getExtra } = createRepositoryWithStoredExtra({
    filiais_cron: [1, 2],
    cron_config: {
      ativo: false,
      modo: 'MOVIMENTACAO',
      datetime: '2026-08-02T23:32',
      frequency: 'monthly'
    },
    outro_parametro: 'preservado'
  });

  const params = await repo.obterParametrosSistema();

  assert.equal(params.cron_config.ativo, true);
  assert.equal(params.cron_config.modo, 'CLASSIFICACAO');
  assert.equal(params.cron_config.datetime, '2026-08-02T23:32');
  assert.equal(params.cron_config.frequency, 'monthly');
  assert.deepEqual(params.filiais_cron, [1, 2]);
  assert.equal(getExtra().outro_parametro, 'preservado');
  assert.equal(getExtra()._system_migrations.cron_classificacao_ativa_v1, true);
});

test('marcador existente preserva a escolha posterior do usuario', async () => {
  const { repo } = createRepositoryWithStoredExtra({
    cron_config: {
      ativo: false,
      modo: 'MOVIMENTACAO',
      datetime: '2026-08-02T23:32',
      frequency: 'monthly'
    },
    _system_migrations: { cron_classificacao_ativa_v1: true }
  });

  const params = await repo.obterParametrosSistema();

  assert.equal(params.cron_config.ativo, false);
  assert.equal(params.cron_config.modo, 'MOVIMENTACAO');
});

test('salvamento preserva o marcador interno', async () => {
  const { repo, getExtra } = createRepositoryWithStoredExtra({
    _system_migrations: { cron_classificacao_ativa_v1: true }
  });

  await repo.salvarParametrosSistema(fullPayload({
    ativo: false,
    modo: 'MOVIMENTACAO',
    datetime: '2026-08-02T23:32',
    frequency: 'monthly'
  }));

  assert.equal(getExtra()._system_migrations.cron_classificacao_ativa_v1, true);
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

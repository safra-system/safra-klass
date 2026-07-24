const assert = require('node:assert/strict');
const test = require('node:test');

const MovimentacaoCarteiraService = require('../../movimentacao-carteira-service');
const { createExecutionPolicy } = require('../../execution-policy');

function policyFor(mode) {
  return createExecutionPolicy({ ativo: true, modo: mode });
}

function performanceRows({
  codcli = 1,
  categoria = 'PRATA',
  classeCodigo = 14,
  score = 7.5,
  diasSemCompra = 100
} = {}) {
  const ultimaVenda = new Date();
  ultimaVenda.setDate(ultimaVenda.getDate() - diasSemCompra);

  return Array.from({ length: 6 }, (_, index) => {
    const data = new Date();
    data.setMonth(data.getMonth() - index - 1);

    return {
      CODCLI: codcli,
      CLIENTE: `Cliente ${codcli}`,
      FANTASIA: `Fantasia ${codcli}`,
      MES_ANO: `${String(data.getMonth() + 1).padStart(2, '0')}/${data.getFullYear()}`,
      ANO: data.getFullYear(),
      MES: data.getMonth() + 1,
      VLLIQUIDO: 1000,
      MEDIA_PONDERADA: score,
      DT_ULTIMA_VENDA: ultimaVenda,
      CATEGORIA: categoria,
      CODUSUR_ATUAL: 10,
      COD_RAMO_ATIVIDADE: 12,
      CLASSE_CODIGO: classeCodigo
    };
  });
}

function createServiceHarness(options = {}) {
  const calls = {
    performance: [],
    classificationUpdate: [],
    wallet: [],
    protection: [],
    upgrades: [],
    queue: [],
    movements: [],
    reports: [],
    bitrixReads: [],
    bitrixWrites: [],
    stage5: [],
    events: []
  };
  const rows = options.rows || performanceRows(options);
  const params = {
    dias_rotativa: 60,
    dias_rotativa_alto: 45,
    dias_longo_prazo: 90,
    dias_protecao_upgrade: 60,
    meses_sazonalidade_inicio: 13,
    meses_sazonalidade_fim: 13,
    fases_bitrix_bloqueio: [],
    ...(options.params || {})
  };
  const oracleConnection = {
    async execute(sql, binds) {
      if (sql.includes('CODUSUR1')) {
        calls.wallet.push({ codcli: binds.codcli, novoRca: binds.novoRca });
      } else {
        calls.events.push('classificationUpdate');
        calls.classificationUpdate.push({
          codcli: binds.codcli,
          codRede: binds.codRede,
          categoria: binds.categoria,
          sql,
          binds
        });
        if (options.classificationError) throw options.classificationError;
      }
      return { rowsAffected: 1 };
    },
    async close() {}
  };
  const dependencies = {
    performance: {
      async calcularPerformance(filtros) {
        calls.performance.push(filtros);
        return rows;
      }
    },
    rotativoRepo: {
      async obterParametrosSistema() {
        return params;
      },
      async consultarProtecaoAtiva(codcli, dias) {
        calls.protection.push({ codcli, dias });
        return options.protection || null;
      },
      async registrarUpgradeCliente(payload) {
        calls.events.push('upgrade');
        calls.upgrades.push(payload);
      },
      async syncRotativo(payload) {
        calls.queue.push(payload);
      },
      async registrarRemanejamentoGrupo2(payload) {
        calls.movements.push(payload);
      },
      async salvarDadosRelatorio(payload) {
        calls.reports.push(payload);
      }
    },
    clienteRepo: {
      async buscarDadosCadastrais(codcli) {
        calls.bitrixReads.push({ type: 'cliente', codcli });
        return { CODCLI: codcli, TELEFONE: '0000000000', CODATV1: 12 };
      }
    },
    bitrixService: {
      async buscarContatoPorTelefones(data) {
        calls.bitrixReads.push({ type: 'contato', data });
        return 99;
      },
      async listarNegociosAtivos(contactId) {
        calls.bitrixReads.push({ type: 'negocios', contactId });
        return [];
      },
      async atualizarContato(...args) {
        calls.bitrixWrites.push(args);
      }
    },
    rcaRepo: {},
    oraclePool: {
      async getConnection() {
        return oracleConnection;
      }
    }
  };
  const logger = { log() {}, warn() {}, error() {} };
  const service = new MovimentacaoCarteiraService(logger, dependencies);

  return { service, calls, dependencies };
}

function clientInput(policy) {
  return {
    competencia: null,
    CodFilial: [1],
    ClienteCod: 1,
    DataIni: '01/01/2026',
    DataFim: '30/06/2026',
    policy
  };
}

test('injeta dependencias externas pelo construtor', () => {
  const dependencies = {
    performance: {},
    rotativoRepo: {},
    clienteRepo: {},
    bitrixService: {},
    rcaRepo: {},
    oraclePool: {}
  };

  const service = new MovimentacaoCarteiraService(
    { log() {}, warn() {}, error() {} },
    dependencies
  );

  assert.equal(service.performance, dependencies.performance);
  assert.equal(service.rotativoRepo, dependencies.rotativoRepo);
  assert.equal(service.clienteRepo, dependencies.clienteRepo);
  assert.equal(service.bitrixService, dependencies.bitrixService);
  assert.equal(service.rcaRepo, dependencies.rcaRepo);
  assert.equal(service.oraclePool, dependencies.oraclePool);
});

test('classificacao persiste somente categoria e rede e encerra', async () => {
  const { service, calls } = createServiceHarness();

  const result = await service.processarCliente(
    clientInput(policyFor('CLASSIFICACAO'))
  );

  assert.deepEqual(
    calls.classificationUpdate.map(({ codcli, codRede, categoria }) => ({
      codcli,
      codRede,
      categoria
    })),
    [{ codcli: 1, codRede: 13, categoria: 'OURO' }]
  );
  assert.equal(calls.classificationUpdate[0].sql.includes('CODATV1'), false);
  assert.deepEqual(calls.classificationUpdate[0].binds, {
    codRede: 13,
    categoria: 'OURO',
    codcli: 1
  });
  assert.equal(calls.protection.length, 0);
  assert.equal(calls.bitrixReads.length, 0);
  assert.equal(calls.bitrixWrites.length, 0);
  assert.equal(calls.wallet.length, 0);
  assert.equal(calls.queue.length, 0);
  assert.equal(calls.movements.length, 0);
  assert.equal(calls.upgrades.length, 1);
  assert.equal(result.modoExecucao, 'CLASSIFICACAO');
  assert.equal(result.classificacaoAtual, 'OURO');
});

test('falha ao persistir classificacao impede efeitos posteriores', async () => {
  const { service, calls } = createServiceHarness({
    classificationError: new Error('oracle')
  });

  await assert.rejects(
    service.processarCliente(clientInput(policyFor('CLASSIFICACAO'))),
    /oracle/
  );

  assert.equal(calls.upgrades.length, 0);
  assert.equal(calls.protection.length, 0);
  assert.equal(calls.wallet.length, 0);
  assert.equal(calls.queue.length, 0);
  assert.equal(calls.movements.length, 0);
  assert.equal(calls.bitrixReads.length, 0);
  assert.equal(calls.bitrixWrites.length, 0);
  assert.equal(calls.reports.length, 0);
});

test('classificacao bloqueia gravacao de downgrade durante sazonalidade', async () => {
  const { service, calls } = createServiceHarness({
    categoria: 'DIAMANTE',
    classeCodigo: 11,
    params: {
      meses_sazonalidade_inicio: 1,
      meses_sazonalidade_fim: 12
    }
  });

  const result = await service.processarCliente(
    clientInput(policyFor('CLASSIFICACAO'))
  );

  assert.equal(calls.classificationUpdate.length, 0);
  assert.equal(calls.protection.length, 0);
  assert.equal(calls.wallet.length, 0);
  assert.equal(result.classificacaoAtual, 'DIAMANTE');
  assert.equal(result.classificacaoBloqueadaPorSazonalidade, true);
});

test('movimentacao conserva protecao fila RCA e Bitrix', async () => {
  const { service, calls } = createServiceHarness({
    categoria: 'OURO',
    classeCodigo: 13
  });

  const result = await service.processarCliente(
    clientInput(policyFor('MOVIMENTACAO'))
  );

  assert.equal(calls.protection.length, 1);
  assert.equal(calls.queue.length, 1);
  assert.equal(calls.wallet.length, 1);
  assert.equal(calls.movements.length, 1);
  assert.equal(calls.bitrixWrites.length, 1);
  assert.equal(result.modoExecucao, 'MOVIMENTACAO');
});

test('protecao ativa continua bloqueando efeitos de movimentacao', async () => {
  const { service, calls } = createServiceHarness({
    categoria: 'OURO',
    classeCodigo: 13,
    protection: {
      dias_restantes: 10,
      origem_protecao: 'UPGRADE'
    }
  });

  const result = await service.processarCliente(
    clientInput(policyFor('MOVIMENTACAO'))
  );

  assert.equal(calls.protection.length, 1);
  assert.equal(calls.queue.length, 0);
  assert.equal(calls.wallet.length, 0);
  assert.equal(calls.movements.length, 0);
  assert.equal(calls.bitrixReads.length, 0);
  assert.equal(calls.bitrixWrites.length, 0);
  assert.equal(result.grupoCarteira, 'BLOQUEADO_POR_EXCECAO');
});

test('movimentacao continua mesmo com downgrade sazonal bloqueado', async () => {
  const { service, calls } = createServiceHarness({
    categoria: 'DIAMANTE',
    classeCodigo: 11,
    params: {
      meses_sazonalidade_inicio: 1,
      meses_sazonalidade_fim: 12
    }
  });

  const result = await service.processarCliente(
    clientInput(policyFor('MOVIMENTACAO'))
  );

  assert.equal(calls.classificationUpdate.length, 0);
  assert.equal(calls.protection.length, 1);
  assert.equal(calls.queue.length, 1);
  assert.equal(calls.wallet.length, 1);
  assert.equal(calls.bitrixWrites.length, 1);
  assert.equal(result.classificacaoAtual, 'DIAMANTE');
});

test('movimentacao usa classificacao nova em fila e auditoria', async () => {
  const { service, calls } = createServiceHarness({
    categoria: 'DIAMANTE',
    classeCodigo: 11
  });

  await service.processarCliente(clientInput(policyFor('MOVIMENTACAO')));

  assert.equal(calls.queue[0].classificacaoAtual, 'OURO');
  assert.equal(calls.movements[0].classificacaoAtual, 'OURO');
  assert.equal(calls.reports.at(-1).classificacaoAtual, 'OURO');
});

test('upgrade e registrado somente depois do update Oracle', async () => {
  const { service, calls } = createServiceHarness();

  await service.processarCliente(clientInput(policyFor('CLASSIFICACAO')));

  assert.deepEqual(calls.events, ['classificationUpdate', 'upgrade']);
});

test('policy ausente preserva modo completo de movimentacao', async () => {
  const { service, calls } = createServiceHarness({
    categoria: 'OURO',
    classeCodigo: 13
  });

  const result = await service.processarCliente(clientInput());

  assert.equal(calls.protection.length, 1);
  assert.equal(calls.queue.length, 1);
  assert.equal(calls.wallet.length, 1);
  assert.equal(calls.bitrixWrites.length, 1);
  assert.equal(result.modoExecucao, 'MOVIMENTACAO');
});

test('lote classificacao continua apos erro e nao executa etapa 5', async () => {
  const rows = [
    { CODCLI: 1 },
    { CODCLI: 2 }
  ];
  const { service, calls } = createServiceHarness({ rows });
  const policy = policyFor('CLASSIFICACAO');
  const processed = [];

  service.processarCliente = async (input) => {
    processed.push(input);
    if (input.ClienteCod === 1) throw new Error('cliente 1');
  };
  service.executarEtapa5Redistribuicao = async (input) => {
    calls.stage5.push(input);
  };

  await service.processarTodosClientesElegiveis({
    CodFilial: [1],
    DataIni: '01/01/2026',
    DataFim: '30/06/2026',
    competencia: null,
    policy
  });

  assert.deepEqual(processed.map((input) => input.ClienteCod), [1, 2]);
  assert.equal(processed.every((input) => input.policy === policy), true);
  assert.equal(calls.stage5.length, 0);
});

test('lote movimentacao preserva skipBitrixEtapa5 e executa etapa 5', async () => {
  const { service, calls } = createServiceHarness({
    rows: [{ CODCLI: 1 }]
  });
  const policy = policyFor('MOVIMENTACAO');
  const processed = [];

  service.processarCliente = async (input) => {
    processed.push(input);
  };
  service.executarEtapa5Redistribuicao = async (input) => {
    calls.stage5.push(input);
  };

  await service.processarTodosClientesElegiveis({
    CodFilial: [1],
    DataIni: '01/01/2026',
    DataFim: '30/06/2026',
    competencia: null,
    skipBitrixEtapa5: true,
    policy
  });

  assert.equal(processed[0].policy, policy);
  assert.deepEqual(calls.stage5, [{ skipBitrix: true }]);
});

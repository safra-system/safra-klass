const {
  createWinthorCorrectionPolicy
} = require('./execution-policy');

function createWinthorCorrectionRunner({
  paramsRepository,
  correctionService,
  logger = console
}) {
  if (!paramsRepository || typeof paramsRepository.obterParametrosSistema !== 'function') {
    throw new TypeError('paramsRepository.obterParametrosSistema é obrigatório');
  }
  if (!correctionService || typeof correctionService.executarCorrecao !== 'function') {
    throw new TypeError('correctionService.executarCorrecao é obrigatório');
  }
  if (typeof correctionService.executarRollbackLegado !== 'function') {
    throw new TypeError('correctionService.executarRollbackLegado é obrigatório');
  }

  let running = false;

  async function readPolicy() {
    const params = await paramsRepository.obterParametrosSistema() || {};
    return createWinthorCorrectionPolicy(params);
  }

  async function executeCorrection({ source, forceRecreateProcedure = false }) {
    const policy = await readPolicy();
    if (source !== 'MANUAL' && !policy.winthorFix.ativo) {
      return { skipped: true, reason: 'DISABLED' };
    }
    return correctionService.executarCorrecao({
      forceRecreateProcedure: Boolean(forceRecreateProcedure),
      sincronizarBitrix: policy.canSyncBitrix
    });
  }

  async function runCorrection({ source = 'MANUAL', forceRecreateProcedure = false } = {}) {
    if (running) return { skipped: true, reason: 'EXECUTION_IN_PROGRESS' };
    running = true;
    try {
      return await executeCorrection({
        source: String(source || 'MANUAL').toUpperCase(),
        forceRecreateProcedure
      });
    } finally {
      running = false;
    }
  }

  async function runRollback({
    source = 'MANUAL',
    executarCorrecaoPosRollback = true,
    ...rollbackOptions
  } = {}) {
    if (running) return { skipped: true, reason: 'EXECUTION_IN_PROGRESS' };
    running = true;
    try {
      const result = await correctionService.executarRollbackLegado({
        ...rollbackOptions,
        executarCorrecaoPosRollback: false
      });
      if (executarCorrecaoPosRollback && Number(result?.logsLegadosEncontrados || 0) > 0) {
        result.correcaoPosRollback = await executeCorrection({
          source: String(source || 'MANUAL').toUpperCase(),
          forceRecreateProcedure: false
        });
      }
      return result;
    } finally {
      running = false;
    }
  }

  return {
    runCorrection,
    runRollback,
    isRunning: () => running
  };
}

module.exports = {
  createWinthorCorrectionRunner
};

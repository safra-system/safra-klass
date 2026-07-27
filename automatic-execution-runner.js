const { createExecutionPolicy } = require('./execution-policy');

const DEFAULT_BRANCHES = Object.freeze([1, 3, 5, 6]);
const DEFAULT_PDF_RCAS = Object.freeze([10, 110]);
const PDF_SEND_DELAY_MS = 2000;

function createAutomaticExecutionRunner({
  paramsRepository,
  createMovementService,
  createReportService,
  calculatePeriod,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = console
}) {
  if (!paramsRepository || typeof paramsRepository.obterParametrosSistema !== 'function') {
    throw new TypeError('paramsRepository.obterParametrosSistema é obrigatório');
  }
  if (typeof createMovementService !== 'function') {
    throw new TypeError('createMovementService é obrigatório');
  }
  if (typeof createReportService !== 'function') {
    throw new TypeError('createReportService é obrigatório');
  }
  if (typeof calculatePeriod !== 'function') {
    throw new TypeError('calculatePeriod é obrigatório');
  }

  let running = false;

  async function run() {
    if (running) {
      return { skipped: true, reason: 'EXECUTION_IN_PROGRESS' };
    }

    running = true;
    try {
      const params = await paramsRepository.obterParametrosSistema() || {};
      const policy = createExecutionPolicy(params.cron_config);

      if (!policy.enabled) {
        return { skipped: true, reason: 'DISABLED' };
      }

      const { DataIni, DataFim } = calculatePeriod();
      const branches = Array.isArray(params.filiais_cron) && params.filiais_cron.length > 0
        ? params.filiais_cron
        : DEFAULT_BRANCHES;
      const movementService = createMovementService();
      const batchResult = await movementService.processarTodosClientesElegiveis({
        CodFilial: branches,
        DataIni,
        DataFim,
        competencia: null,
        skipBitrixEtapa5: !policy.canWriteBitrix,
        policy
      });

      let pdfsSent = 0;
      if (policy.canSendPdf && params.pdf_config?.ativo) {
        const reportService = createReportService();
        const rcas = Array.isArray(params.rcas_rotativa) && params.rcas_rotativa.length > 0
          ? params.rcas_rotativa
          : DEFAULT_PDF_RCAS;
        const targetId = params.pdf_config.modo_teste
          ? params.pdf_config.id_tester
          : null;

        for (let index = 0; index < rcas.length; index += 1) {
          const rca = rcas[index];
          await reportService.processarRelatorioVendedor(rca, targetId);
          pdfsSent += 1;
          if (index < rcas.length - 1) {
            await delay(PDF_SEND_DELAY_MS);
          }
        }
      }

      logger?.log?.(
        `[Agendador] Execução automática concluída no modo ${policy.mode}.`
      );

      return {
        skipped: false,
        mode: policy.mode,
        batchResult,
        pdfsSent
      };
    } finally {
      running = false;
    }
  }

  return {
    run,
    isRunning: () => running
  };
}

module.exports = {
  createAutomaticExecutionRunner
};

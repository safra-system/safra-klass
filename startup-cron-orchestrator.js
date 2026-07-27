function createStartupCronOrchestrator({
  initializeClassification,
  configureMainCron,
  logger
}) {
  return async function runStartupCronConfiguration() {
    try {
      await initializeClassification();
    } catch (error) {
      logger.error(
        '[Agendador] Erro ao aplicar inicializacao da classificacao ativa no startup:',
        error
      );
      return;
    }

    try {
      await configureMainCron();
    } catch (error) {
      logger.error('[Agendador] Erro ao configurar o cron principal no startup:', error);
    }
  };
}

module.exports = { createStartupCronOrchestrator };

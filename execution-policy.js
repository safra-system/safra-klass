const EXECUTION_MODES = Object.freeze({
  CLASSIFICACAO: 'CLASSIFICACAO',
  MOVIMENTACAO: 'MOVIMENTACAO'
});

function normalizeCronConfig(raw = {}) {
  const ativo = raw?.ativo === true;
  const valid = Object.values(EXECUTION_MODES).includes(raw?.modo);
  const modo = valid
    ? raw.modo
    : (ativo ? EXECUTION_MODES.MOVIMENTACAO : EXECUTION_MODES.CLASSIFICACAO);

  return { ...raw, ativo, modo };
}

function normalizeCronConfigForWrite(raw = {}) {
  const hasExplicitMode = Object.prototype.hasOwnProperty.call(raw || {}, 'modo');
  if (hasExplicitMode && !Object.values(EXECUTION_MODES).includes(raw.modo)) {
    throw new RangeError('Modo de execucao invalido. Use CLASSIFICACAO ou MOVIMENTACAO.');
  }

  return normalizeCronConfig(raw);
}

function createExecutionPolicy(raw) {
  const { ativo: enabled, modo } = normalizeCronConfig(raw);
  const canMove = enabled && modo === EXECUTION_MODES.MOVIMENTACAO;

  return {
    enabled,
    mode: modo,
    canClassify: enabled,
    canMoveWallet: canMove,
    canReadBitrix: canMove,
    canWriteBitrix: canMove,
    canUseQueue: canMove,
    canRunStage5: canMove,
    canSendPdf: canMove
  };
}

function normalizeWinthorFixConfig(raw = {}) {
  return {
    ...raw,
    ativo: typeof raw?.ativo === 'boolean' ? raw.ativo : true,
    intervalo_minutos: [1, 15, 30].includes(Number(raw?.intervalo_minutos))
      ? Number(raw.intervalo_minutos)
      : 15,
    sincronizar_bitrix: raw?.sincronizar_bitrix === true
  };
}

function createWinthorCorrectionPolicy({ cron_config, winthor_fix_config } = {}) {
  const execution = createExecutionPolicy(cron_config);
  const winthorFix = normalizeWinthorFixConfig(winthor_fix_config);
  return {
    execution,
    winthorFix,
    canSyncBitrix: execution.canWriteBitrix && winthorFix.sincronizar_bitrix === true
  };
}

module.exports = {
  EXECUTION_MODES,
  normalizeCronConfig,
  normalizeCronConfigForWrite,
  createExecutionPolicy,
  normalizeWinthorFixConfig,
  createWinthorCorrectionPolicy
};

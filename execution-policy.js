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

module.exports = {
  EXECUTION_MODES,
  normalizeCronConfig,
  createExecutionPolicy
};

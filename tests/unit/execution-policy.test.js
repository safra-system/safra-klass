const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXECUTION_MODES,
  normalizeCronConfig,
  createExecutionPolicy
} = require('../../execution-policy');

test('configuração ativa legada preserva movimentação', () => {
  assert.equal(
    normalizeCronConfig({ ativo: true }).modo,
    EXECUTION_MODES.MOVIMENTACAO
  );
});

test('classificação nega todos os efeitos de movimentação', () => {
  const policy = createExecutionPolicy({
    ativo: true,
    modo: EXECUTION_MODES.CLASSIFICACAO
  });

  assert.equal(policy.canClassify, true);
  assert.equal(policy.canMoveWallet, false);
  assert.equal(policy.canReadBitrix, false);
  assert.equal(policy.canWriteBitrix, false);
  assert.equal(policy.canRunStage5, false);
});

test('movimentação preserva o fluxo completo', () => {
  const policy = createExecutionPolicy({
    ativo: true,
    modo: EXECUTION_MODES.MOVIMENTACAO
  });

  assert.equal(policy.canMoveWallet, true);
  assert.equal(policy.canReadBitrix, true);
  assert.equal(policy.canWriteBitrix, true);
  assert.equal(policy.canRunStage5, true);
});

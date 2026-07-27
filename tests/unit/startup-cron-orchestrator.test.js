const assert = require('node:assert/strict');
const test = require('node:test');

function createSubject(dependencies) {
  const { createStartupCronOrchestrator } = require('../../startup-cron-orchestrator');
  return createStartupCronOrchestrator(dependencies);
}

test('startup nao configura cron principal quando inicializacao falha', async () => {
  const calls = [];
  const errors = [];
  const runStartup = createSubject({
    initializeClassification: async () => {
      calls.push('initialize');
      throw new Error('banco indisponivel');
    },
    configureMainCron: async () => calls.push('configure'),
    logger: { error: (message, error) => errors.push({ message, error }) }
  });

  await assert.doesNotReject(runStartup());
  assert.deepEqual(calls, ['initialize']);
  assert.match(errors[0].message, /inicializacao.*startup/i);
  assert.equal(errors[0].error.message, 'banco indisponivel');
});

test('startup captura rejeicao ao configurar cron principal', async () => {
  const calls = [];
  const errors = [];
  const runStartup = createSubject({
    initializeClassification: async () => calls.push('initialize'),
    configureMainCron: async () => {
      calls.push('configure');
      throw new Error('cron indisponivel');
    },
    logger: { error: (message, error) => errors.push({ message, error }) }
  });

  await assert.doesNotReject(runStartup());
  assert.deepEqual(calls, ['initialize', 'configure']);
  assert.match(errors[0].message, /cron principal.*startup/i);
  assert.equal(errors[0].error.message, 'cron indisponivel');
});

test('startup configura cron principal somente depois da inicializacao', async () => {
  const calls = [];
  const errors = [];
  const runStartup = createSubject({
    initializeClassification: async () => calls.push('initialize'),
    configureMainCron: async () => calls.push('configure'),
    logger: { error: (message, error) => errors.push({ message, error }) }
  });

  await assert.doesNotReject(runStartup());
  assert.deepEqual(calls, ['initialize', 'configure']);
  assert.deepEqual(errors, []);
});

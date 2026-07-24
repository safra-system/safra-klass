const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeCronConfigForWrite } = require('../../execution-policy');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('public/config-parametros.html');
const script = read('public/js/config-parametros.js');
const server = read('server.js');

test('interface expoe somente os dois modos aprovados', () => {
  const inputs = html.match(/<input[^>]+name=.cron_modo.[^>]*>/g) || [];
  assert.equal(inputs.length, 2);
  assert.ok(inputs.some((input) => input.includes('CLASSIFICACAO')));
  assert.ok(inputs.some((input) => input.includes('MOVIMENTACAO')));
  assert.doesNotMatch(html, /value=.MANUAL./i);
  assert.ok(html.indexOf('cron-mode-selector') < html.indexOf('cron-options'));
});

test('disparo PDF exige policy antes do processo assincrono', () => {
  const start = server.indexOf('disparar-relatorios-pdf');
  const end = server.indexOf('// ==================================================================', start);
  const route = server.slice(start, end);
  const policy = route.indexOf('createExecutionPolicy(params?.cron_config)');
  const guard = route.indexOf('!policy.canSendPdf');
  const iife = route.indexOf('(async () =>');
  assert.ok(start > -1 && policy > -1 && guard > policy && iife > guard);
  assert.match(route, /status\(403\)/);
});

test('backend rejeita modo invalido e normaliza legado', () => {
  assert.throws(
    () => normalizeCronConfigForWrite({ ativo: true, modo: 'MANUAL' }),
    /modo.*invalido/i
  );
  assert.equal(normalizeCronConfigForWrite({ ativo: true }).modo, 'MOVIMENTACAO');
  assert.equal(normalizeCronConfigForWrite({ ativo: false }).modo, 'CLASSIFICACAO');
  assert.match(server, /normalizeCronConfigForWrite\(novosValores\.cron_config\)/);
  assert.match(server, /status\(400\)[\s\S]*Modo de execucao invalido/);
});

test('carrega e salva um unico modo preservando valores', () => {
  assert.match(script, /setSelectedExecutionMode\(d\.cron_config\?\.modo\)/);
  assert.equal((script.match(/modo:\s*getSelectedExecutionMode\(\)/g) || []).length, 1);
  assert.match(script, /let parametrosCarregados = false/);
  assert.match(script, /parametrosCarregados = true[\s\S]*saveBtn\.disabled = false/);
  assert.match(script, /getElementById\('dias_rotativa'\)/);
  assert.match(script, /getElementById\('pdf_ativo'\)/);
  assert.match(html, /id=.saveBtn.[^>]*disabled/);
});

test('bloqueio visual usa classe aria e inert', () => {
  assert.match(script, /function getSelectedExecutionMode\(\)/);
  assert.match(script, /function updateExecutionModeUi\(\)/);
  assert.match(script, /block\.classList\.toggle\('execution-section-disabled', classificationOnly\)/);
  assert.match(script, /block\.setAttribute\('aria-disabled', String\(classificationOnly\)\)/);
  assert.match(script, /block\.inert = classificationOnly/);
  assert.doesNotMatch(script, /block\.querySelectorAll[\s\S]{0,120}disabled/);
  assert.match(html, /id=.execution-mode-warning.[^>]+aria-live=.polite./);
});

test('marca blocos', () => {
  assert.match(html, /id=.movement-prazos. data-movement-only/);
  assert.match(html, /id=.movement-rca. data-movement-only/);
  assert.match(html, /id=.movement-bitrix. data-movement-only/);
  assert.match(html, /id=.movement-pdf. data-movement-only/);
  assert.match(html, /data-movement-only/);
  assert.equal((html.match(/data-movement-only/g) || []).length, 4);
  assert.match(html, /id=.common-sazonalidade./);
  assert.match(html, /id=.common-filiais./);
  assert.match(html, /id=.common-winthor-fix./);
  assert.doesNotMatch(html, /id=.common-sazonalidade.[^>]*data-movement-only/);
  assert.doesNotMatch(html, /id=.common-filiais.[^>]*data-movement-only/);
  assert.doesNotMatch(html, /id=.common-winthor-fix.[^>]*data-movement-only/);
});

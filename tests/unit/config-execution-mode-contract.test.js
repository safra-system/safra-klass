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

function openingTag(tagName, id) {
  const match = html.match(new RegExp('<' + tagName + '[^>]*id=.' + id + '.[^>]*>', 'i'));
  assert.ok(match, 'elemento #' + id + ' nao encontrado');
  return match[0];
}

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
  const start = server.indexOf("app.post('/api/parametros'");
  const end = server.indexOf("app.post('/api/reload-cron'", start);
  const route = server.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.match(route, /normalizeCronConfigForWrite\(novosValores\.cron_config\)/);
  assert.match(route, /status\(400\)[\s\S]*Modo de execucao invalido/);
});

test('POST exige campos de movimento somente no modo MOVIMENTACAO', () => {
  const start = server.indexOf("app.post('/api/parametros'");
  const end = server.indexOf("app.post('/api/reload-cron'", start);
  const route = server.slice(start, end);
  assert.match(server, /const \{[^}]*EXECUTION_MODES[^}]*\} = require\('\.\/execution-policy'\)/);
  assert.match(route, /cron_config\.modo === EXECUTION_MODES\.MOVIMENTACAO\s*&&/);
  assert.match(route, /!novosValores\.dias_rotativa[\s\S]*!novosValores\.fases_bitrix_bloqueio/);
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

test('fallback sem cron inicia ativo em classificacao', () => {
  assert.match(script, /elAtivo\.checked\s*=\s*true/);
  assert.match(script, /setSelectedExecutionMode\('CLASSIFICACAO'\)/);
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

test('required acompanha o modo sem limpar valores', () => {
  ['dias_rotativa', 'dias_longo_prazo', 'dias_protecao_upgrade'].forEach((id) => {
    const input = openingTag('input', id);
    assert.match(input, /data-required-in-movement/);
    assert.match(input, /required/);
  });
  assert.match(script, /querySelectorAll\('\[data-required-in-movement\]'\)/);
  assert.match(script, /control\.required = !classificationOnly/);
});

test('marca blocos', () => {
  ['movement-prazos', 'movement-rca', 'movement-bitrix', 'movement-pdf']
    .forEach((id) => assert.match(openingTag('div', id), /data-movement-only/));
  assert.equal((html.match(/data-movement-only/g) || []).length, 4);
  ['common-sazonalidade', 'common-filiais', 'common-winthor-fix']
    .forEach((id) => assert.doesNotMatch(openingTag('div', id), /data-movement-only/));
});

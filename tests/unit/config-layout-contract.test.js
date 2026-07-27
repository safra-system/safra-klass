const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('public/config-parametros.html');
const css = read('public/css/config-parametros.css');
const script = read('public/js/config-parametros.js');

test('agendamento aparece depois dos acessos e antes da card de classificacao', () => {
  const access = html.indexOf('Controle de Acessos e Permissões');
  const schedule = html.indexOf('id="automatic-schedule"');
  const classification = html.indexOf('Classifica&ccedil;&atilde;o e Movimenta&ccedil;&atilde;o Autom&aacute;tica');

  assert.ok(access > -1, 'bloco de acessos nao encontrado');
  assert.ok(schedule > access, 'agendamento deve vir depois dos acessos');
  assert.ok(classification > schedule, 'card de classificacao deve vir depois do agendamento');

  ['movement-prazos', 'common-sazonalidade', 'movement-rca', 'movement-bitrix']
    .forEach((id) => assert.ok(
      html.indexOf(`id="${id}"`) > schedule,
      `#${id} deve vir depois do agendamento`
    ));

  const formStart = html.indexOf('<form id="configForm">');
  const formEnd = html.indexOf('</form>', formStart);
  assert.ok(formStart > access && formStart < schedule);
  assert.ok(formEnd > html.indexOf('id="saveBtn"'));
});

test('opcoes WinThor usam fluxo vertical e tipografia dedicada', () => {
  const optionsStart = html.indexOf('id="winthor-fix-options"');
  const optionsEnd = html.indexOf('class="fix-actions"', optionsStart);
  const optionsHtml = html.slice(optionsStart, optionsEnd);

  assert.ok(optionsStart > -1 && optionsEnd > optionsStart);
  assert.ok(
    optionsHtml.indexOf('winthor_fix_intervalo') <
      optionsHtml.indexOf('winthor_fix_sincronizar_bitrix'),
    'sincronizacao Bitrix deve vir abaixo do intervalo'
  );
  assert.match(html, /class="cron-header winthor-fix-header"/);
  assert.match(html, /class="winthor-fix-copy"/);
  assert.match(html, /class="hint winthor-fix-description"/);
  assert.match(html, /id="winthor-fix-status" class="hint winthor-fix-status"/);
  assert.match(css, /#winthor-fix-options\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.winthor-fix-description\s*\{[\s\S]*?line-height:/);
  assert.match(css, /\.winthor-fix-status\s*\{[\s\S]*?white-space:\s*pre-line/);
  assert.match(script, /Status: ATIVADO[\s\S]*\\n\$\{statusBitrix\}/);
  assert.match(script, /Status: DESATIVADO[\s\S]*\\n\$\{statusBitrix\}/);
});

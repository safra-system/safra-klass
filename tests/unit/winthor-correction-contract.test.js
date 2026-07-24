const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('public/config-parametros.html');
const script = read('public/js/config-parametros.js');
const server = read('server.js');
const service = read('winthor-cadastro-correcao-service.js');

test('UI descreve correção real e expõe flag Bitrix comum aos modos', () => {
  assert.match(html, /\bid\s*=\s*["']winthor_fix_sincronizar_bitrix["']/i);
  assert.match(html, /confere CATEGORIA com base no CODREDE/i);
  assert.match(html, /n[aã]o altera CODATV1 nem CODREDE/i);
  assert.match(html, /cron principal[\s\S]*MOVIMENTACAO[\s\S]*flag/i);
  assert.match(html, /1 minuto[\s\S]*varredura/i);
  assert.doesNotMatch(html, /verifica[cç][aã]o\/corre[cç][aã]o peri[oó]dica de CATEGORIA, CODATV1 e CODREDE/i);
});

test('UI carrega e salva sincronizar_bitrix sem atrelar bloco ao modo', () => {
  assert.match(script, /winthor_fix_sincronizar_bitrix/);
  assert.match(script, /sincronizar_bitrix:\s*elWinthorFixSincronizarBitrix/);
  assert.match(script, /d\?\.winthor_fix_config\?\.sincronizar_bitrix/);
  const block = html.match(/<div\b[^>]*\bid\s*=\s*["']common-winthor-fix["'][^>]*>/i)?.[0] || '';
  assert.doesNotMatch(block, /data-movement-only/);
  assert.doesNotMatch(script, /elWinthorFixOptions\.style\.pointerEvents/);
  assert.match(script, /intervalGroup\.style\.pointerEvents/);
});

test('todas as entradas operacionais do server usam correctionRunner', () => {
  assert.match(server, /const correctionRunner = createWinthorCorrectionRunner/);
  assert.match(server, /correctionRunner\.runCorrection\(\{\s*source:\s*'MANUAL'/);
  assert.match(server, /correctionRunner\.runRollback\(\{\s*source:\s*'MANUAL'/);
  assert.match(server, /correctionRunner\.runCorrection\(\{\s*source:\s*'CRON'/);
  assert.match(server, /correctionRunner\.runCorrection\(\{\s*source:\s*'STARTUP'/);
  const directCalls = server.match(/winthorCorrecaoService\.(?:executarCorrecao|executarRollbackLegado)\s*\(/g) || [];
  assert.equal(directCalls.length, 0);
  assert.match(server, /resultado\.skipped/);
  const manualRoute = server.slice(
    server.indexOf(`app.post('/api/winthor/corrigir-cadastro-clientes'`),
    server.indexOf(`app.post('/api/winthor/rollback-correcao-legado'`)
  );
  assert.doesNotMatch(manualRoute, /sincronizarBitrix|sincronizar_bitrix/);
});

test('procedure continua corrigindo somente CATEGORIA', () => {
  const start = service.indexOf('CREATE OR REPLACE PROCEDURE');
  const end = service.indexOf('_buildPendenciasSelectSql()', start);
  const sql = service.slice(start, end);
  assert.match(sql, /SET\s+(?:P\.)?CATEGORIA\s*=/i);
  assert.doesNotMatch(sql, /SET\s+(?:P\.)?(?:CODATV1|CODREDE)\s*=/i);
});

test('servico de rollback nao dispara correcao recursiva', () => {
  const start = service.indexOf('async executarRollbackLegado');
  const rollback = service.slice(start);
  assert.doesNotMatch(rollback, /this\.executarCorrecao\s*\(/);
  assert.match(rollback, /correcaoPosRollback:\s*null/);
});

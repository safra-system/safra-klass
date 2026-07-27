const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const root = path.resolve(__dirname, '../..');
const previewModulePath = path.join(root, 'preview-server.js');

function loadPreviewModule() {
  assert.ok(
    fs.existsSync(previewModulePath),
    'preview-server.js deve existir para fornecer o preview isolado'
  );

  delete require.cache[require.resolve(previewModulePath)];
  return require(previewModulePath);
}

async function withPreviewServer(callback) {
  const { createPreviewApp, PREVIEW_HOST } = loadPreviewModule();
  const app = createPreviewApp();
  const server = app.listen(0, PREVIEW_HOST);
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('preview tem grafo de imports isolado e bind fixo em loopback', () => {
  const source = fs.existsSync(previewModulePath)
    ? fs.readFileSync(previewModulePath, 'utf8')
    : '';

  const imports = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)]
    .map((match) => match[1]);
  const forbidden = [
    'dotenv',
    './server',
    './db-switch',
    'pg',
    'oracledb',
    'axios',
    'node-cron',
    './bitrix-service',
    './movimentacao-carteira-service',
    './winthor-cadastro-correcao-service'
  ];

  assert.ok(
    fs.existsSync(previewModulePath),
    'preview-server.js deve existir para fornecer o preview isolado'
  );
  forbidden.forEach((moduleName) => assert.ok(
    !imports.includes(moduleName),
    `preview nao pode importar ${moduleName}`
  ));

  const preview = loadPreviewModule();
  assert.equal(preview.PREVIEW_HOST, '127.0.0.1');
});

test('preview autentica usuario ficticio e inicia ativo em classificacao', async () => {
  await withPreviewServer(async (baseUrl) => {
    const userResponse = await fetch(`${baseUrl}/api/user-info`);
    assert.equal(userResponse.status, 200);
    assert.equal(userResponse.headers.get('x-safra-preview'), 'isolated');
    const user = await userResponse.json();
    assert.equal(user.logged, true);
    assert.equal(user.isAdmin, true);

    const paramsResponse = await fetch(`${baseUrl}/api/parametros`);
    assert.equal(paramsResponse.status, 200);
    const params = await paramsResponse.json();
    assert.equal(params.success, true);
    assert.equal(params.data.cron_config.ativo, true);
    assert.equal(params.data.cron_config.modo, 'CLASSIFICACAO');
    assert.equal(params.data.cron_config.datetime, '');
    assert.equal(params.data.cron_config.frequency, 'monthly');
    assert.equal(params.data.winthor_fix_config.ativo, false);
    assert.equal(params.data.winthor_fix_config.sincronizar_bitrix, false);
    assert.equal(params.data.pdf_config.ativo, false);
  });
});

test('preview injeta aviso visivel e serve os dois modos de execucao', async () => {
  await withPreviewServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/configuracoes`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /PREVIEW LOCAL ISOLADO/);
    assert.match(html, /name="cron_modo"[^>]+value="CLASSIFICACAO"/);
    assert.match(html, /name="cron_modo"[^>]+value="MOVIMENTACAO"/);
  });
});

test('preview bloqueia qualquer mutacao e nunca encaminha API desconhecida', async () => {
  await withPreviewServer(async (baseUrl) => {
    const dangerousRequests = [
      ['POST', '/api/parametros'],
      ['POST', '/api/reload-cron'],
      ['POST', '/api/switch-env'],
      ['POST', '/api/winthor/corrigir-cadastro-clientes'],
      ['POST', '/api/winthor/rollback-correcao-legado'],
      ['POST', '/api/disparar-relatorios-pdf'],
      ['POST', '/api/executar-substituicao'],
      ['POST', '/api/transferir-para-118'],
      ['PATCH', '/api/users-permissions/1'],
      ['DELETE', '/api/users-permissions/1']
    ];

    for (const [method, route] of dangerousRequests) {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}'
      });
      assert.equal(response.status, 405, `${method} ${route} deveria ser bloqueado`);
      const payload = await response.json();
      assert.equal(payload.code, 'PREVIEW_READ_ONLY');
    }

    const unknown = await fetch(`${baseUrl}/api/rota-inexistente`);
    assert.equal(unknown.status, 404);
    const payload = await unknown.json();
    assert.equal(payload.code, 'PREVIEW_API_NOT_MOCKED');
  });
});

test('package expoe comando dedicado que nao inicia o backend real', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.preview, 'node preview-server.js');
  assert.doesNotMatch(packageJson.scripts.preview, /(^|\s)server\.js|nodemon/);
});

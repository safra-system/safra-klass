const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const {
  previewUser,
  previewParameters,
  previewUsers,
  previewDashboard
} = require('./preview-fixtures');

const PREVIEW_HOST = '127.0.0.1';
const PREVIEW_PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const PAGE_ROUTES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/login.html', 'login.html'],
  ['/detalhes-cliente', 'detalhes-cliente.html'],
  ['/detalhes-cliente.html', 'detalhes-cliente.html'],
  ['/detalhes-rca', 'detalhes-rca.html'],
  ['/detalhes-rca.html', 'detalhes-rca.html'],
  ['/configuracoes', 'config-parametros.html'],
  ['/config-parametros.html', 'config-parametros.html'],
  ['/relatorio-gestores', 'relatorio-gestores.html'],
  ['/relatorio-gestores.html', 'relatorio-gestores.html'],
  ['/chave', 'chave.html'],
  ['/chave.html', 'chave.html'],
  ['/substituicao-carteira', 'substituicao-carteira.html'],
  ['/substituicao-carteira.html', 'substituicao-carteira.html']
]);

const PREVIEW_BANNER = `
<div id="safra-preview-banner" role="status" aria-live="polite">
  <strong>PREVIEW LOCAL ISOLADO</strong>
  <span>Dados simulados. Integracoes e gravacoes bloqueadas.</span>
</div>
<style>
  #safra-preview-banner {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 2147483647;
    max-width: min(430px, calc(100vw - 28px));
    padding: 10px 14px;
    border: 1px solid #f59e0b;
    border-radius: 10px;
    background: #2b1d05;
    color: #fef3c7;
    box-shadow: 0 12px 30px rgba(0, 0, 0, .35);
    font: 600 12px/1.35 Arial, sans-serif;
    pointer-events: none;
  }
  #safra-preview-banner strong,
  #safra-preview-banner span {
    display: block;
  }
  #safra-preview-banner span {
    margin-top: 2px;
    color: #fde68a;
    font-weight: 400;
  }
</style>`;

function injectPreviewBanner(html) {
  if (html.includes('</body>')) {
    return html.replace('</body>', `${PREVIEW_BANNER}\n</body>`);
  }
  return `${html}\n${PREVIEW_BANNER}`;
}

function createPreviewApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Safra-Preview': 'isolated',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
        "form-action 'self'",
        "frame-ancestors 'none'"
      ].join('; ')
    });
    next();
  });

  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      return res.status(405).json({
        success: false,
        code: 'PREVIEW_READ_ONLY',
        error: 'Preview local somente leitura'
      });
    }
    return next();
  });

  app.get('/api/user-info', (req, res) => res.json(previewUser));
  app.get('/api/parametros', (req, res) => res.json({
    success: true,
    data: previewParameters
  }));
  app.get('/api/users-permissions', (req, res) => res.json({
    success: true,
    data: previewUsers
  }));
  app.get('/api/env-status', (req, res) => res.json({
    env: 'PREVIEW LOCAL',
    key: 'PREVIEW'
  }));
  app.get('/api/dashboard-gestor/inicial', (req, res) => res.json(previewDashboard));
  app.get('/api/dashboard-gestor/paginado', (req, res) => res.json({
    page: 1,
    pageSize: Number(req.query.pageSize || 50),
    total: 0,
    totalPages: 1,
    rows: []
  }));
  app.get('/api/dashboard-gestor/substituicoes', (req, res) => res.json({
    total: 0,
    rows: []
  }));
  app.get('/api/carteira-rca/:rca', (req, res) => res.json({
    success: true,
    data: []
  }));
  app.get('/api/listar-rcas-disponiveis', (req, res) => res.json({
    success: true,
    data: []
  }));
  app.get('/api/comparar-carteiras/correcao-cadastro-logs', (req, res) => res.json({
    success: true,
    data: [],
    resumo: {}
  }));

  app.use('/api', (req, res) => res.status(404).json({
    success: false,
    code: 'PREVIEW_API_NOT_MOCKED',
    error: 'Rota nao simulada no preview local'
  }));

  app.get('/auth/google', (req, res) => res.redirect('/'));
  app.get('/auth/logout', (req, res) => res.redirect('/login.html'));

  PAGE_ROUTES.forEach((fileName, route) => {
    app.get(route, (req, res, next) => {
      try {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, fileName), 'utf8');
        res.type('html').send(injectPreviewBanner(html));
      } catch (error) {
        next(error);
      }
    });
  });

  app.use(express.static(PUBLIC_DIR, {
    index: false,
    etag: false,
    lastModified: false
  }));

  app.use((req, res) => res.status(404).type('text').send('Pagina nao encontrada no preview local.'));

  return app;
}

function startPreviewServer({ port = PREVIEW_PORT, logger = console } = {}) {
  const app = createPreviewApp();
  const server = app.listen(port, PREVIEW_HOST, () => {
    logger.log('');
    logger.log('Safra Klass - PREVIEW LOCAL ISOLADO');
    logger.log(`Acesse: http://${PREVIEW_HOST}:${port}/configuracoes`);
    logger.log('Dados simulados. Oracle, PostgreSQL, Bitrix e IA nao sao carregados.');
    logger.log('Todas as gravacoes estao bloqueadas.');
    logger.log('');
  });
  return server;
}

if (require.main === module) {
  const server = startPreviewServer();
  server.on('error', (error) => {
    console.error(`Falha ao iniciar preview: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  PREVIEW_HOST,
  PREVIEW_PORT,
  createPreviewApp,
  startPreviewServer
};

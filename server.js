require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const compression = require('compression');
// --- DependÃªncias de AutenticaÃ§Ã£o ---
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
// ------------------------------------
const PerformanceClientes = require('./performance-clientes');
const RotativoRepository = require('./rotativo-repository');
const ExcelJS = require('exceljs');
const dbSwitch = require('./db-switch');
const MovimentacaoCarteiraService = require('./movimentacao-carteira-service');
const cron = require('node-cron');
const RelatorioService = require('./relatorio-service');
const { createAutomaticExecutionRunner } = require('./automatic-execution-runner');
const { createWinthorCorrectionRunner } = require('./winthor-correction-runner');
const { createStartupCronOrchestrator } = require('./startup-cron-orchestrator');
const {
    EXECUTION_MODES,
    createExecutionPolicy,
    normalizeCronConfigForWrite,
    normalizeWinthorFixConfig
} = require('./execution-policy');
const WinthorCadastroCorrecaoService = require('./winthor-cadastro-correcao-service');
const BitrixService = require('./bitrix-service');

const app = express();
// Ajustei o default para 10001 conforme sua URI de redirecionamento
const PORT = process.env.PORT || 10001; 

// InstÃ¢ncia do RepositÃ³rio (que detÃ©m o Pool do Postgres)
const rotativoRepo = new RotativoRepository();
const bitrixService = new BitrixService(console);
const winthorCorrecaoService = new WinthorCadastroCorrecaoService({
  logger: console,
  pgPool: rotativoRepo.pool,
  bitrixService
});
const correctionRunner = createWinthorCorrectionRunner({
  paramsRepository: rotativoRepo,
  correctionService: winthorCorrecaoService,
  logger: console
});

const SubstituicaoCarteiraService = require('./substituicao-carteira-service');

// ==================================================================
// 0. INICIALIZAÃ‡ÃƒO DA TABELA DE USUÃRIOS (POSTGRES)
// ==================================================================
async function initAuthDB() {
    try {
        if (!rotativoRepo.pool) return;
        
        // 1. Cria a tabela se nÃ£o existir
        const query = `
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                google_id VARCHAR(255) UNIQUE, 
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255),
                photo VARCHAR(1200),
                is_admin BOOLEAN DEFAULT FALSE,
                is_config BOOLEAN DEFAULT FALSE,
                is_painel BOOLEAN DEFAULT FALSE,
                is_excel BOOLEAN DEFAULT FALSE,
                last_login TIMESTAMP DEFAULT NOW(),
                created_at TIMESTAMP DEFAULT NOW()
            );
        `;
        await rotativoRepo.pool.query(query);

        // 2. CORREÃ‡ÃƒO DE BANCO ANTIGO: Tenta adicionar a restriÃ§Ã£o UNIQUE no email
        // Se a tabela foi criada antes da atualizaÃ§Ã£o, ela nÃ£o tem essa regra.
        try {
            await rotativoRepo.pool.query('ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email)');
            console.log('🔧 Correção aplicada: coluna email agora é única.');
        } catch (err) {
            // Se der erro, Ã© porque jÃ¡ existe ou hÃ¡ duplicatas. Ignora.
        }

        console.log('✅ Tabela [users] verificada e pronta.');
    } catch (err) {
        console.error('❌ Erro ao inicializar tabela users:', err);
    }
}
// Chama a criaÃ§Ã£o da tabela ao iniciar
initAuthDB();
// ==================================================================
// 1. CONFIGURAÃ‡ÃƒO DE ACESSO (SUPER ADMINS - HARDCODED)
// ==================================================================
const EMAILS_GESTORES = [
    'wagner@safradistribuidor.com.br',
    'gerente.mkt@safrairrigacao.com.br',
    'tiago.marques@safradistribuidor.com.br',
    'taine@safradistribuidor.com.br',
    'weberton@safradistribuidor.com.br',
    'max.reis@safradistribuidor.com.br',
    'carlos.lahoz@safradistribuidor.com.br',
    'ti.tecnico@safrairrigacao.com.br'
];

// ConfiguraÃ§Ã£o da SessÃ£o
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 horas
}));

app.use(passport.initialize());
app.use(passport.session());

// --- LÃ“GICA DE BANCO DE DADOS NO PASSPORT ---

passport.serializeUser((user, done) => {
    done(null, user.id); 
});

passport.deserializeUser(async (id, done) => {
    try {
        const res = await rotativoRepo.pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (res.rows.length > 0) {
            done(null, res.rows[0]);
        } else {
            done(new Error('Usuário não encontrado'), null);
        }
    } catch (err) {
        done(err, null);
    }
});

function normalizeGooglePhotoUrl(rawPhoto) {
    const photo = String(rawPhoto || '').trim();
    if (!photo) return null;

    let normalized = photo;

    if (/googleusercontent\.com|googleapis\.com/i.test(normalized)) {
        normalized = normalized.replace(/=s\d+-c$/i, '=s256-c');
        normalized = normalized.replace(/=s\d+$/i, '=s256');
        normalized = normalized.replace(/([?&]sz=)\d+/i, '$1256');

        if (!/[?&]sz=\d+/i.test(normalized) && !/=s\d+/i.test(normalized)) {
            normalized += (normalized.includes('?') ? '&' : '?') + 'sz=256';
        }
    }

    return normalized;
}

function buildUserPhotoUrl(user) {
    const normalizedPhoto = normalizeGooglePhotoUrl(user?.photo);
    if (!normalizedPhoto) return null;

    const version = user?.last_login
        ? new Date(user.last_login).getTime()
        : Date.now();

    return `${normalizedPhoto}${normalizedPhoto.includes('?') ? '&' : '?'}v=${version}`;
}

async function syncGoogleUserToLocalProfile({ email, googleId, name, photo, isSuperAdmin }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedName = String(name || '').trim() || null;
    const normalizedPhoto = normalizeGooglePhotoUrl(photo);

    let res = await rotativoRepo.pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    let user = res.rows[0];

    if (user) {
        const updateRes = await rotativoRepo.pool.query(
            `UPDATE users
                SET email = $1,
                    google_id = $2,
                    name = COALESCE($3, name),
                    photo = COALESCE($4, photo),
                    last_login = NOW()
              WHERE id = $5
              RETURNING *`,
            [normalizedEmail, googleId, normalizedName, normalizedPhoto, user.id]
        );
        return updateRes.rows[0];
    }

    res = await rotativoRepo.pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [normalizedEmail]);
    user = res.rows[0];

    if (user) {
        const updateRes = await rotativoRepo.pool.query(
            `UPDATE users
                SET google_id = $1,
                    email = $2,
                    name = COALESCE($3, name),
                    photo = COALESCE($4, photo),
                    last_login = NOW()
              WHERE id = $5
              RETURNING *`,
            [googleId, normalizedEmail, normalizedName, normalizedPhoto, user.id]
        );
        return updateRes.rows[0];
    }

    const insertRes = await rotativoRepo.pool.query(
        `INSERT INTO users (google_id, email, name, photo, is_admin, last_login)
         VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
        [googleId, normalizedEmail, normalizedName, normalizedPhoto, isSuperAdmin]
    );

    return insertRes.rows[0];
}

// EstratÃ©gia Google
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_REDIRECT_URI || `http://172.16.29.207.nip.io:${PORT}/api/auth/google/callback`
  },
  async function(accessToken, refreshToken, profile, done) {
    try {
        const email = String(profile?.emails?.[0]?.value || '').trim().toLowerCase();
        const googleId = profile.id;
        const name = String(profile?.displayName || '').trim() || null;
        const photo = profile?.photos?.[0]?.value || null;

        if (!email) {
            throw new Error('Google não retornou um e-mail válido para este usuário.');
        }
        
        // Verifica se Ã© Super Admin (Hardcoded)
        const isSuperAdmin = EMAILS_GESTORES.includes(email);
        const user = await syncGoogleUserToLocalProfile({
            email,
            googleId,
            name,
            photo,
            isSuperAdmin
        });
        
        return done(null, user);
    } catch (err) {
        console.error('Erro no login Google:', err);
        return done(err, null);
    }
  }
));

// ==================================================================
// MIDDLEWARES DE SEGURANÃ‡A E PERMISSÃƒO
// ==================================================================

// Verifica apenas se estÃ¡ logado
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
    res.redirect('/login.html');
}

// Verifica PermissÃ£o EspecÃ­fica (Ou se Ã© Super Admin)
function checkPermission(req, res, next, dbColumn) {
    if (!req.isAuthenticated()) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
        return res.redirect('/login.html');
    }
    
    const email = req.user.email;
    const dbUser = req.user;

    // 1. Super Admin (Hardcoded) libera tudo
    if (EMAILS_GESTORES.includes(email)) return next();

    // 2. Admin no Banco libera tudo
    if (dbUser.is_admin === true) return next();

    // 3. PermissÃ£o EspecÃ­fica do Banco
    if (dbUser[dbColumn] === true) return next();

    // 4. Negado
    return res.status(403).json({ error: 'Acesso negado. Permissão insuficiente.' });
}

// DefiniÃ§Ã£o dos NÃ­veis de Acesso
const canAccessConfig = (req, res, next) => checkPermission(req, res, next, 'is_config');
const canAccessPainel = (req, res, next) => checkPermission(req, res, next, 'is_painel');
const canAccessExcel  = (req, res, next) => checkPermission(req, res, next, 'is_excel');

// Middleware Exclusivo para Gerenciar UsuÃ¡rios (Apenas Super Admins Hardcoded)
const onlySuperAdmin = (req, res, next) => {
    if (req.isAuthenticated() && EMAILS_GESTORES.includes(req.user.email)) {
        return next();
    }
    res.status(403).json({ error: 'Acesso restrito a Super Administradores.' });
};

// ==================================================================
// 2. MIDDLEWARES PADRÃƒO
// ==================================================================
app.use(compression({
  level: 6,
  threshold: 0,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(cors());
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ==================================================================
// 3. ROTAS DE AUTENTICAÃ‡ÃƒO
// ==================================================================

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/api/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  function(req, res) { res.redirect('/'); }
);

app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/login.html');
    });
});

app.get('/api/user-info', (req, res) => {
    if (!req.isAuthenticated()) return res.json({ logged: false });
    
    // Verifica se Ã© Super Admin Hardcoded
    const isSuper = EMAILS_GESTORES.includes(req.user.email);
    
    res.json({
        logged: true,
        name: req.user.name,
        email: req.user.email,
        photo: buildUserPhotoUrl(req.user),
        // Flags para o frontend saber o que mostrar
        isAdmin: (req.user.is_admin || isSuper),
        isConfig: (req.user.is_config || isSuper),
        isPainel: (req.user.is_painel || isSuper),
        isExcel: (req.user.is_excel || isSuper)
    });
});

// ==================================================================
// 4. ARQUIVOS ESTÃTICOS
// ==================================================================

app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));

app.use(async (req, res, next) => {
    if (req.path.endsWith('.html') && req.path !== '/login.html') {
        if (!req.isAuthenticated()) return res.redirect('/login.html');
    }
    next();
});

app.use(express.static('public', { maxAge: '1d', etag: false, lastModified: false }));

const metricsMiddleware = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`ðŸ“Š ${req.method} ${req.url} - ${duration}ms`);
    if (duration > 1000) console.warn(`âš ï¸  Slow Request: ${req.url} - ${duration}ms`);
  });
  next();
};
app.use(metricsMiddleware);

// ==================================================================
// 5. ROTAS DE PÃGINAS (HTML)
// ==================================================================

function sendHtmlNoCache(res, htmlFileName) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  return res.sendFile(path.join(__dirname, 'public', htmlFileName));
}

app.get('/', ensureAuthenticated, (req, res) => sendHtmlNoCache(res, 'index.html'));
app.get('/detalhes-cliente', ensureAuthenticated, (req, res) => sendHtmlNoCache(res, 'detalhes-cliente.html'));
app.get('/detalhes-rca', ensureAuthenticated, (req, res) => sendHtmlNoCache(res, 'detalhes-rca.html'));
app.get('/configuracoes', ensureAuthenticated, (req, res) => sendHtmlNoCache(res, 'config-parametros.html'));
app.get('/relatorio-gestores', ensureAuthenticated, (req, res) => sendHtmlNoCache(res, 'relatorio-gestores.html'));
app.get('/chave', ensureAuthenticated, (req, res) => sendHtmlNoCache(res, 'chave.html'));

// ==================================================================
// 6. ROTAS DA API DE NEGÃ“CIO
// ==================================================================

const apiCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; 
const AI_CHAT_BASE_URL = process.env.AI_CHAT_BASE_URL || 'https://aisafra.duckdns.org:30000';
const AI_CHAT_ENDPOINT = process.env.AI_CHAT_ENDPOINT || '/api/chat';
const AI_CHAT_MODEL = process.env.AI_CHAT_MODEL || 'ollama:glm-4.7-flash:latest';
const AI_CHAT_AGENT_ID = Number(process.env.AI_CHAT_AGENT_ID || 7) || 7;
const AI_CHAT_TIMEOUT_MS = Number(process.env.AI_CHAT_TIMEOUT_MS || 180000);
const AI_CHAT_MAX_TOKENS = Math.max(256, Math.min(Number(process.env.AI_CHAT_MAX_TOKENS || 6000), 8192));
const AI_CHAT_ALLOW_SELF_SIGNED = String(process.env.AI_CHAT_ALLOW_SELF_SIGNED || 'false').toLowerCase() === 'true';

function sanitizeAiHistory(history) {
  if (!Array.isArray(history)) return [];
  const cleaned = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-4)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, 1800),
    }));

  const deduped = [];
  for (const msg of cleaned) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) continue;
    deduped.push(msg);
  }

  return deduped;
}

function sanitizeContextObject(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, 2500);

  if (Array.isArray(value)) {
    return value.slice(0, 180).map((v) => sanitizeContextObject(v, depth + 1));
  }

  if (t === 'object') {
    const out = {};
    const entries = Object.entries(value).slice(0, 180);
    for (const [key, val] of entries) {
      out[key] = sanitizeContextObject(val, depth + 1);
    }
    return out;
  }

  return null;
}

function isGreetingLikeMessage(value) {
  const text = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return false;
  return [
    'oi',
    'ola',
    'opa',
    'e ai',
    'eae',
    'bom dia',
    'boa tarde',
    'boa noite',
  ].includes(text);
}

function buildAiContextForModel(context, message, history = []) {
  const raw = (context && typeof context === 'object') ? context : {};
  return raw;
}

function getLocalMaiaOpening() {
  return 'Oi! Sou a Maia, coach comercial do time Safra Irrigação. Me conta a situação: qual cliente, o que ele pediu ou o que tá travando? Com isso já te dou a estratégia e o script pra usar agora.';
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeRcaName(value) {
  let nome = String(value || '').replace(/\s+/g, ' ').trim();
  if (!nome || nome === '-') return null;
  nome = nome
    .replace(/\(?\d{2}\)?\s*\d{4,5}[-\s]?\d{4}\s*$/g, '')
    .replace(/\b\d{2}\s+\d{4,5}\s+\d{4}\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!nome || /^\d+$/.test(nome)) return null;
  return nome;
}

function applyClienteDestinatarioGuard(replyText, context = {}) {
  let out = String(replyText || '');
  if (!out) return out;

  const fantasia = String(context?.cliente?.fantasia || context?.cliente?.cliente || 'cliente').trim();
  if (!fantasia) return out;

  const vendorNames = [
    sanitizeRcaName(context?.vendedorResponsavel?.nome),
    sanitizeRcaName(context?.ultimoVendedorVenda?.nome),
  ].filter(Boolean);

  if (!vendorNames.length) return out;

  for (const nome of vendorNames) {
    const escapedName = escapeRegExp(nome);
    const greetingPatterns = [
      new RegExp(`\\b(Olá|Oi|Bom dia|Boa tarde|Boa noite)\\s+${escapedName}\\b`, 'gi'),
      new RegExp(`\\b(Olá|Oi|Bom dia|Boa tarde|Boa noite),?\\s*${escapedName}\\b`, 'gi'),
    ];
    for (const re of greetingPatterns) {
      out = out.replace(re, '$1, equipe da ' + fantasia);
    }
  }

  return out;
}

function extractTextFromContentNode(value, depth = 0) {
  if (depth > 7 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();

  if (Array.isArray(value)) {
    const merged = value
      .map((item) => extractTextFromContentNode(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
    return merged;
  }

  if (typeof value !== 'object') return '';

  const role = typeof value.role === 'string' ? value.role.toLowerCase() : '';
  if (role && !['assistant', 'tool'].includes(role)) return '';

  const stringKeys = [
    'answerText',
    'reply',
    'response',
    'answer',
    'output_text',
    'text',
    'content',
    'final',
    'completion',
    'resultText',
  ];

  for (const key of stringKeys) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key].trim();
    }
  }

  const nestedKeys = ['message', 'delta', 'data', 'result'];
  for (const key of nestedKeys) {
    const extracted = extractTextFromContentNode(value[key], depth + 1);
    if (extracted) return extracted;
  }

  const arrayKeys = ['content', 'parts', 'output'];
  for (const key of arrayKeys) {
    const extracted = extractTextFromContentNode(value[key], depth + 1);
    if (extracted) return extracted;
  }

  return '';
}

function extractAssistantTextFromMessages(messages) {
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (!item || String(item.role || '').toLowerCase() !== 'assistant') continue;
    const extracted = extractTextFromContentNode(item, 0);
    if (extracted) return extracted;
  }

  return '';
}

function safeJsonPreview(value, maxLen = 1200) {
  try {
    const raw = JSON.stringify(value);
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
  } catch (_) {
    const fallback = String(value || '');
    return fallback.length > maxLen ? `${fallback.slice(0, maxLen)}...` : fallback;
  }
}

function buildAiResponseDebugSnapshot(payload) {
  const firstChoice = Array.isArray(payload?.choices) ? payload.choices[0] || {} : {};
  const firstMessage = firstChoice?.message && typeof firstChoice.message === 'object' ? firstChoice.message : {};

  return {
    rootKeys: (payload && typeof payload === 'object') ? Object.keys(payload).slice(0, 20) : [],
    choicesLen: Array.isArray(payload?.choices) ? payload.choices.length : 0,
    answerTextLen: typeof payload?.answerText === 'string' ? payload.answerText.length : 0,
    contentLen: typeof payload?.content === 'string' ? payload.content.length : 0,
    outputTextLen: typeof payload?.output_text === 'string' ? payload.output_text.length : 0,
    firstChoiceKeys: (firstChoice && typeof firstChoice === 'object') ? Object.keys(firstChoice).slice(0, 20) : [],
    firstMessageRole: typeof firstMessage?.role === 'string' ? firstMessage.role : null,
    firstMessageKeys: (firstMessage && typeof firstMessage === 'object') ? Object.keys(firstMessage).slice(0, 20) : [],
    firstMessageContentType: Array.isArray(firstMessage?.content) ? 'array' : typeof firstMessage?.content,
    firstMessageContentLen: typeof firstMessage?.content === 'string'
      ? firstMessage.content.length
      : (Array.isArray(firstMessage?.content) ? firstMessage.content.length : 0),
    firstMessageReasoningLen: typeof firstMessage?.reasoning_content === 'string'
      ? firstMessage.reasoning_content.length
      : (typeof firstMessage?.reasoning === 'string' ? firstMessage.reasoning.length : 0),
    preview: safeJsonPreview(payload, 1400),
  };
}

function extractAiReply(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();

  if (typeof payload.reply === 'string' && payload.reply.trim()) return payload.reply.trim();
  if (typeof payload.response === 'string' && payload.response.trim()) return payload.response.trim();
  if (typeof payload.answer === 'string' && payload.answer.trim()) return payload.answer.trim();
  if (typeof payload.answerText === 'string' && payload.answerText.trim()) return payload.answerText.trim();
  if (typeof payload.content === 'string' && payload.content.trim()) return payload.content.trim();
  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text.trim();

  if (payload.data) {
    const nested = extractAiReply(payload.data);
    if (nested) return nested;
  }

  if (payload.result) {
    const nested = extractAiReply(payload.result);
    if (nested) return nested;
  }

  if (payload.message) {
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
    if (typeof payload.message.content === 'string' && payload.message.content.trim()) return payload.message.content.trim();
    const nested = extractTextFromContentNode(payload.message, 0);
    if (nested) return nested;
  }

  const assistantFromMessages = extractAssistantTextFromMessages(payload.messages);
  if (assistantFromMessages) return assistantFromMessages;

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const first = payload.choices[0] || {};
    if (typeof first.text === 'string' && first.text.trim()) return first.text.trim();
    if (typeof first.message?.content === 'string' && first.message.content.trim()) return first.message.content.trim();
    if (Array.isArray(first.message?.content)) {
      const chunks = first.message.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part?.text === 'string') return part.text;
          if (typeof part?.content === 'string') return part.content;
          return '';
        })
        .filter(Boolean);
      const merged = chunks.join('\n').trim();
      if (merged) return merged;
    }
    if (typeof first.delta?.content === 'string' && first.delta.content.trim()) return first.delta.content.trim();
    if (Array.isArray(first.delta?.content)) {
      const chunks = first.delta.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean);
      const merged = chunks.join('\n').trim();
      if (merged) return merged;
    }
    const nested = extractTextFromContentNode(first.message, 0) || extractTextFromContentNode(first.delta, 0);
    if (nested) return nested;
  }

  if (Array.isArray(payload.output)) {
    const chunks = [];
    for (const item of payload.output) {
      if (typeof item?.content === 'string') chunks.push(item.content);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') chunks.push(part.text);
        }
      }
    }
    const merged = chunks.join('\n').trim();
    if (merged) return merged;
  }

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();

  return '';
}

function extractAiFinishReason(payload) {
  if (!payload) return '';
  if (typeof payload.finish_reason === 'string') return payload.finish_reason;
  if (typeof payload.stop_reason === 'string') return payload.stop_reason;
  if (typeof payload.done_reason === 'string') return payload.done_reason;

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const first = payload.choices[0] || {};
    if (typeof first.finish_reason === 'string') return first.finish_reason;
    if (typeof first.stop_reason === 'string') return first.stop_reason;
  }

  return '';
}

function extractAiUsage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const usage = payload.usage || payload.x_groq?.usage || null;
  if (!usage || typeof usage !== 'object') return null;
  return {
    prompt_tokens: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : null,
    completion_tokens: Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : null,
    total_tokens: Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null,
  };
}

function parseTopLevelJsonObject(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;

  const candidates = [raw];
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    candidates.push(String(fenceMatch[1]).trim());
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {
      // ignora candidato inválido
    }
  }

  return null;
}

function extractJsonObjectsFromText(rawText) {
  const raw = String(rawText || '');
  if (!raw) return [];

  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth <= 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const segment = raw.slice(start, i + 1).trim();
        try {
          const parsed = JSON.parse(segment);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            objects.push(parsed);
          }
        } catch (_) {
          // ignora segmento inválido
        }
        start = -1;
      }
    }
  }

  return objects;
}

function scoreAiObjectShape(obj) {
  if (!obj || typeof obj !== 'object') return 0;

  let score = 0;

  // Chaves canônicas
  if (typeof obj.resumo === 'string' && obj.resumo.trim()) score += 6;
  if (Array.isArray(obj.produtos_sugeridos)) score += 8 + obj.produtos_sugeridos.length;
  if (Array.isArray(obj.abordagem_venda)) score += 4 + obj.abordagem_venda.length;
  if (Array.isArray(obj.acoes_melhorar_nota)) score += 4 + obj.acoes_melhorar_nota.length;
  if (Array.isArray(obj.proximos_passos)) score += 3 + obj.proximos_passos.length;
  if (Array.isArray(obj.alertas)) score += 2 + obj.alertas.length;
  if (Array.isArray(obj.lacunas_dados)) score += 2 + obj.lacunas_dados.length;

  // Aliases de pedido sugerido
  const ped = obj.pedidoSugerido || obj.pedido_sugerido;
  if (Array.isArray(ped)) score += 10 + ped.length * 2;
  else if (ped && typeof ped === 'object' && Array.isArray(ped.itens)) score += 10 + ped.itens.length * 2;

  // Aliases de ações
  const acoes = obj.acoesRecomendadas || obj.acoes_recomendadas || obj.acoesMelhoriaNota || obj.acoes_melhoria_nota;
  if (Array.isArray(acoes)) score += 4 + acoes.length;

  // Aliases de produtos
  const prods = obj.produtosSugeridos || obj.sugestoes || obj.itensSugeridos;
  if (Array.isArray(prods)) score += 8 + prods.length;

  // Aliases de resumo
  if (!obj.resumo && typeof (obj.observacoes || obj.conclusao || obj.analise) === 'string') score += 3;

  // Aliases de abordagem
  const abord = obj.abordagem || obj.argumentos || obj.estrategia || obj.dicas;
  if (Array.isArray(abord)) score += 3 + abord.length;

  // Aliases de passos
  const passos = obj.proximosPassos || obj.recomendacoes || obj.planoAcao;
  if (Array.isArray(passos)) score += 3 + passos.length;

  if (typeof obj.observacoes === 'string' && obj.observacoes.trim()) score += 3;
  if (obj.totalValorEstimado != null) score += 2;
  if (obj.valorEstimado != null) score += 2;

  // Pontuação base: qualquer objeto com 2+ chaves ganha 1 ponto
  const keys = Object.keys(obj);
  if (keys.length >= 2) score += 1;

  return score;
}

function parseAiJsonObject(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;

  // Primeiro tenta JSON de nível principal (mais confiável).
  const topLevel = parseTopLevelJsonObject(raw);
  if (topLevel) return topLevel;

  // Fallback: tenta recuperar objetos JSON internos (respostas concatenadas/quebradas).
  const parsedObjects = extractJsonObjectsFromText(raw);

  if (!parsedObjects.length) return null;

  const ranked = parsedObjects
    .map((obj) => ({ obj, score: scoreAiObjectShape(obj) }))
    .filter((entry) => entry.score >= 3) // evita aceitar sub-objetos pobres (ex.: item isolado)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return JSON.stringify(b.obj).length - JSON.stringify(a.obj).length;
    });

  if (!ranked.length) return null;

  return ranked[0]?.obj || null;
}

function normalizeAiText(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeAiStringArray(value, maxItems = 10, maxLen = 280) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = normalizeAiText(item, maxLen);
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeAiObjectArray(value, fields, maxItems = 8) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = {};
    let hasContent = false;
    for (const [key, maxLen] of Object.entries(fields)) {
      const text = normalizeAiText(item[key], maxLen);
      if (text) hasContent = true;
      entry[key] = text;
    }
    if (!hasContent) continue;
    out.push(entry);
    if (out.length >= maxItems) break;
  }
  return out;
}

function adaptAiStructuredAliases(rawObject) {
  if (!rawObject || typeof rawObject !== 'object') return rawObject;

  // ===== Helpers =====
  const pickFirst = (...keys) => {
    for (const k of keys) {
      const val = rawObject[k];
      if (val !== undefined && val !== null && val !== '') return val;
    }
    return undefined;
  };

  const pickFirstArray = (...keys) => {
    for (const k of keys) {
      const val = rawObject[k];
      if (Array.isArray(val) && val.length) return val;
    }
    return [];
  };

  const pickFirstString = (...keys) => {
    for (const k of keys) {
      const val = rawObject[k];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return '';
  };

  const toStringArray = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) return val.map((v) => typeof v === 'string' ? v : (v?.texto || v?.descricao || v?.titulo || v?.acao || JSON.stringify(v))).filter(Boolean);
    if (typeof val === 'string') return [val];
    return [];
  };

  // ===== 1) Resumo =====
  let resumo = pickFirstString(
    'resumo', 'resumo_geral', 'resumoGeral',
    'observacoes', 'observacao',
    'conclusao', 'analise', 'analise_geral', 'comentario',
    'resposta', 'mensagem', 'message', 'summary'
  );

  // ===== 2) Produtos sugeridos / Pedido sugerido =====
  let pedidoItens = [];
  let pedidoMeta = {};

  // Tentar extrair de várias chaves
  const candidatoPedido = pickFirst(
    'pedidoSugerido', 'pedido_sugerido',
    'produtos_sugeridos', 'produtosSugeridos',
    'sugestoes', 'sugestoesProdutos', 'sugestoes_produtos',
    'itensSugeridos', 'itens_sugeridos'
  );

  if (Array.isArray(candidatoPedido)) {
    pedidoItens = candidatoPedido;
  } else if (candidatoPedido && typeof candidatoPedido === 'object') {
    pedidoItens = Array.isArray(candidatoPedido.itens) ? candidatoPedido.itens : [];
    pedidoMeta = candidatoPedido;
  }

  const produtos = pedidoItens.slice(0, 12).map((item) => {
    const qtd = Number(item?.qtdSugestao ?? item?.quantidadeSugestao ?? item?.quantidade ?? item?.qtd ?? NaN);
    const valorTotal = Number(item?.valorTotalEstimado ?? item?.valorTotal ?? item?.valor ?? NaN);
    const partsAcao = [];
    if (Number.isFinite(qtd) && qtd > 0) {
      partsAcao.push(`Sugerir ${qtd.toLocaleString('pt-BR')} un.`);
    }
    if (Number.isFinite(valorTotal) && valorTotal > 0) {
      partsAcao.push(`Valor ${valorTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`);
    }
    if (item?.codprod != null && String(item.codprod).trim()) {
      partsAcao.push(`COD ${String(item.codprod).trim()}`);
    }

    return {
      produto: item?.produto || item?.descricao || item?.nome || item?.titulo || '',
      motivo: item?.justificativa || item?.motivo || item?.razao || '',
      acao: partsAcao.join(' | ') || item?.acao || '',
    };
  }).filter((p) => p.produto);

  const isNotaMetricTitle = (title) => {
    const t = normalizeAiText(title, 120).toLowerCase();
    return ['faturamento', 'volume', 'pagamentos', 'pagamento', 'frequencia', 'frequência', 'atraso', 'desconto', 'mix', 'prazo', 'canal'].includes(t);
  };

  const productsToActions = [];
  const filteredProducts = [];
  for (const item of produtos) {
    const joined = `${item?.motivo || ''} ${item?.acao || ''}`.trim();
    const impactoMatch = joined.match(/impacto\s*[:\-]?\s*([+\-]?\d+[.,]?\d*\s*pts?)/i);
    const looksAction = isNotaMetricTitle(item?.produto) || /impacto\s*[:\-]/i.test(joined);

    if (looksAction) {
      productsToActions.push({
        acao: item?.produto || '',
        impacto: impactoMatch ? normalizeAiText(impactoMatch[1], 120) : '',
        detalhe: normalizeAiText(joined, 280),
      });
      continue;
    }

    filteredProducts.push(item);
  }

  // ===== 3) Abordagem de venda =====
  const abordagemRaw = pickFirst(
    'abordagem_venda', 'abordagem', 'argumentos',
    'estrategia', 'estrategias', 'dicas', 'dicas_venda',
    'como_abordar', 'comoAbordar', 'argumentos_venda'
  );
  const abordagem = toStringArray(abordagemRaw);

  // ===== 4) Ações para melhorar nota =====
  const acoesRaw = pickFirstArray(
    'acoes_melhorar_nota', 'acoesMelhorarNota',
    'acoesRecomendadas', 'acoes_recomendadas',
    'acoesMelhoriaNota', 'acoes_melhoria_nota',
    'acoes', 'recomendacoes_nota', 'melhorias'
  );

  const acoesMelhorarNotaRaw = acoesRaw.slice(0, 10).map((item) => {
    if (typeof item === 'string') return { acao: item, impacto: '', detalhe: '' };
    return {
      acao: item?.acao || item?.titulo || item?.title || '',
      impacto: item?.impacto || item?.impact || '',
      detalhe: item?.detalhe || item?.descricao || item?.description || item?.detalhamento || '',
    };
  }).filter((a) => a.acao || a.detalhe);

  const acoesMelhorarNota = [...productsToActions, ...acoesMelhorarNotaRaw]
    .filter((item) => item && (item.acao || item.detalhe))
    .slice(0, 14);

  // ===== 5) Próximos passos =====
  const passosRaw = pickFirst(
    'proximos_passos', 'proximosPassos',
    'passos', 'recomendacoes', 'acoes_imediatas',
    'plano_acao', 'planoAcao', 'next_steps'
  );
  const proximosPassos = toStringArray(passosRaw);

  // ===== 6) Alertas =====
  const alertasRaw = pickFirst(
    'alertas', 'atencao', 'avisos', 'warnings', 'riscos'
  );
  const alertas = toStringArray(alertasRaw);

  // ===== 7) Lacunas =====
  const lacunasRaw = pickFirst(
    'lacunas_dados', 'lacunas', 'dadosFaltantes', 'dados_faltantes'
  );
  const lacunas = toStringArray(lacunasRaw);

  // ===== 8) Valor estimado total =====
  const valorEstimadoTotal = Number(
    rawObject.totalValorEstimado ?? rawObject.valorEstimado ?? pedidoMeta.valorEstimado ?? pedidoMeta.totalValorEstimado ?? NaN
  );
  const passosExtra = [];
  if (Number.isFinite(valorEstimadoTotal) && valorEstimadoTotal > 0) {
    passosExtra.push(`Meta do pedido sugerido: ${valorEstimadoTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`);
  }

  // ===== 9) Resumo fallback do pedidoMeta =====
  if (!resumo && pedidoMeta.observacoes) resumo = String(pedidoMeta.observacoes).trim();
  if (!resumo && pedidoMeta.resumo) resumo = String(pedidoMeta.resumo).trim();

  const result = {
    resumo,
    produtos_sugeridos: filteredProducts,
    abordagem_venda: abordagem,
    acoes_melhorar_nota: acoesMelhorarNota,
    proximos_passos: [...proximosPassos, ...passosExtra],
    alertas,
    lacunas_dados: lacunas,
  };

  // ===== 10) Fallback genérico: se nada foi mapeado, varrer chaves =====
  const hasAnything = result.resumo
    || result.produtos_sugeridos.length
    || result.abordagem_venda.length
    || result.acoes_melhorar_nota.length
    || result.proximos_passos.length
    || result.alertas.length
    || result.lacunas_dados.length;

  if (!hasAnything) {
    return genericJsonToStructured(rawObject);
  }

  return result;
}

/**
 * Fallback genérico: converte QUALQUER JSON válido em seções
 * apresentáveis, sem depender de chaves específicas.
 */
function genericJsonToStructured(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const resumoParts = [];
  const cards = [];
  const listItems = [];
  const actionItems = [];

  const isProductLikeObject = (item) => {
    if (!item || typeof item !== 'object') return false;
    const hasProdCode = item.codprod !== undefined || item.codigoProduto !== undefined || item.codProduto !== undefined;
    const hasProdName = typeof item.produto === 'string' || typeof item.nomeProduto === 'string' || typeof item.item === 'string';
    return hasProdCode || hasProdName;
  };

  const isActionLikeObject = (item) => {
    if (!item || typeof item !== 'object') return false;
    const hasImpact = item.impacto !== undefined || item.impact !== undefined || item.pontos !== undefined;
    const hasActionName = typeof item.acao === 'string' || typeof item.titulo === 'string' || typeof item.title === 'string';
    return hasImpact || hasActionName;
  };

  for (const [key, value] of Object.entries(obj)) {
    const label = humanizeKey(key);

    if (typeof value === 'string' && value.trim()) {
      resumoParts.push(`**${label}:** ${value.trim()}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      resumoParts.push(`**${label}:** ${String(value)}`);
    } else if (Array.isArray(value) && value.length) {
      for (const item of value.slice(0, 12)) {
        if (typeof item === 'string') {
          listItems.push(`${label}: ${item}`);
        } else if (item && typeof item === 'object') {
          if (isProductLikeObject(item)) {
            const title = item.titulo || item.produto || item.nomeProduto || item.item || item.nome || item.title || label;
            const descParts = [];
            for (const [ik, iv] of Object.entries(item)) {
              if (['titulo', 'produto', 'nomeProduto', 'item', 'nome', 'title'].includes(ik)) continue;
              if (typeof iv === 'string' && iv.trim()) descParts.push(`**${humanizeKey(ik)}:** ${iv.trim()}`);
              else if (typeof iv === 'number') descParts.push(`**${humanizeKey(ik)}:** ${iv.toLocaleString('pt-BR')}`);
            }
            cards.push({ produto: title, motivo: descParts.join(' · '), acao: '' });
            continue;
          }

          if (isActionLikeObject(item)) {
            actionItems.push({
              acao: item.acao || item.titulo || item.title || label,
              impacto: item.impacto || item.impact || item.pontos || '',
              detalhe: item.detalhe || item.descricao || item.description || '',
            });
            continue;
          }

          // Objeto genérico em array vira texto de apoio
          const descParts = [];
          for (const [ik, iv] of Object.entries(item)) {
            if (typeof iv === 'string' && iv.trim()) descParts.push(`${humanizeKey(ik)}: ${iv.trim()}`);
            else if (typeof iv === 'number') descParts.push(`${humanizeKey(ik)}: ${iv.toLocaleString('pt-BR')}`);
          }
          if (descParts.length) listItems.push(`${label}: ${descParts.join(' | ')}`);
        }
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Objeto aninhado: extrair sub-campos como texto
      const subParts = [];
      for (const [sk, sv] of Object.entries(value)) {
        if (typeof sv === 'string' && sv.trim()) subParts.push(`${humanizeKey(sk)}: ${sv.trim()}`);
        else if (typeof sv === 'number') subParts.push(`${humanizeKey(sk)}: ${sv.toLocaleString('pt-BR')}`);
      }
      if (subParts.length) resumoParts.push(`**${label}:** ${subParts.join(' | ')}`);
    }
  }

  return {
    resumo: resumoParts.join('\n'),
    produtos_sugeridos: cards,
    abordagem_venda: listItems,
    acoes_melhorar_nota: actionItems,
    proximos_passos: [],
    alertas: [],
    lacunas_dados: [],
  };
}

function humanizeKey(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function normalizeAiStructuredReply(rawObject) {
  if (!rawObject || typeof rawObject !== 'object') return null;
  const source = adaptAiStructuredAliases(rawObject);
  if (!source || typeof source !== 'object') return null;
  const normalized = {
    resumo: normalizeAiText(source.resumo, 700),
    produtos_sugeridos: normalizeAiObjectArray(source.produtos_sugeridos, {
      produto: 160,
      motivo: 320,
      acao: 320,
    }, 8),
    abordagem_venda: normalizeAiStringArray(source.abordagem_venda, 10, 280),
    acoes_melhorar_nota: normalizeAiObjectArray(source.acoes_melhorar_nota, {
      acao: 200,
      impacto: 120,
      detalhe: 280,
    }, 10),
    proximos_passos: normalizeAiStringArray(source.proximos_passos, 10, 260),
    alertas: normalizeAiStringArray(source.alertas, 8, 240),
    lacunas_dados: normalizeAiStringArray(source.lacunas_dados, 8, 240),
  };

  const hasContent = Boolean(
    normalized.resumo ||
    normalized.produtos_sugeridos.length ||
    normalized.abordagem_venda.length ||
    normalized.acoes_melhorar_nota.length ||
    normalized.proximos_passos.length ||
    normalized.alertas.length ||
    normalized.lacunas_dados.length
  );

  return hasContent ? normalized : null;
}

function aiStructuredToText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const lines = [];

  if (payload.resumo) {
    lines.push(`Resumo: ${payload.resumo}`);
  }

  if (Array.isArray(payload.produtos_sugeridos) && payload.produtos_sugeridos.length) {
    lines.push('Produtos sugeridos:');
    payload.produtos_sugeridos.forEach((item, idx) => {
      const parts = [];
      if (item?.produto) parts.push(item.produto);
      if (item?.motivo) parts.push(`motivo: ${item.motivo}`);
      if (item?.acao) parts.push(`ação: ${item.acao}`);
      if (parts.length) lines.push(`${idx + 1}. ${parts.join(' | ')}`);
    });
  }

  if (Array.isArray(payload.abordagem_venda) && payload.abordagem_venda.length) {
    lines.push('Abordagem de venda:');
    payload.abordagem_venda.forEach((item) => lines.push(`- ${item}`));
  }

  if (Array.isArray(payload.acoes_melhorar_nota) && payload.acoes_melhorar_nota.length) {
    lines.push('Ações para melhorar nota:');
    payload.acoes_melhorar_nota.forEach((item) => {
      const parts = [];
      if (item?.acao) parts.push(item.acao);
      if (item?.impacto) parts.push(`impacto: ${item.impacto}`);
      if (item?.detalhe) parts.push(item.detalhe);
      if (parts.length) lines.push(`- ${parts.join(' | ')}`);
    });
  }

  if (Array.isArray(payload.proximos_passos) && payload.proximos_passos.length) {
    lines.push('Próximos passos:');
    payload.proximos_passos.forEach((item) => lines.push(`- ${item}`));
  }

  if (Array.isArray(payload.alertas) && payload.alertas.length) {
    lines.push('Alertas:');
    payload.alertas.forEach((item) => lines.push(`- ${item}`));
  }

  if (Array.isArray(payload.lacunas_dados) && payload.lacunas_dados.length) {
    lines.push(`Lacunas de dados: ${payload.lacunas_dados.join('; ')}`);
  }

  return lines.join('\n').trim();
}

function isLikelyTruncatedReply(reply, finishReason = '') {
  const text = String(reply || '').trim();
  if (!text) return false;

  const reason = String(finishReason || '').toLowerCase();
  if (reason && ['length', 'max_tokens', 'token_limit', 'max_new_tokens'].includes(reason)) {
    return true;
  }

  // Se o JSON de nível principal já estiver válido/completo, não peça continuação.
  if (parseTopLevelJsonObject(text)) return false;

  if (text.length < 320) return false;
  if (/[.!?…]$/.test(text)) return false;
  if (/```$/.test(text)) return true;
  if (/\|\s*$/.test(text)) return true;
  if (/:\s*$/.test(text)) return true;
  if (/R\$\s*\d[\d.,]*$/.test(text)) return true;

  return true;
}

function postJsonViaHttps(urlString, data, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(urlString);
    } catch (err) {
      reject(new Error(`URL inválida da IA: ${err.message}`));
      return;
    }

    const body = JSON.stringify(data ?? {});
    const request = https.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || 443,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      timeout: timeoutMs,
      rejectUnauthorized: !AI_CHAT_ALLOW_SELF_SIGNED,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (_) {
          parsed = { raw };
        }

        const status = Number(response.statusCode || 500);
        if (status < 200 || status >= 300) {
          const detail = typeof parsed?.error === 'string' ? parsed.error : raw.slice(0, 500);
          reject(new Error(`IA retornou status ${status}: ${detail}`));
          return;
        }

        resolve({ statusCode: status, data: parsed });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Timeout ao consultar IA (${timeoutMs}ms)`));
    });

    request.on('error', (err) => reject(err));
    request.write(body);
    request.end();
  });
}

app.post('/api/performance', ensureAuthenticated, async (req, res) => {
  try {
    const { DataIni, DataFim, CodFilial, ClienteCod, ClienteNome, Cnpj, Municipio, CodAtividade } = req.body;
    const cacheKey = JSON.stringify({
      apiVersion: 'v2_fantasia_cnpj_nome',
      DataIni,
      DataFim,
      CodFilial,
      ClienteCod,
      ClienteNome,
      Cnpj,
      Municipio,
      CodAtividade
    });
    const cached = apiCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return res.json({ success: true, data: cached.data, total: cached.data.length, cached: true });
    }
    const sistema = new PerformanceClientes();
    const resultados = await sistema.calcularPerformance({
      DataIni,
      DataFim,
      CodFilial: Array.isArray(CodFilial) ? CodFilial : [CodFilial],
      ClienteCod,
      ClienteNome,
      Cnpj,
      Municipio,
      CodAtividade
    });
    apiCache.set(cacheKey, { data: resultados, timestamp: Date.now() });
    if (apiCache.size > 100) apiCache.delete(apiCache.keys().next().value);
    res.json({ success: true, data: resultados, total: resultados.length, cached: false });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/env-status', ensureAuthenticated, (req, res) => {
    res.json({ env: dbSwitch.getCurrentEnvName(), key: dbSwitch.getCurrentEnvKey() });
});

app.post('/api/switch-env', canAccessConfig, async (req, res) => {
  try {
    const newEnv = await dbSwitch.switchEnv();
    if (typeof apiCache?.clear === 'function') apiCache.clear();
    if (typeof PerformanceClientes?.clearCache === 'function') PerformanceClientes.clearCache();
    if (typeof MovimentacaoCarteiraService?.clearCache === 'function') MovimentacaoCarteiraService.clearCache();
    if (typeof winthorCorrecaoService?.clearProcedureCache === 'function') {
      winthorCorrecaoService.clearProcedureCache();
    }
    res.json({ success: true, newEnv });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/detalhes-cliente', ensureAuthenticated, async (req, res) => {
  try {
    const { ClienteCod, DataIni, DataFim, CodFilial } = req.body;
    const sistema = new PerformanceClientes();
    const params = {
      DataIni,
      DataFim,
      CodFilial: Array.isArray(CodFilial) ? CodFilial : [CodFilial],
      ClienteCod,
    };

    const resultados = await sistema.calcularPerformance(params);
    const produtosInsights = await sistema.buscarInsightsProdutos(params);
    const pedidosInsights = await sistema.buscarPedidosInsights(params);

    res.json({
      success: true,
      data: resultados,
      total: resultados.length,
      produtosInsights,
      pedidosInsights,
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/ai/chat-cliente', ensureAuthenticated, async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ success: false, error: 'Mensagem obrigatória.' });
    }

    const safeHistory = sanitizeAiHistory(req.body?.history);
    if (
      safeHistory.length > 0 &&
      safeHistory[safeHistory.length - 1].role === 'user' &&
      safeHistory[safeHistory.length - 1].content.trim() === message
    ) {
      safeHistory.pop();
    }

    if (safeHistory.length === 0 && isGreetingLikeMessage(message)) {
      const reply = getLocalMaiaOpening();
      console.log('[AI Chat Cliente] Saudação inicial respondida localmente para evitar chamada desnecessária ao provider.');
      return res.json({
        success: true,
        reply,
        structured: null,
        providerStatus: 200,
        attempts: 0,
        finishReason: 'local_greeting',
      });
    }

    const rawContext = (req.body?.context && typeof req.body.context === 'object') ? req.body.context : {};
    const context = buildAiContextForModel(rawContext, message, safeHistory);

    const contextText = JSON.stringify(context, null, 2);
    const composedUserPrompt = [
      `Pergunta do consultor comercial: ${message.slice(0, 3000)}`,
      'CONTEXTO_CLIENTE_JSON:',
      contextText,
    ].join('\n\n');

    const messages = [
      ...safeHistory,
      { role: 'user', content: composedUserPrompt },
    ];

    const targetUrl = new URL(AI_CHAT_ENDPOINT, AI_CHAT_BASE_URL).toString();
    const basePayload = {
      model: AI_CHAT_MODEL,
      agente: AI_CHAT_AGENT_ID,
      temperature: 0.2,
      max_completion_tokens: AI_CHAT_MAX_TOKENS,
      max_tokens: AI_CHAT_MAX_TOKENS,
      stream: false,
      metadata: {
        source: 'indicador2_detalhes_cliente',
        user: req.user?.email || null,
      },
    };
    if (String(AI_CHAT_MODEL || '').toLowerCase().startsWith('ollama:')) {
      basePayload.think = true;
    }

    try {
      const payloadToLog = JSON.stringify({
        timestamp: new Date().toISOString(),
        route: '/api/ai/chat-cliente',
        targetUrl,
        contextChars: contextText.length,
        payload: { ...basePayload, messages },
      }, null, 2);
      console.log('[AI Chat Cliente] Payload enviado para IA:\n' + payloadToLog);
    } catch (logErr) {
      console.warn('[AI Chat Cliente] Falha ao serializar payload para log:', logErr.message);
    }

    let assembledReply = '';
    let providerStatus = 200;
    let finishReason = '';
    let attempts = 0;
    let continueMessages = messages;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      attempts = attempt;
      const payload = { ...basePayload, messages: continueMessages };
      const response = await postJsonViaHttps(targetUrl, payload, AI_CHAT_TIMEOUT_MS);
      providerStatus = response.statusCode;

      const chunk = extractAiReply(response.data);
      finishReason = extractAiFinishReason(response.data);
      const usage = extractAiUsage(response.data);
      const usageText = usage ? JSON.stringify(usage) : 'n/a';
      console.log(`[AI Chat Cliente] Resposta chunk ${attempt}: ${chunk ? chunk.length : 0} caracteres | finish_reason=${finishReason || 'n/a'} | usage=${usageText}`);

      if (!chunk) {
        console.warn('[AI Chat Cliente] Provider retornou sem texto extraivel. Snapshot:', buildAiResponseDebugSnapshot(response.data));
      }

      if (chunk) {
        assembledReply = assembledReply ? `${assembledReply}\n\n${chunk}` : chunk;
      }

      if (!chunk || !isLikelyTruncatedReply(chunk, finishReason)) {
        break;
      }

      console.warn(`[AI Chat Cliente] Detecção de resposta truncada. Solicitando continuação (tentativa ${attempt + 1}).`);
      continueMessages = [
        ...messages,
        { role: 'assistant', content: assembledReply.slice(-7000) },
        { role: 'user', content: 'Continue exatamente do ponto onde parou, sem repetir.' },
      ];
    }

    const replyRaw = String(assembledReply || '').trim();
    console.log(`[AI Chat Cliente] Resposta final consolidada: ${replyRaw.length} caracteres em ${attempts} tentativa(s).`);

    if (!replyRaw) {
      return res.status(502).json({
        success: false,
        error: 'A IA respondeu sem conteúdo de texto utilizável.',
      });
    }

    const reply = applyClienteDestinatarioGuard(replyRaw, context);
    if (reply !== replyRaw) {
      console.warn('[AI Chat Cliente] Guard de destinatário aplicado: nome de vendedor removido da saudação ao cliente.');
    }
    console.log('[AI Chat Cliente] Resposta em texto/markdown pronta para o front.');

    return res.json({
      success: true,
      reply,
      structured: null,
      providerStatus,
      attempts,
      finishReason: finishReason || null,
    });
  } catch (error) {
    console.error('[AI Chat Cliente] Erro ao consultar IA:', error);
    return res.status(502).json({
      success: false,
      error: `Falha ao consultar IA: ${error.message}`,
    });
  }
});

app.get('/api/carteira-rca/:rca', ensureAuthenticated, async (req, res) => {
  try {
    const dados = await rotativoRepo.listarCarteiraPorRca(req.params.rca);
    res.json({ success: true, data: dados });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao buscar dados.' }); }
});

// ===================================================================
// ENDPOINT: Buscar RCA atual do cliente direto no WinThor (PCCLIENT)
// ===================================================================
app.get('/api/rca-atual/:codcli', ensureAuthenticated, async (req, res) => {
  let connection;
  try {
    const { codcli } = req.params;

    const oracledb = require('oracledb');
    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }

    connection = await pool.getConnection();

    const sql = `
      SELECT 
        C.CODUSUR1  AS COD_RCA,
        U.NOME      AS NOME_RCA
      FROM PCCLIENT C
      LEFT JOIN PCUSUARI U ON U.CODUSUR = C.CODUSUR1
      WHERE C.CODCLI = :codcli
        AND C.DTEXCLUSAO IS NULL
    `;

    const result = await connection.execute(sql, [codcli], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    if (!result.rows || result.rows.length === 0) {
      return res.json({ success: true, codRca: null, nomeRca: '-' });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      codRca: row.COD_RCA,
      nomeRca: row.NOME_RCA || '-'
    });

  } catch (error) {
    console.error('[API] Erro ao buscar RCA atual:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
});

app.get('/api/dashboard-gestor', canAccessPainel, async (req, res) => {
  try {
    const dados = await rotativoRepo.obterDadosGerenciais();
    res.json(dados);
  } catch (error) { res.status(500).json({ error: 'Erro ao buscar dados gerenciais' }); }
});

app.get('/api/dashboard-gestor/inicial', canAccessPainel, async (req, res) => {
  try {
    const dados = await rotativoRepo.obterDadosGerenciaisIniciais();
    res.json(dados);
  } catch (error) {
    console.error('[API] Erro ao buscar dados iniciais do dashboard gestor:', error);
    res.status(500).json({ error: 'Erro ao buscar dados iniciais do dashboard gestor' });
  }
});

app.get('/api/dashboard-gestor/paginado', canAccessPainel, async (req, res) => {
  try {
    const tab = String(req.query.tab || '').trim();
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 50);
    const texto = String(req.query.texto || '').trim();
    const origem = String(req.query.origem || '').trim();
    const codigos = String(req.query.codigos || '')
      .split(',')
      .map((c) => Number(String(c).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const tabsPermitidas = new Set([
      'movimentacoes',
      'longo_prazo',
      'reclassificacoes',
      'protecoes',
      'bitrix'
    ]);

    if (!tab) {
      return res.status(400).json({ error: 'Parâmetro tab é obrigatório.' });
    }

    if (!tabsPermitidas.has(tab)) {
      return res.status(400).json({ error: `Tab inválida: ${tab}` });
    }

    const dados = await rotativoRepo.obterDadosGerenciaisPaginados({
      tab,
      page,
      pageSize,
      texto,
      codigos,
      origem
    });

    res.json(dados);
  } catch (error) {
    console.error('[API] Erro no dashboard gestor paginado:', error);
    res.status(500).json({ error: 'Erro ao buscar dados paginados do dashboard gestor' });
  }
});

app.post('/api/dashboard-gestor/protecoes/manual', canAccessPainel, async (req, res) => {
  try {
    const codcli = Number(req.body?.codcli);
    const diasProtecao = Number(req.body?.diasProtecao);

    if (!Number.isInteger(codcli) || codcli <= 0) {
      return res.status(400).json({ error: 'Código do cliente inválido.' });
    }

    if (!Number.isInteger(diasProtecao) || diasProtecao <= 0) {
      return res.status(400).json({ error: 'Dias de proteção inválido.' });
    }

    const row = await rotativoRepo.salvarProtecaoManual({ codcli, diasProtecao });

    res.json({
      success: true,
      message: `Proteção manual gravada para o cliente ${codcli} por ${diasProtecao} dias.`,
      row
    });
  } catch (error) {
    console.error('[API] Erro ao gravar proteção manual:', error);
    const status = /invalido|nao encontrado/i.test(String(error?.message || '')) ? 400 : 500;
    res.status(status).json({ error: error.message || 'Erro ao gravar proteção manual.' });
  }
});

app.get('/api/dashboard-gestor/substituicoes', canAccessPainel, async (req, res) => {
  try {
    const limit = Number(req.query.limit || 1000);
    const rows = await rotativoRepo.obterSubstituicoesRecentes(limit);
    res.json({ rows, total: rows.length });
  } catch (error) {
    console.error('[API] Erro ao buscar substituições para dashboard gestor:', error);
    res.status(500).json({ error: 'Erro ao buscar substituições do dashboard gestor' });
  }
});

// ===================================================================
// ENDPOINT: ComparaÃ§Ã£o Carteiras â€” Sistema (Postgres) vs WinThor (Oracle)
//
// LÃ³gica:
//   1. Busca o ÃšLTIMO estado registrado de cada cliente no Postgres
//      (tabela relatorio_carteira â€” snapshot do que o cron registrou)
//   2. Busca o estado ATUAL de todos os clientes no Oracle (PCCLIENT.CODUSUR1)
//   3. Compara e classifica cada cliente em:
//      - PERMANECEU  â†’ mesmo RCA nos dois sistemas
//      - MOVIDO      â†’ estava no Postgres com RCA X, agora estÃ¡ no Oracle com RCA Y
//      - NOVO        â†’ existe no Oracle mas nÃ£o tinha registro no Postgres (fora do escopo do cron)
//      - REMOVIDO    â†’ estava no Postgres mas nÃ£o existe mais no Oracle (excluÃ­do/zerado)
// ===================================================================
app.get('/api/comparar-carteiras', canAccessPainel, async (req, res) => {
  let oracleConn;
  try {
    const oracledb = require('oracledb');

    // --- 1. Snapshot do Postgres (Ãºltimo estado por cliente) ---
    const pgResult = await rotativoRepo.pool.query(`
      SELECT DISTINCT ON (codcli)
        codcli,
        cliente,
        fantasia,
        rca_codigo      AS rca_sistema,
        nivel,
        dias_sem_compra,
        status_situacao,
        data_processamento
      FROM relatorio_carteira
      ORDER BY codcli, data_processamento DESC
    `);

    const snapSistema = new Map();
    for (const row of pgResult.rows) {
      snapSistema.set(Number(row.codcli), row);
    }

    // Data do Ãºltimo processamento (para exibir no front)
    const datas = pgResult.rows.map(r => new Date(r.data_processamento));
    const ultimoProcessamento = datas.length
      ? new Date(Math.max(...datas)).toISOString()
      : null;

    // --- 2. Estado atual do WinThor (Oracle) ---
    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }
    oracleConn = await pool.getConnection();

    const oraResult = await oracleConn.execute(`
      SELECT
        C.CODCLI,
        C.CLIENTE,
        C.FANTASIA,
        C.CODUSUR1     AS RCA_ATUAL,
        C.CATEGORIA,
        U.NOME         AS NOME_RCA
      FROM PCCLIENT C
      LEFT JOIN PCUSUARI U ON U.CODUSUR = C.CODUSUR1
      WHERE C.DTEXCLUSAO IS NULL
        AND C.CODUSUR1 IS NOT NULL
    `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

    const snapOracle = new Map();
    for (const row of oraResult.rows) {
      snapOracle.set(Number(row.CODCLI), row);
    }

    // --- 3. ComparaÃ§Ã£o ---
    const resultado = [];

    // Percorre tudo que estava no sistema (Postgres)
    for (const [codcli, pg] of snapSistema) {
      const ora = snapOracle.get(codcli);
      const rcaSistema  = Number(pg.rca_sistema);

      if (!ora) {
        // Estava no sistema mas sumiu do Oracle (excluÃ­do ou zerado)
        resultado.push({
          codcli,
          cliente:           pg.cliente || pg.fantasia || '-',
          rca_sistema:       rcaSistema,
          nome_rca_sistema:  null,
          rca_winthor:       null,
          nome_rca_winthor:  null,
          nivel:             pg.nivel,
          dias_sem_compra:   pg.dias_sem_compra,
          status_sistema:    pg.status_situacao,
          data_snapshot:     pg.data_processamento,
          situacao:          'REMOVIDO'  // sumiu do Oracle
        });
        continue;
      }

      const rcaWinthor = Number(ora.RCA_ATUAL);

      if (rcaSistema === rcaWinthor) {
        // Mesmo RCA â€” permaneceu
        resultado.push({
          codcli,
          cliente:           ora.FANTASIA || ora.CLIENTE || pg.cliente || '-',
          rca_sistema:       rcaSistema,
          nome_rca_sistema:  ora.NOME_RCA || null,
          rca_winthor:       rcaWinthor,
          nome_rca_winthor:  ora.NOME_RCA || null,
          nivel:             pg.nivel || ora.CATEGORIA,
          dias_sem_compra:   pg.dias_sem_compra,
          status_sistema:    pg.status_situacao,
          data_snapshot:     pg.data_processamento,
          situacao:          'PERMANECEU'
        });
      } else {
        // RCA diferente â€” cliente foi movido apÃ³s o cron
        resultado.push({
          codcli,
          cliente:           ora.FANTASIA || ora.CLIENTE || pg.cliente || '-',
          rca_sistema:       rcaSistema,
          nome_rca_sistema:  null,
          rca_winthor:       rcaWinthor,
          nome_rca_winthor:  ora.NOME_RCA || null,
          nivel:             pg.nivel || ora.CATEGORIA,
          dias_sem_compra:   pg.dias_sem_compra,
          status_sistema:    pg.status_situacao,
          data_snapshot:     pg.data_processamento,
          situacao:          'MOVIDO'
        });
      }
    }

    // Percorre Oracle para capturar clientes NOVOS (nÃ£o estavam no snapshot do cron)
    for (const [codcli, ora] of snapOracle) {
      if (!snapSistema.has(codcli)) {
        resultado.push({
          codcli,
          cliente:           ora.FANTASIA || ora.CLIENTE || '-',
          rca_sistema:       null,
          nome_rca_sistema:  null,
          rca_winthor:       Number(ora.RCA_ATUAL),
          nome_rca_winthor:  ora.NOME_RCA || null,
          nivel:             ora.CATEGORIA || '-',
          dias_sem_compra:   null,
          status_sistema:    null,
          data_snapshot:     null,
          situacao:          'NOVO'
        });
      }
    }

    // --- 3.0. Classifica a origem da divergencia (Sistema x WinThor) ---
    // Se houver registro equivalente em movimentacao_carteira, tratamos como
    // movimentacao feita pelo proprio sistema (cron/substituicao/manual interno).
    // Sem esse registro, a divergencia e considerada "WinThor direto".
    const clientesMovidos = [...new Set(
      resultado
        .filter(item => item.situacao === 'MOVIDO')
        .map(item => Number(item.codcli))
        .filter(codcli => Number.isFinite(codcli) && codcli > 0)
    )];

    if (clientesMovidos.length) {
      try {
        const histSistemaResult = await rotativoRepo.pool.query(`
          SELECT
            codcli,
            rca_anterior,
            rca_novo,
            data_remanejamento,
            origem
          FROM movimentacao_carteira
          WHERE codcli = ANY($1::int[])
          ORDER BY codcli, data_remanejamento DESC
        `, [clientesMovidos]);

        const histPorCliente = new Map();
        for (const row of (histSistemaResult.rows || [])) {
          const codcli = Number(row.codcli);
          if (!Number.isFinite(codcli)) continue;
          if (!histPorCliente.has(codcli)) histPorCliente.set(codcli, []);
          histPorCliente.get(codcli).push(row);
        }

        const toleranciaMs = 10 * 60 * 1000; // margem p/ diferenca de horario

        for (const item of resultado) {
          if (item.situacao !== 'MOVIDO') continue;

          item.alteracao_rca_apenas_winthor = null;
          item.alteracao_rca_fonte = 'INDETERMINADO';
          item.alteracao_rca_sistema_origem = null;
          item.alteracao_rca_sistema_data = null;
          item.alteracao_rca_sistema_match_exato = false;

          const historico = histPorCliente.get(Number(item.codcli)) || [];
          if (!historico.length) continue;

          const snapshotMs = item.data_snapshot ? new Date(item.data_snapshot).getTime() : NaN;

          const historicoPosSnapshot = historico.filter(row => {
            const dtMov = row.data_remanejamento ? new Date(row.data_remanejamento).getTime() : NaN;
            if (Number.isNaN(snapshotMs) || Number.isNaN(dtMov)) return true;
            // A divergencia precisa ter acontecido depois do snapshot do cron.
            return dtMov >= (snapshotMs - toleranciaMs);
          });

          if (!historicoPosSnapshot.length) continue;

          const matchSistemaExato = historicoPosSnapshot.find(row => {
            const rcaAnterior = Number(row.rca_anterior);
            const rcaNovo = Number(row.rca_novo);
            return (
              rcaAnterior === Number(item.rca_sistema) &&
              rcaNovo === Number(item.rca_winthor)
            );
          });

          const sistemaConsiderado = matchSistemaExato || historicoPosSnapshot[0];
          if (!sistemaConsiderado) continue;

          let dataSistemaIso = null;
          if (sistemaConsiderado.data_remanejamento) {
            const dt = new Date(sistemaConsiderado.data_remanejamento);
            if (!Number.isNaN(dt.getTime())) dataSistemaIso = dt.toISOString();
          }

          item.alteracao_rca_apenas_winthor = false;
          item.alteracao_rca_fonte = 'SISTEMA';
          item.alteracao_rca_sistema_origem = sistemaConsiderado.origem || null;
          item.alteracao_rca_sistema_data = dataSistemaIso;
          item.alteracao_rca_sistema_match_exato = Boolean(matchSistemaExato);
        }
      } catch (histErr) {
        console.warn('[API] Aviso: falha ao cruzar movimentacao_carteira para classificar origem:', histErr.message);
      }
    }

    // --- 3.1. Auditoria da movimentaÃ§Ã£o no WinThor (quem alterou e quando) ---
    // Busca o Ãºltimo evento no PCLOGALTCLI para clientes MOVIDOS e resolve o nome
    // do usuÃ¡rio (matrÃ­cula) na tabela PCEMPR.

    if (clientesMovidos.length) {
      try {
        const auditoriaPorCliente = new Map();
        const chunkSize = 900; // Oracle limita IN em ~1000 itens

        for (let i = 0; i < clientesMovidos.length; i += chunkSize) {
          const chunk = clientesMovidos.slice(i, i + chunkSize);
          const binds = {};
          const placeholders = chunk.map((codcli, idx) => {
            const bindName = `codcli_${idx}`;
            binds[bindName] = codcli;
            return `:${bindName}`;
          }).join(', ');

          const auditSql = `
            SELECT
              CODCLI,
              MATRICULA,
              DTALTERACAO,
              ROTINA,
              OBS,
              CAMPO,
              VALORANT,
              VALORATU,
              CODFUNC,
              NOME_USUARIO_ALTEROU,
              NOME_GUERRA_USUARIO_ALTEROU
            FROM (
              SELECT
                L.CODCLI,
                L.MATRICULA,
                L.DTALTERACAO,
                L.ROTINA,
                L.OBS,
                L.CAMPO,
                L.VALORANT,
                L.VALORATU,
                L.CODFUNC,
                E.NOME        AS NOME_USUARIO_ALTEROU,
                E.NOME_GUERRA AS NOME_GUERRA_USUARIO_ALTEROU,
                ROW_NUMBER() OVER (
                  PARTITION BY L.CODCLI
                  ORDER BY
                    L.DTALTERACAO DESC,
                    L.MATRICULA DESC NULLS LAST
                ) AS RN
              FROM PCLOGALTCLI L
              LEFT JOIN PCEMPR E
                ON E.MATRICULA = L.MATRICULA
              WHERE L.CODCLI IN (${placeholders})
                AND UPPER(L.CAMPO) = 'CODUSUR1'
            )
            WHERE RN = 1
          `;

          const auditResult = await oracleConn.execute(
            auditSql,
            binds,
            {
              outFormat: oracledb.OUT_FORMAT_OBJECT,
              fetchInfo: {
                VALORANT: { type: oracledb.STRING },
                VALORATU: { type: oracledb.STRING }
              }
            }
          );

          for (const row of (auditResult.rows || [])) {
            const codcli = Number(row.CODCLI);
            if (!Number.isFinite(codcli)) continue;

            let dataAlteracao = null;
            if (row.DTALTERACAO) {
              const dt = row.DTALTERACAO instanceof Date
                ? row.DTALTERACAO
                : new Date(row.DTALTERACAO);
              if (!Number.isNaN(dt.getTime())) {
                dataAlteracao = dt.toISOString();
              }
            }

            auditoriaPorCliente.set(codcli, {
              alteracao_rca_matricula: row.MATRICULA != null ? Number(row.MATRICULA) : null,
              alteracao_rca_data: dataAlteracao,
              alteracao_rca_rotina: row.ROTINA || null,
              alteracao_rca_obs: row.OBS || null,
              alteracao_rca_campo: row.CAMPO || null,
              alteracao_rca_valor_ant: row.VALORANT ?? null,
              alteracao_rca_valor_atu: row.VALORATU ?? null,
              alteracao_rca_codfunc: row.CODFUNC ?? null,
              alteracao_rca_usuario_nome: row.NOME_USUARIO_ALTEROU || null,
              alteracao_rca_usuario_nome_guerra: row.NOME_GUERRA_USUARIO_ALTEROU || null
            });
          }
        }

        const toleranciaComparacaoFonteMs = 5 * 60 * 1000;

        for (const item of resultado) {
          if (item.situacao !== 'MOVIDO') continue;

          const audit = auditoriaPorCliente.get(Number(item.codcli)) || null;
          const snapshotMs = item.data_snapshot ? new Date(item.data_snapshot).getTime() : NaN;
          const sistemaMs = item.alteracao_rca_sistema_data ? new Date(item.alteracao_rca_sistema_data).getTime() : NaN;
          const auditMs = (audit && audit.alteracao_rca_data) ? new Date(audit.alteracao_rca_data).getTime() : NaN;

          const temSistemaPosSnapshot = Number.isFinite(sistemaMs);
          const temWinthorPosSnapshot = Number.isFinite(auditMs) && (
            Number.isNaN(snapshotMs) || auditMs >= (snapshotMs - toleranciaComparacaoFonteMs)
          );

          if (temSistemaPosSnapshot && !temWinthorPosSnapshot) {
            item.alteracao_rca_fonte = 'SISTEMA';
            item.alteracao_rca_apenas_winthor = false;
            continue;
          }

          if (!temSistemaPosSnapshot && temWinthorPosSnapshot) {
            item.alteracao_rca_fonte = 'WINTHOR';
            item.alteracao_rca_apenas_winthor = true;
            Object.assign(item, audit);
            continue;
          }

          if (temSistemaPosSnapshot && temWinthorPosSnapshot) {
            const winthorMaisRecente = auditMs > (sistemaMs + toleranciaComparacaoFonteMs);

            if (winthorMaisRecente) {
              item.alteracao_rca_fonte = 'WINTHOR';
              item.alteracao_rca_apenas_winthor = true;
              Object.assign(item, audit);
            } else {
              item.alteracao_rca_fonte = 'SISTEMA';
              item.alteracao_rca_apenas_winthor = false;
            }
            continue;
          }

          // Sem evidencia recente pos-snapshot nem no sistema nem no log do WinThor.
          // Para o usuario, isso tende a significar divergencia causada por rotina/cron
          // (ou atualizacao sem trilha suficiente), e NAO por acao manual recente no WinThor.
          if (Number.isFinite(snapshotMs)) {
            item.alteracao_rca_fonte = 'CRON';
            item.alteracao_rca_apenas_winthor = false;
            item.alteracao_rca_cron_inferido = true;
          } else {
            item.alteracao_rca_fonte = 'INDETERMINADO';
            item.alteracao_rca_apenas_winthor = null;
          }

          // Mantemos o ultimo log do WinThor apenas como contexto historico (se existir),
          // mas o front deve deixar claro que NAO explica a situacao atual.
          if (audit) {
            Object.assign(item, audit);
          }
        }
      } catch (auditErr) {
        console.warn('[API] Aviso: falha ao buscar auditoria PCLOGALTCLI/PCEMPR:', auditErr.message);
      }
    }

    // --- 4. Totalizadores por RCA (cards de resumo) ---
    // âœ… MELHORIA: contabiliza tambÃ©m movimentos de SAÃDA por RCA.
    // Antes, o cliente "MOVIDO" era contado sÃ³ no RCA destino (rca_winthor),
    // o que escondia nos cards/filtros quando ele saÃ­a de um RCA especÃ­fico.
    const porRca = {};
    const getResumoRca = (rcaRaw, nomeSugerido = null) => {
      const rca = Number(rcaRaw);
      if (!rca || Number.isNaN(rca)) return null;

      if (!porRca[rca]) {
        porRca[rca] = {
          rca,
          nome: nomeSugerido || `RCA ${rca}`,
          // Compatibilidade com front atual
          permaneceu: 0,
          movido: 0, // mantÃ©m "movido" como ENTRADA por movimento (comportamento legado)
          novo: 0,
          removido: 0,
          total: 0,
          // Novos campos para exibir impacto por RCA (origem e destino)
          movido_entrando: 0,
          movido_saindo: 0,
          total_relacionado: 0, // tudo que toca este RCA na comparaÃ§Ã£o
          total_sistema: 0,      // snapshot cron
          total_winthor: 0       // estado atual Oracle
        };
      } else if (nomeSugerido && (!porRca[rca].nome || porRca[rca].nome === `RCA ${rca}`)) {
        porRca[rca].nome = nomeSugerido;
      }

      return porRca[rca];
    };

    for (const item of resultado) {
      if (item.situacao === 'PERMANECEU') {
        const resumo = getResumoRca(item.rca_winthor ?? item.rca_sistema, item.nome_rca_winthor || item.nome_rca_sistema);
        if (!resumo) continue;
        resumo.permaneceu++;
        resumo.total++; // legado
        resumo.total_relacionado++;
        resumo.total_sistema++;
        resumo.total_winthor++;
        continue;
      }

      if (item.situacao === 'NOVO') {
        const resumo = getResumoRca(item.rca_winthor, item.nome_rca_winthor);
        if (!resumo) continue;
        resumo.novo++;
        resumo.total++; // legado
        resumo.total_relacionado++;
        resumo.total_winthor++;
        continue;
      }

      if (item.situacao === 'REMOVIDO') {
        const resumo = getResumoRca(item.rca_sistema, item.nome_rca_sistema);
        if (!resumo) continue;
        resumo.removido++;
        resumo.total++; // legado
        resumo.total_relacionado++;
        resumo.total_sistema++;
        continue;
      }

      if (item.situacao === 'MOVIDO') {
        const origem = getResumoRca(item.rca_sistema, item.nome_rca_sistema);
        const destino = getResumoRca(item.rca_winthor, item.nome_rca_winthor);

        if (origem) {
          origem.movido_saindo++;
          origem.total_relacionado++;
          origem.total_sistema++;
        }

        if (destino) {
          destino.movido_entrando++;
          destino.movido++; // mantÃ©m campo legado para o front existente
          destino.total++;  // mantÃ©m campo legado para o front existente
          destino.total_relacionado++;
          destino.total_winthor++;
        }
      }
    }

    res.json({
      ultimoProcessamento,
      totalSistema:   snapSistema.size,
      totalWinthor:   snapOracle.size,
      comparacao:     resultado,
      resumoPorRca:   Object.values(porRca).sort((a, b) => a.rca - b.rca)
    });

  } catch (err) {
    console.error('[API] Erro ao comparar carteiras:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (oracleConn) {
      try { await oracleConn.close(); } catch (_) {}
    }
  }
});

// ===================================================================
// ENDPOINT: Logs globais de correcao de cadastro WinThor (procedure)
// ===================================================================
app.get('/api/comparar-carteiras/correcao-cadastro-logs', canAccessPainel, async (req, res) => {
  try {
    await winthorCorrecaoService.garantirInfraestrutura();

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 120;

    const codcliRaw = Number(req.query.codcli);
    const filtrarPorCodcli = Number.isFinite(codcliRaw) && codcliRaw > 0;
    const codcli = filtrarPorCodcli ? Math.trunc(codcliRaw) : null;

    let logsResult;
    let resumoResult;

    if (filtrarPorCodcli) {
      [logsResult, resumoResult] = await Promise.all([
        rotativoRepo.pool.query(`
          SELECT
            id,
            exec_id,
            ambiente,
            codcli,
            cliente,
            fantasia,
            categoria_ant,
            categoria_nova,
            codatv1_ant,
            codatv1_novo,
            codrede_ant,
            codrede_novo,
            origem,
            alterado_em,
            payload
          FROM winthor_correcao_cadastro_log
          WHERE codcli = $1
          ORDER BY alterado_em DESC, id DESC
          LIMIT $2
        `, [codcli, limit]),
        rotativoRepo.pool.query(`
          SELECT
            COUNT(*)::INT AS total,
            COUNT(DISTINCT codcli)::INT AS clientes_afetados,
            COUNT(DISTINCT exec_id)::INT AS execucoes,
            MAX(alterado_em) AS ultimo_evento
          FROM winthor_correcao_cadastro_log
          WHERE codcli = $1
        `, [codcli])
      ]);
    } else {
      [logsResult, resumoResult] = await Promise.all([
        rotativoRepo.pool.query(`
          SELECT
            id,
            exec_id,
            ambiente,
            codcli,
            cliente,
            fantasia,
            categoria_ant,
            categoria_nova,
            codatv1_ant,
            codatv1_novo,
            codrede_ant,
            codrede_novo,
            origem,
            alterado_em,
            payload
          FROM winthor_correcao_cadastro_log
          ORDER BY alterado_em DESC, id DESC
          LIMIT $1
        `, [limit]),
        rotativoRepo.pool.query(`
          SELECT
            COUNT(*)::INT AS total,
            COUNT(DISTINCT codcli)::INT AS clientes_afetados,
            COUNT(DISTINCT exec_id)::INT AS execucoes,
            MAX(alterado_em) AS ultimo_evento
          FROM winthor_correcao_cadastro_log
        `)
      ]);
    }

    const resumoRow = resumoResult.rows?.[0] || {};
    const logs = (logsResult.rows || []).map((r) => ({
      id: r.id,
      exec_id: r.exec_id || null,
      ambiente: r.ambiente || null,
      codcli: r.codcli != null ? Number(r.codcli) : null,
      cliente: r.fantasia || r.cliente || null,
      categoria_ant: r.categoria_ant || null,
      categoria_nova: r.categoria_nova || null,
      codatv1_ant: r.codatv1_ant != null ? Number(r.codatv1_ant) : null,
      codatv1_novo: r.codatv1_novo != null ? Number(r.codatv1_novo) : null,
      codrede_ant: r.codrede_ant != null ? Number(r.codrede_ant) : null,
      codrede_novo: r.codrede_novo != null ? Number(r.codrede_novo) : null,
      origem: r.origem || null,
      alterado_em: r.alterado_em ? new Date(r.alterado_em).toISOString() : null,
      payload: r.payload || null
    }));

    res.json({
      success: true,
      tabelaExiste: true,
      filtro: filtrarPorCodcli ? { codcli } : null,
      resumo: {
        total: Number(resumoRow.total || 0),
        clientes_afetados: Number(resumoRow.clientes_afetados || 0),
        execucoes: Number(resumoRow.execucoes || 0),
        ultimo_evento: resumoRow.ultimo_evento ? new Date(resumoRow.ultimo_evento).toISOString() : null
      },
      logs
    });
  } catch (err) {
    // Tabela ainda nao criada (nenhuma execucao com log).
    if (err && err.code === '42P01') {
      return res.json({
        success: true,
        tabelaExiste: false,
        filtro: null,
        resumo: {
          total: 0,
          clientes_afetados: 0,
          execucoes: 0,
          ultimo_evento: null
        },
        logs: []
      });
    }
    console.error('[API] Erro ao buscar logs de correcao de cadastro:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro ao buscar logs.' });
  }
});

// ===================================================================
// ENDPOINT: Historico de alteracoes de RCA (Sistema + WinThor + Snapshots)
// ===================================================================
app.get('/api/comparar-carteiras/historico/:codcli', canAccessPainel, async (req, res) => {
  let oracleConn;
  try {
    const codcli = Number(req.params.codcli);
    if (!Number.isFinite(codcli) || codcli <= 0) {
      return res.status(400).json({ error: 'CODCLI inválido' });
    }

    const toPositiveInt = (value, fallback, max = 1000) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return fallback;
      return Math.min(Math.trunc(n), max);
    };

    const winthorLimit = toPositiveInt(req.query.winthor_limit, 30, 100);
    const winthorPageReq = toPositiveInt(req.query.winthor_page, 1, 100000);

    const oracledb = require('oracledb');

    const fixPgPromise = (async () => {
      try {
        return await rotativoRepo.pool.query(`
          SELECT
            id,
            exec_id,
            ambiente,
            codcli,
            cliente,
            fantasia,
            categoria_ant,
            categoria_nova,
            codatv1_ant,
            codatv1_novo,
            codrede_ant,
            codrede_novo,
            origem,
            alterado_em,
            payload
          FROM winthor_correcao_cadastro_log
          WHERE codcli = $1
          ORDER BY alterado_em DESC, id DESC
          LIMIT 80
        `, [codcli]);
      } catch (err) {
        // Tabela pode nÃ£o existir ainda em ambientes sem execuÃ§Ã£o da rotina.
        if (err && err.code === '42P01') return { rows: [] };
        throw err;
      }
    })();

    const [movPgResult, snapPgResult, fixPgResult] = await Promise.all([
      rotativoRepo.pool.query(`
        SELECT
          id,
          codcli,
          cliente,
          rca_anterior,
          rca_novo,
          data_remanejamento,
          origem,
          dias_sem_compra,
          payload
        FROM movimentacao_carteira
        WHERE codcli = $1
        ORDER BY data_remanejamento DESC, id DESC
        LIMIT 80
      `, [codcli]),
      rotativoRepo.pool.query(`
        SELECT
          data_processamento,
          codcli,
          cliente,
          fantasia,
          rca_codigo,
          rca_nome,
          nivel,
          status_situacao,
          dias_sem_compra
        FROM relatorio_carteira
        WHERE codcli = $1
        ORDER BY data_processamento DESC
        LIMIT 40
      `, [codcli]),
      fixPgPromise
    ]);

    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }
    oracleConn = await pool.getConnection();

    const oraCountResult = await oracleConn.execute(`
      SELECT
        COUNT(1) AS TOTAL,
        SUM(CASE WHEN UPPER(CAMPO) = 'CODUSUR1' THEN 1 ELSE 0 END) AS TOTAL_CODUSUR1,
        SUM(CASE WHEN UPPER(CAMPO) = 'CODUSUR1' THEN 0 ELSE 1 END) AS TOTAL_OUTROS
      FROM PCLOGALTCLI
      WHERE CODCLI = :codcli
    `, { codcli }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    const oraCountRow = oraCountResult.rows?.[0] || {};
    const totalWinthorLogs = Number(oraCountRow.TOTAL || 0) || 0;
    const totalWinthorRca = Number(oraCountRow.TOTAL_CODUSUR1 || 0) || 0;
    const totalWinthorCampos = Number(oraCountRow.TOTAL_OUTROS || 0) || 0;
    const totalPagesWinthor = Math.max(1, Math.ceil(totalWinthorLogs / winthorLimit));
    const winthorPage = Math.min(winthorPageReq, totalPagesWinthor);
    const startRow = ((winthorPage - 1) * winthorLimit) + 1;
    const endRow = startRow + winthorLimit - 1;

    const oraHistoryResult = await oracleConn.execute(`
      SELECT *
      FROM (
        SELECT
          X.*,
          ROW_NUMBER() OVER (
            ORDER BY
              X.DTALTERACAO DESC,
              X.CAMPO ASC,
              X.MATRICULA DESC NULLS LAST
          ) AS RN
        FROM (
          SELECT
            L.CODCLI,
            L.DTALTERACAO,
            L.MATRICULA,
            L.ROTINA,
            L.OBS,
            L.CAMPO,
            L.VALORANT,
            L.VALORATU,
            L.CODFUNC,
            E.NOME        AS NOME_USUARIO_ALTEROU,
            E.NOME_GUERRA AS NOME_GUERRA_USUARIO_ALTEROU
          FROM PCLOGALTCLI L
          LEFT JOIN PCEMPR E
            ON E.MATRICULA = L.MATRICULA
          WHERE L.CODCLI = :codcli
        ) X
      )
      WHERE RN BETWEEN :startRow AND :endRow
      ORDER BY RN
    `, { codcli, startRow, endRow }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchInfo: {
        OBS: { type: oracledb.STRING },
        VALORANT: { type: oracledb.STRING },
        VALORATU: { type: oracledb.STRING }
      }
    });

    const toIso = (v) => {
      if (!v) return null;
      const dt = v instanceof Date ? v : new Date(v);
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
    };

    const toNumMaybe = (v) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const eventos = [];

    for (const row of (movPgResult.rows || [])) {
      eventos.push({
        id: `pgmov-${row.id}`,
        fonte: 'SISTEMA',
        tipo: 'MOVIMENTACAO_SISTEMA',
        data: toIso(row.data_remanejamento),
        codcli,
        cliente: row.cliente || null,
        rca_de: row.rca_anterior != null ? Number(row.rca_anterior) : null,
        rca_para: row.rca_novo != null ? Number(row.rca_novo) : null,
        origem_sistema: row.origem || null,
        dias_sem_compra: row.dias_sem_compra ?? null,
        payload: row.payload || null
      });
    }

    for (const row of (snapPgResult.rows || [])) {
      eventos.push({
        id: `snap-${codcli}-${toIso(row.data_processamento) || Math.random().toString(36).slice(2)}`,
        fonte: 'SNAPSHOT',
        tipo: 'SNAPSHOT_CRON',
        data: toIso(row.data_processamento),
        codcli,
        cliente: row.fantasia || row.cliente || null,
        rca_snapshot: row.rca_codigo != null ? Number(row.rca_codigo) : null,
        rca_nome: row.rca_nome || null,
        nivel: row.nivel || null,
        status_situacao: row.status_situacao || null,
        dias_sem_compra: row.dias_sem_compra ?? null
      });
    }

    for (const row of (fixPgResult.rows || [])) {
      eventos.push({
        id: `pgfix-${row.id}`,
        fonte: 'SISTEMA',
        tipo: 'CORRECAO_CADASTRO_WINTHOR',
        data: toIso(row.alterado_em),
        codcli,
        cliente: row.fantasia || row.cliente || null,
        origem_sistema: row.origem || null,
        ambiente: row.ambiente || null,
        exec_id: row.exec_id || null,
        categoria_ant: row.categoria_ant || null,
        categoria_nova: row.categoria_nova || null,
        codatv1_ant: row.codatv1_ant != null ? Number(row.codatv1_ant) : null,
        codatv1_novo: row.codatv1_novo != null ? Number(row.codatv1_novo) : null,
        codrede_ant: row.codrede_ant != null ? Number(row.codrede_ant) : null,
        codrede_novo: row.codrede_novo != null ? Number(row.codrede_novo) : null,
        payload: row.payload || null
      });
    }

    for (const row of (oraHistoryResult.rows || [])) {
      const campoUpper = String(row.CAMPO || '').trim().toUpperCase();
      const isCodusur1 = campoUpper === 'CODUSUR1';
      eventos.push({
        id: `ora-${codcli}-${toIso(row.DTALTERACAO) || Math.random().toString(36).slice(2)}`,
        fonte: 'WINTHOR',
        tipo: isCodusur1 ? 'WINTHOR_CODUSUR1' : 'WINTHOR_CAMPO_CLIENTE',
        data: toIso(row.DTALTERACAO),
        codcli,
        campo: row.CAMPO || null,
        rca_de: isCodusur1 ? toNumMaybe(row.VALORANT) : null,
        rca_para: isCodusur1 ? toNumMaybe(row.VALORATU) : null,
        valor_ant_raw: row.VALORANT ?? null,
        valor_atu_raw: row.VALORATU ?? null,
        matricula: row.MATRICULA != null ? Number(row.MATRICULA) : null,
        usuario_nome: row.NOME_USUARIO_ALTEROU || null,
        usuario_nome_guerra: row.NOME_GUERRA_USUARIO_ALTEROU || null,
        rotina: row.ROTINA || null,
        obs: row.OBS || null,
        codfunc: row.CODFUNC ?? null
      });
    }

    const prioridadeFonte = { WINTHOR: 0, SISTEMA: 1, SNAPSHOT: 2 };
    eventos.sort((a, b) => {
      const ta = a.data ? new Date(a.data).getTime() : 0;
      const tb = b.data ? new Date(b.data).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return (prioridadeFonte[a.fonte] ?? 9) - (prioridadeFonte[b.fonte] ?? 9);
    });

    const clienteNome =
      snapPgResult.rows?.[0]?.fantasia ||
      snapPgResult.rows?.[0]?.cliente ||
      movPgResult.rows?.[0]?.cliente ||
      null;

    const resumo = {
      total: totalWinthorLogs
        + (movPgResult.rows?.length || 0)
        + (snapPgResult.rows?.length || 0)
        + (fixPgResult.rows?.length || 0),
      winthor: totalWinthorLogs,
      winthor_rca: totalWinthorRca,
      winthor_campos: totalWinthorCampos,
      sistema: (movPgResult.rows?.length || 0) + (fixPgResult.rows?.length || 0),
      snapshots: snapPgResult.rows?.length || 0
    };

    res.json({
      codcli,
      cliente: clienteNome,
      resumo,
      paginacao_winthor: {
        page: winthorPage,
        limit: winthorLimit,
        total: totalWinthorLogs,
        total_pages: totalPagesWinthor,
        has_prev: winthorPage > 1,
        has_next: winthorPage < totalPagesWinthor,
        from: totalWinthorLogs > 0 ? startRow : 0,
        to: totalWinthorLogs > 0 ? Math.min(endRow, totalWinthorLogs) : 0
      },
      eventos
    });
  } catch (err) {
    console.error('[API] Erro ao buscar histórico da comparação:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (oracleConn) {
      try { await oracleConn.close(); } catch (_) {}
    }
  }
});

// ===================================================================
// ENDPOINT: Gerar PDF da Carteira Real do WinThor (Download direto)
// ===================================================================
app.get('/api/gerar-pdf-carteira-winthor/:rca', canAccessPainel, async (req, res) => {
  try {
    const codRca = Number(req.params.rca);
    if (!codRca || isNaN(codRca)) {
      return res.status(400).json({ error: 'RCA inválido' });
    }

    const service = new RelatorioService(console);
    const resultado = await service.gerarPdfCarteiraAtualWinthor(codRca);

    const nomeArquivo = `Carteira_WinThor_RCA${codRca}_${new Date().toISOString().split('T')[0]}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.setHeader('Content-Length', resultado.pdfBuffer.length);
    res.send(resultado.pdfBuffer);

  } catch (err) {
    console.error('[API] Erro ao gerar PDF WinThor:', err.message);
    res.status(500).json({ error: 'Erro ao gerar PDF: ' + err.message });
  }
});

// ===================================================================
// ENDPOINT: Buscar clientes compatÃ­veis
// ===================================================================
app.post('/api/buscar-clientes-compativeis', ensureAuthenticated, async (req, res) => {
  try {
    const { rcaAtual, clientesRemover, distribuicaoDesejada, quantidade } = req.body;

    // ValidaÃ§Ãµes
    if (!rcaAtual || !clientesRemover || !distribuicaoDesejada || !quantidade) {
      return res.status(400).json({
        success: false,
        error: 'ParÃ¢metros incompletos'
      });
    }

    if (!Array.isArray(clientesRemover) || clientesRemover.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Lista de clientes inválida'
      });
    }

    // Cria o serviÃ§o
    const service = new SubstituicaoCarteiraService(console);

    // Busca clientes compatÃ­veis
    const resultado = await service.buscarClientesCompativeis({
      rcaAtual,
      clientesRemover,
      distribuicaoDesejada,
      quantidade
    });

    res.json({
      success: true,
      novosClientes: resultado.novosClientes,
      distribuicaoNovos: resultado.distribuicaoNovos
    });

  } catch (error) {
    console.error('[API] Erro ao buscar clientes compatíveis:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao buscar clientes compatíveis'
    });
  }
});

// ===================================================================
// ENDPOINT: Executar substituiÃ§Ã£o de carteira
// ===================================================================
app.post('/api/executar-substituicao', ensureAuthenticated, async (req, res) => {
  try {
    const { rcaAtual, clientesRemover, clientesAdicionar } = req.body;

    // ValidaÃ§Ãµes
    if (!rcaAtual || !clientesRemover) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetros incompletos (rcaAtual e clientesRemover obrigatórios)'
      });
    }

    if (!Array.isArray(clientesRemover) || clientesRemover.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Lista de clientes a remover inválida'
      });
    }

    // âœ… FIX: clientesAdicionar pode ser vazio
    const listaAdicionar = Array.isArray(clientesAdicionar) ? clientesAdicionar : [];

    console.log(`[API] Substituição: RCA=${rcaAtual}, Remover=${clientesRemover.length}, Adicionar=${listaAdicionar.length}`);

    // Cria o serviÃ§o
    const service = new SubstituicaoCarteiraService(console);

    // Executa a substituiÃ§Ã£o
    const resultado = await service.executarSubstituicao({
      rcaAtual,
      clientesRemover,
      clientesAdicionar: listaAdicionar
    });

    res.json({
      success: true,
      removidos: resultado.removidos,
      adicionados: resultado.adicionados,
      totalAtual: resultado.totalAtual
    });

  } catch (error) {
    console.error('[API] Erro ao executar substituição:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao executar substituição'
    });
  }
});

// ===================================================================
// ENDPOINT: Transferir clientes diretamente para RCA 118 (sem buscar novos)
// ===================================================================
app.post('/api/transferir-para-118', ensureAuthenticated, async (req, res) => {
  try {
    const { rcaAtual, clientesRemover } = req.body;

    if (!rcaAtual || !clientesRemover) {
      return res.status(400).json({ success: false, error: 'ParÃ¢metros incompletos' });
    }

    if (!Array.isArray(clientesRemover) || clientesRemover.length === 0) {
      return res.status(400).json({ success: false, error: 'Lista de clientes inválida' });
    }

    const service = new SubstituicaoCarteiraService(console);

    // Reutiliza executarSubstituicao com clientesAdicionar vazio
    const resultado = await service.executarSubstituicao({
      rcaAtual,
      clientesRemover,
      clientesAdicionar: []
    });

    res.json({
      success: true,
      removidos: resultado.removidos,
      adicionados: 0,
      totalAtual: resultado.totalAtual
    });

  } catch (error) {
    console.error('[API] Erro ao transferir para RCA 118:', error);
    res.status(500).json({ success: false, error: error.message || 'Erro ao transferir clientes' });
  }
});


app.get('/api/listar-rcas-disponiveis', ensureAuthenticated, async (req, res) => {
  try {
    const service = new SubstituicaoCarteiraService(console);
    
    // ðŸ†• Busca TODOS os vendedores ativos direto do WinThor
    const rcasDisponiveis = await service.listarTodosVendedoresAtivos();
    
    res.json({
      success: true,
      rcas: rcasDisponiveis
    });
    
  } catch (error) {
    console.error('[API] Erro ao listar RCAs:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao listar RCAs disponíveis'
    });
  }
});

// ===================================================================
// ENDPOINT: Buscar Carteira Atual do RCA (ESPECÃFICO para SubstituiÃ§Ã£o)
// ===================================================================
app.get('/api/substituicao/carteira-atual/:rca', ensureAuthenticated, async (req, res) => {
  try {
    const { rca } = req.params;
    
    // Instancia o SEU serviÃ§o novo, sem interferir no antigo
    const service = new SubstituicaoCarteiraService(console);
    
    // Usa o mÃ©todo que busca direto no PCCLIENT do WinThor
    const dados = await service.buscarCarteiraRca(rca);
    
    res.json({ success: true, data: dados });
    
  } catch (error) {
    console.error('[API] Erro ao buscar carteira para substituição:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao buscar dados da carteira para substituição.' 
    });
  }
});

// ==================================================================
// API: EXCEL (COM PERMISSÃƒO E LÃ“GICA COMPLETA)
// ==================================================================

app.get('/api/exportar-gestores-excel', canAccessExcel, async (req, res) => {
  try {
    const dados = await rotativoRepo.obterDadosGerenciais();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sistema Carteira Safra';
    workbook.created = new Date();

    const estilizarCabecalho = (worksheet) => {
        const row = worksheet.getRow(1);
        row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
        row.alignment = { vertical: 'middle', horizontal: 'center' };
        row.height = 25;
    };

    // ABA 1: VISÃƒO GERAL
    const sheet1 = workbook.addWorksheet('Visão Geral', { properties: { tabColor: { argb: 'FF007bff' } } });
    sheet1.columns = [
        { header: 'RCA', key: 'rca', width: 10 },
        { header: 'Total Clientes', key: 'total', width: 15 },
        { header: 'Ocupação (%)', key: 'ocupacao', width: 15 },
        { header: 'Ativos', key: 'ativos', width: 10 },
        { header: 'Alertas', key: 'alertas', width: 10 },
        { header: 'Risco', key: 'risco', width: 10 },
    ];
    dados.visaoGeral.forEach(item => {
        const ocupacao = ((item.total_clientes / 250) * 100).toFixed(1);
        sheet1.addRow({
            rca: parseInt(item.rca_codigo),
            total: parseInt(item.total_clientes),
            ocupacao: parseFloat(ocupacao) / 100,
            ativos: parseInt(item.ativos),
            alertas: parseInt(item.alertas),
            risco: parseInt(item.risco)
        });
    });
    sheet1.getColumn('ocupacao').numFmt = '0.0%';
    estilizarCabecalho(sheet1);

    // ABA 2: MOVIMENTAÃ‡Ã•ES
    const sheet2 = workbook.addWorksheet('Movimentações', { properties: { tabColor: { argb: 'FF28a745' } } });
    sheet2.columns = [
        { header: 'Data', key: 'data', width: 12 },
        { header: 'Cód. Cliente', key: 'codcli', width: 12 },
        { header: 'Cliente', key: 'cliente', width: 40 },
        { header: 'RCA Origem', key: 'rcaAnt', width: 12 },
        { header: 'RCA Destino', key: 'rcaNov', width: 12 },
        { header: 'Motivo', key: 'motivo', width: 25 },
    ];
    dados.movimentacoes.forEach(item => {
        sheet2.addRow({
            data: new Date(item.data_remanejamento),
            codcli: item.codcli,
            cliente: item.cliente,
            rcaAnt: item.rca_anterior,
            rcaNov: item.rca_novo,
            motivo: item.origem
        });
    });
    estilizarCabecalho(sheet2);

    // ABA 3: LONGO PRAZO
    const sheet3 = workbook.addWorksheet('Longo Prazo (118)', { properties: { tabColor: { argb: 'FF6f42c1' } } });
    sheet3.columns = [
        { header: 'Data', key: 'data', width: 12 },
        { header: 'Cliente', key: 'cliente', width: 40 },
        { header: 'Veio de (RCA)', key: 'rcaAnt', width: 15 },
        { header: 'Dias s/ Compra', key: 'dias', width: 15 },
        { header: 'Ult. Faturamento', key: 'valor', width: 20 },
    ];
    dados.movimentacoes.filter(i => i.rca_novo == 118).forEach(item => {
        let valor = 0;
        if (item.payload && item.payload.historicoFaturamento && item.payload.historicoFaturamento.length) {
            valor = item.payload.historicoFaturamento[0].vlLiquido;
        }
        sheet3.addRow({
            data: new Date(item.data_remanejamento),
            cliente: `${item.codcli} - ${item.cliente}`,
            rcaAnt: item.rca_anterior,
            dias: item.dias_sem_compra,
            valor: valor
        });
    });
    sheet3.getColumn('valor').numFmt = '"R$ " #,##0.00';
    estilizarCabecalho(sheet3);

    // ABA 4: UPGRADES
    const sheet4 = workbook.addWorksheet('Upgrades', { properties: { tabColor: { argb: 'FFffc107' } } });
    sheet4.columns = [
        { header: 'Data', key: 'data', width: 12 },
        { header: 'Cliente', key: 'cliente', width: 40 },
        { header: 'Nível Anterior', key: 'ant', width: 15 },
        { header: 'Nível Novo', key: 'nov', width: 15 },
        { header: 'Proteção Ativa?', key: 'prot', width: 15 },
    ];
    dados.upgrades.forEach(item => {
        sheet4.addRow({
            data: new Date(item.data_upgrade),
            cliente: `${item.codcli} - ${item.cliente}`,
            ant: item.classificacao_anterior,
            nov: item.classificacao_nova,
            prot: item.dias_restantes > 0 ? 'SIM' : 'NÃO'
        });
    });
    estilizarCabecalho(sheet4);

    // ABA 5: BLOQUEIOS BITRIX
    const sheet5 = workbook.addWorksheet('Bitrix & Exceções', { properties: { tabColor: { argb: 'FFdc3545' } } });
    sheet5.columns = [
        { header: 'RCA', key: 'rca', width: 10 },
        { header: 'Cliente', key: 'cliente', width: 40 },
        { header: 'Motivo Bloqueio', key: 'motivo', width: 30 },
        { header: 'Dias s/ Compra', key: 'dias', width: 15 },
    ];
    dados.bloqueiosBitrix.forEach(item => {
        sheet5.addRow({
            rca: item.rca_codigo,
            cliente: `${item.codcli} - ${item.fantasia || item.cliente}`,
            motivo: item.motivo_bloqueio,
            dias: item.dias_sem_compra
        });
    });
    estilizarCabecalho(sheet5);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Relatorio_Gestor.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Erro Excel:', error);
    res.status(500).send('Erro ao gerar Excel');
  }
});

app.post('/api/export-excel', canAccessExcel, async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || !Array.isArray(data)) {
      return res.status(400).json({ error: 'Dados inválidos para exportação' });
    }
    console.log(`[Excel] Gerando relatório consolidado com ${data.length} clientes...`);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sistema Performance';
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet('Performance Clientes');

    worksheet.columns = [
      { header: 'Cód.', key: 'CODCLI', width: 10 },
      { header: 'Cliente', key: 'CLIENTE', width: 40 },
      { header: 'Cidade', key: 'MUNICENT', width: 20 },
      { header: 'UF', key: 'ESTENT', width: 8 },
      { header: 'Vl. Líquido Total', key: 'VLLIQUIDO', width: 18, style: { numFmt: '"R$ "#,##0.00' } },
      { header: 'Faturamento', key: 'NOTA_AL', width: 12 },
      { header: 'Devolução', key: 'NOTA_AM', width: 12 },
      { header: 'Frete', key: 'NOTA_AN', width: 12 },
      { header: 'Mix', key: 'NOTA_AO', width: 12 },
      { header: 'Volume', key: 'NOTA_AP', width: 12 },
      { header: 'Prazo', key: 'NOTA_AQ', width: 12 },
      { header: 'Canal', key: 'NOTA_AR', width: 12 },
      { header: 'Desconto', key: 'NOTA_AS', width: 12 },
      { header: 'N. Fat.', key: 'NOTA_AT', width: 12 },
      { header: 'Atraso', key: 'NOTA_AU', width: 12 },
      { header: 'Média (6 Meses)', key: 'MEDIA_PONDERADA', width: 18, style: { font: { bold: true }, numFmt: '0.00' } },
      { header: 'Classificação', key: 'CLASSIFICACAO', width: 15 }
    ];

    data.forEach(item => {
        worksheet.addRow({
            CODCLI: item.CODCLI,
            CLIENTE: item.CLIENTE,
            MUNICENT: item.MUNICENT,
            ESTENT: item.ESTENT,
            VLLIQUIDO: parseFloat(item.VLLIQUIDO || 0),
            NOTA_AL: parseFloat(item.NOTA_AL || 0),
            NOTA_AM: parseFloat(item.NOTA_AM || 0),
            NOTA_AN: parseFloat(item.NOTA_AN || 0),
            NOTA_AO: parseFloat(item.NOTA_AO || 0),
            NOTA_AP: parseFloat(item.NOTA_AP || 0),
            NOTA_AQ: parseFloat(item.NOTA_AQ || 0),
            NOTA_AR: parseFloat(item.NOTA_AR || 0),
            NOTA_AS: parseFloat(item.NOTA_AS || 0),
            NOTA_AT: parseFloat(item.NOTA_AT || 0),
            NOTA_AU: parseFloat(item.NOTA_AU || 0),
            MEDIA_PONDERADA: parseFloat(item.MEDIA_PONDERADA || 0),
            CLASSIFICACAO: item.CLASSIFICACAO
        });
    });

    const headerRow = worksheet.getRow(1);
    headerRow.height = 25;
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0b233f' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Performance_${Date.now()}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Erro ao gerar Excel:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================
// 7. API DE CONFIGURAÃ‡Ã•ES (RESTRITO A IS_CONFIG)
// ==================================================================

app.get('/api/parametros', canAccessConfig, async (req, res) => {
    try {
        const params = await rotativoRepo.obterParametrosSistema();
        res.json({ success: true, data: params || {} });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/parametros', canAccessConfig, async (req, res) => {
    try {
        const novosValores = { ...req.body };
        try {
            novosValores.cron_config = normalizeCronConfigForWrite(novosValores.cron_config);
        } catch (validationError) {
            return res.status(400).json({
                success: false,
                error: 'Modo de execucao invalido. Use CLASSIFICACAO ou MOVIMENTACAO.'
            });
        }
        if (
            novosValores.cron_config.modo === EXECUTION_MODES.MOVIMENTACAO &&
            (!novosValores.dias_rotativa || !novosValores.fases_bitrix_bloqueio)
        ) {
            return res.status(400).json({ success: false, error: "Dados incompletos" });
        }
        await rotativoRepo.salvarParametrosSistema(novosValores);
        await configurarAgendamentoDinamico();
        await configurarAgendamentoCorrecaoCadastroWinthor();
        if (typeof MovimentacaoCarteiraService.clearCache === 'function') MovimentacaoCarteiraService.clearCache();
        res.json({ success: true, message: 'Parâmetros atualizados!' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/reload-cron', canAccessConfig, async (req, res) => {
    await configurarAgendamentoDinamico();
    await configurarAgendamentoCorrecaoCadastroWinthor();
    res.json({ success: true, message: 'Cron Recarregado.' });
});

app.post('/api/winthor/corrigir-cadastro-clientes', canAccessConfig, async (req, res) => {
  try {
    const forceRecreateProcedure = Boolean(req.body?.forceRecreateProcedure);
    const resultado = await correctionRunner.runCorrection({
      source: 'MANUAL',
      forceRecreateProcedure
    });
    res.json({ success: true, data: resultado });
  } catch (err) {
    console.error('[WinthorFix] Erro ao corrigir cadastro de clientes:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro ao executar correção.' });
  }
});

app.post('/api/winthor/rollback-correcao-legado', canAccessConfig, async (req, res) => {
  try {
    const execIds = Array.isArray(req.body?.exec_ids)
      ? req.body.exec_ids
      : (Array.isArray(req.body?.execIds) ? req.body.execIds : []);

    const codcliRaw = Number(req.body?.codcli);
    const codcli = Number.isFinite(codcliRaw) && codcliRaw > 0 ? Math.trunc(codcliRaw) : null;

    const dataInicioRaw = req.body?.data_inicio ?? req.body?.dataInicio ?? null;
    const dataFimRaw = req.body?.data_fim ?? req.body?.dataFim ?? null;

    const parseData = (raw, nomeCampo) => {
      if (raw == null || String(raw).trim() === '') return null;
      const dt = new Date(raw);
      if (Number.isNaN(dt.getTime())) {
        throw new Error(`${nomeCampo} inválida. Informe uma data válida.`);
      }
      return dt.toISOString();
    };

    let dataInicio = parseData(dataInicioRaw, 'data_inicio');
    let dataFim = parseData(dataFimRaw, 'data_fim');
    if (dataInicio && dataFim && new Date(dataInicio).getTime() > new Date(dataFim).getTime()) {
      const tmp = dataInicio;
      dataInicio = dataFim;
      dataFim = tmp;
    }

    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20000, Math.trunc(limitRaw))) : 5000;
    const executarCorrecaoPosRollback = req.body?.executarCorrecaoPosRollback !== false;

    const resultado = await correctionRunner.runRollback({
      source: 'MANUAL',
      execIds,
      codcli,
      dataInicio,
      dataFim,
      limit,
      executarCorrecaoPosRollback
    });

    res.json({ success: true, data: resultado });
  } catch (err) {
    console.error('[WinthorFix] Erro ao executar rollback legado:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro ao executar rollback legado.' });
  }
});

app.post('/api/clear-cache', canAccessConfig, (req, res) => {
  if (typeof apiCache?.clear === 'function') apiCache.clear();
  if (typeof PerformanceClientes?.clearCache === 'function') PerformanceClientes.clearCache();
  res.json({ success: true, message: 'Cache limpo' });
});

app.post('/api/disparar-relatorios-pdf', canAccessConfig, async (req, res) => {
    try {
        const params = await rotativoRepo.obterParametrosSistema();
        const policy = createExecutionPolicy(params?.cron_config);
        if (!policy.canSendPdf) {
            return res.status(403).json({
                success: false,
                error: 'Envio de PDF permitido somente com o cron ativo no modo MOVIMENTACAO.'
            });
        }
        if (!params?.pdf_config?.ativo) return res.json({ success: false, error: 'PDF Desativado' });

        (async () => {
            const service = new RelatorioService(console);
            const rcas = params?.rcas_rotativa || [];
            const targetId = params.pdf_config.modo_teste ? params.pdf_config.id_tester : null;
            for (const rca of rcas) {
                await service.processarRelatorioVendedor(rca, targetId);
                await new Promise(r => setTimeout(r, 2000));
            }
        })();
        res.json({ success: true, message: 'Disparo iniciado.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================================================================
// 8. API DE GESTÃƒO DE USUÃRIOS (SÃ“ SUPER ADMIN)
// ==================================================================

// Listar UsuÃ¡rios (FILTRO APLICADO: NÃ£o mostra Super Admins)
app.get('/api/users-permissions', onlySuperAdmin, async (req, res) => {
    try {
        const result = await rotativoRepo.pool.query('SELECT id, name, email, photo, is_config, is_painel, is_excel FROM users ORDER BY name ASC');
        
        // Remove quem estÃ¡ na lista de Super Admins Hardcoded para nÃ£o poluir a tabela
        const filteredUsers = result.rows.filter(u => !EMAILS_GESTORES.includes(u.email));
        
        res.json({ success: true, data: filteredUsers });
    } catch (error) { res.status(500).json({ success: false, error: 'Erro DB' }); }
});

// Adicionar UsuÃ¡rio (PrÃ©-Cadastro)
app.post('/api/users-permissions', onlySuperAdmin, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
        
        // Se tentar adicionar um email que jÃ¡ Ã© Super Admin, avisa
        if (EMAILS_GESTORES.includes(email)) return res.status(400).json({ error: 'Este usuário já é um Super Administrador.' });

        const existing = await rotativoRepo.pool.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
            [email]
        );

        if (existing.rows.length > 0) {
            await rotativoRepo.pool.query(
                "UPDATE users SET email = $1 WHERE id = $2",
                [email, existing.rows[0].id]
            );
        } else {
            await rotativoRepo.pool.query(
                "INSERT INTO users (email, google_id, name, created_at) VALUES ($1, NULL, 'Novo Usuário', NOW())", 
                [email]
            );
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Atualizar PermissÃ£o (Toggle)
app.patch('/api/users-permissions/:id', onlySuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { field, value } = req.body;
        const allowed = ['is_config', 'is_painel', 'is_excel'];
        if (!allowed.includes(field)) return res.status(400).json({ error: 'Campo inválido' });
        await rotativoRepo.pool.query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Remover UsuÃ¡rio
app.delete('/api/users-permissions/:id', onlySuperAdmin, async (req, res) => {
    try {
        await rotativoRepo.pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ==================================================================
// CRON E STARTUP
// ==================================================================

/**
 * Calcula o perÃ­odo de busca para o processamento automÃ¡tico.
 * âœ… FIX: Expandido para 12 meses para garantir que clientes inativos de longa data sejam "enxergados" pelo sistema.
 */
function calcularPeriodoUltimos12MesesParaMovCarteira() {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtualIndex = hoje.getMonth(); 
  const primeiroDiaMesAtual = new Date(anoAtual, mesAtualIndex, 1);
  const inicio = new Date(primeiroDiaMesAtual);
  inicio.setMonth(inicio.getMonth() - 12); // Janela de 12 meses
  const fim = new Date(anoAtual, mesAtualIndex, 0); // Ãšltimo dia do mÃªs anterior
  const pad = (n) => String(n).padStart(2, '0');
  const DataIni = `${pad(inicio.getDate())}/${pad(inicio.getMonth() + 1)}/${inicio.getFullYear()}`;
  const DataFim = `${pad(fim.getDate())}/${pad(fim.getMonth() + 1)}/${fim.getFullYear()}`;
  const competencia = `${fim.getFullYear()}-${pad(fim.getMonth() + 1)}`;
  return { DataIni, DataFim, competencia };
}

const automaticExecutionRunner = createAutomaticExecutionRunner({
  paramsRepository: rotativoRepo,
  createMovementService: () => new MovimentacaoCarteiraService(console),
  createReportService: () => new RelatorioService(console),
  calculatePeriod: calcularPeriodoUltimos12MesesParaMovCarteira,
  logger: console
});

let cronJobAtual = null;
let cronJobCorrecaoCadastroWinthor = null;

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'sim', 's'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'nao', 'não'].includes(normalized)) return false;
  return defaultValue;
}

async function obterConfigCorrecaoCadastroWinthor() {
  const enabledByEnv = parseBooleanEnv(process.env.WINTHOR_FIX_CADASTRO_ENABLED, true);
  const cronExprEnv = (process.env.WINTHOR_FIX_CADASTRO_CRON || '').trim();

  let enabledByParam = true;
  let intervaloMinutos = 15;
  try {
    const params = await rotativoRepo.obterParametrosSistema();
    const configFix = normalizeWinthorFixConfig(params?.winthor_fix_config);
    enabledByParam = configFix.ativo;
    intervaloMinutos = configFix.intervalo_minutos;
  } catch (err) {
    console.error('[WinthorFix] Erro ao ler parametros de configuracao:', err?.message || err);
  }

  const cronExpr = cronExprEnv || (intervaloMinutos === 1 ? '* * * * *' : `*/${intervaloMinutos} * * * *`);

  return {
    enabledByEnv,
    enabledByParam,
    enabled: enabledByEnv && enabledByParam,
    cronExpr,
    intervaloMinutos,
    source: cronExprEnv ? 'ENV' : 'PARAMETRO'
  };
}

async function configurarAgendamentoCorrecaoCadastroWinthor() {
  try {
    if (cronJobCorrecaoCadastroWinthor) {
      cronJobCorrecaoCadastroWinthor.stop();
      cronJobCorrecaoCadastroWinthor = null;
      console.log('[WinthorFix] Job anterior cancelado.');
    }

    const cfg = await obterConfigCorrecaoCadastroWinthor();
    if (!cfg.enabledByEnv) {
      console.log('[WinthorFix] Agendamento desativado por WINTHOR_FIX_CADASTRO_ENABLED=false');
      return;
    }
    if (!cfg.enabledByParam) {
      console.log('[WinthorFix] Agendamento desativado no painel de configuracoes (switch desligado).');
      return;
    }

    if (!cron.validate(cfg.cronExpr)) {
      console.error(`[WinthorFix] Expressao cron invalida: "${cfg.cronExpr}"`);
      return;
    }

    cronJobCorrecaoCadastroWinthor = cron.schedule(cfg.cronExpr, async () => {
      try {
        const resultado = await correctionRunner.runCorrection({ source: 'CRON' });
        if (resultado.skipped) {
          console.log(`[WinthorFix] Execucao agendada ignorada: ${resultado.reason}.`);
          return;
        }
        console.log(
          `[WinthorFix/${resultado.ambiente}] OK | Lidos: ${resultado.totalLidos} | Corrigidos: ${resultado.totalCorrigidos} | Logs: ${resultado.totalRegistrosLog || 0}`
        );
      } catch (err) {
        console.error('[WinthorFix] Erro na execucao agendada:', err);
      }
    });

    console.log(
      `[WinthorFix] Agendamento configurado com cron "${cfg.cronExpr}" (origem=${cfg.source}, intervalo=${cfg.intervaloMinutos}min).`
    );
  } catch (err) {
    console.error('[WinthorFix] Erro ao configurar agendamento:', err);
  }
}

async function executarCorrecaoCadastroWinthorNoStartupSeConfigurado() {
  const cfg = await obterConfigCorrecaoCadastroWinthor();
  const runOnStartup = parseBooleanEnv(process.env.WINTHOR_FIX_CADASTRO_RUN_ON_STARTUP, false);
  if (!cfg.enabledByEnv || !runOnStartup) return;

  try {
    const resultado = await correctionRunner.runCorrection({ source: 'STARTUP' });
    if (resultado.skipped) {
      console.log(`[WinthorFix] Execucao de startup ignorada: ${resultado.reason}.`);
      return;
    }
    console.log(
      `[WinthorFix/${resultado.ambiente}] Startup | Lidos: ${resultado.totalLidos} | Corrigidos: ${resultado.totalCorrigidos} | Logs: ${resultado.totalRegistrosLog || 0}`
    );
  } catch (err) {
    console.error('[WinthorFix] Erro na execucao de startup:', err);
  }
}

async function configurarAgendamentoDinamico() {
  try {
      const params = await rotativoRepo.obterParametrosSistema();
      if (cronJobAtual) {
          cronJobAtual.stop();
          cronJobAtual = null;
          console.log('[Agendador] Job anterior cancelado.');
      }
      if (!params || !params.cron_config || !params.cron_config.ativo || !params.cron_config.datetime) {
      console.log('[Agendador] Execução automática desativada ou inválida.');
          return;
      }
      const conf = params.cron_config;
      const dateObj = new Date(conf.datetime);
      const minute = dateObj.getMinutes();
      const hour = dateObj.getHours();
      const dayOfMonth = dateObj.getDate();
      const month = dateObj.getMonth() + 1;
      const dayOfWeek = dateObj.getDay();

      let cronExpr = '';
      let isOnce = false;

      switch (conf.frequency) {
          case 'once': cronExpr = `${minute} ${hour} ${dayOfMonth} ${month} *`; isOnce = true; break;
          case 'weekly': cronExpr = `${minute} ${hour} * * ${dayOfWeek}`; break;
          case 'biweekly': cronExpr = `${minute} ${hour} * * *`; break;
          case 'monthly': cronExpr = `${minute} ${hour} ${dayOfMonth} * *`; break;
          case 'bimonthly': cronExpr = `${minute} ${hour} ${dayOfMonth} */2 *`; break;
          case 'quarterly': cronExpr = `${minute} ${hour} ${dayOfMonth} */3 *`; break;
          case 'semiannual': cronExpr = `${minute} ${hour} ${dayOfMonth} */6 *`; break;
          case 'yearly': cronExpr = `${minute} ${hour} ${dayOfMonth} ${month} *`; break;
          default: console.log('[Agendador] Frequência desconhecida:', conf.frequency); return;
      }

      console.log(`[Agendador] Configurando: ${conf.frequency} | CRON: "${cronExpr}"`);

      const tarefa = async () => {
          if (conf.frequency === 'biweekly') {
              const hoje = new Date();
              if (hoje.getDate() !== dayOfMonth && hoje.getDate() !== (dayOfMonth + 15) % 30) return; 
          }
          console.log('🚀 [Agendador] Disparando execução automática!');
          try {
             const result = await automaticExecutionRunner.run();
             if (result.skipped) {
                 console.log(`[Agendador] Execução ignorada: ${result.reason}.`);
             }
          } catch (e) { console.error('[Agendador] Erro na execução:', e); }
      };

      cronJobAtual = cron.schedule(cronExpr, async () => {
          await tarefa();
          if (isOnce) {
              console.log('[Agendador] Job único finalizado. Cancelando recorrência.');
              if (cronJobAtual) cronJobAtual.stop();
          }
      });
      console.log('✅ [Agendador] Cron configurado com sucesso.');
  } catch (err) {
      console.error('[Agendador] Erro ao configurar:', err);
  }
}

const configurarAgendamentoPrincipalNoStartup = createStartupCronOrchestrator({
  initializeClassification: () => rotativoRepo.aplicarInicializacaoClassificacaoAtivaV1(),
  configureMainCron: configurarAgendamentoDinamico,
  logger: console
});

async function executarMovimentacaoCarteiraAoIniciarServidor() {
  if (process.env.MOV_CART_AUTO_RUN === 'false') {
    console.log('[MovCarteira] Execução automática desabilitada via MOV_CART_AUTO_RUN=false');
    return;
  }
  try {
    console.log('===================================================');
    console.log('[MovCarteira] Execução automática ao subir o servidor: INÍCIO (MODO TESTE)');
    console.log('===================================================');
    await dbSwitch.switchEnv();

    // ðŸ§ª ================= INÃCIO DO MOCK DE TESTE ================= ðŸ§ª
    // Lemos os parÃ¢metros que estÃ£o no banco agora
    const paramsAtuais = await rotativoRepo.obterParametrosSistema() || {};
    
    // ForÃ§amos a nossa nova regra de segmentos
    paramsAtuais.rca_segmento_map = {
        "10": [11, 12], // RCA 10 vai aceitar SÃ“ ServiÃ§os (11) e IndÃºstria (12)
        "110": [10]     // RCA 110 vai aceitar SÃ“ Revenda (10)
    };
    
    // Salvamos de volta no banco
    await rotativoRepo.salvarParametrosSistema(paramsAtuais);
    console.log('ðŸ§ª [TESTE] Regra de Segmentos (rca_segmento_map) injetada com sucesso!');
    // ðŸ§ª ========================================================== ðŸ§ª
    const service = new MovimentacaoCarteiraService(console);
    const DataIni  = process.env.MOV_CART_DATA_INI  || '01/01/2025';
    const DataFim  = process.env.MOV_CART_DATA_FIM  || '30/11/2025';
    const filiaisStr = process.env.MOV_CART_FILIAIS || '1,3,5,6';  // âœ… FIX #8: Incluindo filiais 5 e 6
    const CodFilial = filiaisStr.split(',').map(f => parseInt(f.trim(), 10)).filter(n => !Number.isNaN(n));

    await service.processarTodosClientesElegiveis({
      CodFilial, DataIni, DataFim,
      competencia: process.env.MOV_CART_COMPETENCIA || null,
      skipBitrixEtapa5: true, 
    });
    console.log('===================================================');
    console.log('[MovCarteira] Execução automática ao subir o servidor: FIM (Bitrix Etapa 5 ignorado)');
    console.log('===================================================');
  } catch (err) {
    console.error('❌ [MovCarteira] Erro no processamento automático ao iniciar o servidor:', err);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Acesse: http://localhost:${PORT}`);
  console.log(`💾 Modo: ${process.env.NODE_ENV || 'development'}`);
  void configurarAgendamentoPrincipalNoStartup();
  configurarAgendamentoCorrecaoCadastroWinthor();
  winthorCorrecaoService.garantirInfraestrutura().catch((err) => {
    console.error('[WinthorFix] Erro ao garantir infraestrutura de logs:', err?.message || err);
  });
  executarCorrecaoCadastroWinthorNoStartupSeConfigurado();
  //executarMovimentacaoCarteiraAoIniciarServidor();
});

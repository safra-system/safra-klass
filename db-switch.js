// db-switch.js
require('dotenv').config();

const ENV_CONFIGS = {
  PROD: {
    userEnv: 'ORA_USER',
    passwordEnv: 'ORA_PASS',
    connectStringEnv: 'ORA_CONN',
    name: 'PRODUCAO',
  },
  TEST: {
    userEnv: 'DEV_ORA_USER',
    passwordEnv: 'DEV_ORA_PASS',
    connectStringEnv: 'ORA_TEST_CONN',
    name: 'TESTE',
  },
};

let currentEnv = 'PROD';
let poolInstance = null;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

function getResolvedConfig() {
  const config = ENV_CONFIGS[currentEnv];
  return {
    user: requiredEnv(config.userEnv),
    password: requiredEnv(config.passwordEnv),
    connectString: requiredEnv(config.connectStringEnv),
    name: config.name,
  };
}

module.exports = {
  getConfig: () => ({
    ...getResolvedConfig(),
    poolMin: 2,
    poolMax: 10,
    poolTimeout: 60,
  }),

  getCurrentEnvName: () => ENV_CONFIGS[currentEnv].name,
  getCurrentEnvKey: () => currentEnv,

  switchEnv: async () => {
    if (poolInstance) {
      try {
        await poolInstance.close(10);
        console.log('Pool anterior fechado.');
      } catch (err) {
        console.error('Erro ao fechar pool antigo:', err);
      }
      poolInstance = null;
    }

    currentEnv = currentEnv === 'PROD' ? 'TEST' : 'PROD';
    console.log(`Ambiente alterado para: ${ENV_CONFIGS[currentEnv].name}`);
    return ENV_CONFIGS[currentEnv].name;
  },

  setPool: (pool) => {
    poolInstance = pool;
  },
  getPool: () => poolInstance,
};

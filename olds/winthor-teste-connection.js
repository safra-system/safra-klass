// winthor-teste-connection.js
// Atualização de RCA E CLASSIFICAÇÃO NO BANCO DE TESTE do WinThor
const oracledb = require('oracledb');

let poolTeste = null;

async function getPoolTeste(logger) {
  if (poolTeste) return poolTeste;

  const connectString = process.env.ORA_TEST_CONN;
  const user = process.env.DEV_ORA_USER;
  const password = process.env.DEV_ORA_PASS;
  // O schema é lido aqui, mas será setado na conexão
  // const schema = process.env.ORA_TEST_SCHEMA || process.env.ORA_SCHEMA; 

  if (!connectString || !user || !password) {
    throw new Error(
      '[WinthorTeste] ORA_TEST_CONN / DEV_ORA_USER / DEV_ORA_PASS não configurados'
    );
  }

  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

  poolTeste = await oracledb.createPool({
    user,
    password,
    connectString,
  });

  logger?.log?.(
    `[WinthorTeste] Pool Oracle TESTE criado (connectString=${connectString})`
  );

  return poolTeste;
}

/**
 * Atualiza o RCA (CODUSUR1) de um cliente no PCCLIENT do banco TESTE.
 */
async function atualizarRcaClienteTeste(codcli, novoRca, logger) {
  const pool = await getPoolTeste(logger);
  let conn;

  try {
    conn = await pool.getConnection();

    const schema = process.env.ORA_TEST_SCHEMA || process.env.ORA_SCHEMA;
    if (schema) {
      await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${schema}`);
    }

    const result = await conn.execute(
      `
        UPDATE PCCLIENT
           SET CODUSUR1 = :novoRca
         WHERE CODCLI   = :codcli
      `,
      { novoRca, codcli },
      { autoCommit: true }
    );

    logger?.log?.(
      `[WinthorTeste] PCCLIENT (TESTE) CODCLI=${codcli} → CODUSUR1=${novoRca} (rowsAffected=${result.rowsAffected})`
    );

    return result.rowsAffected || 0;
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (err) {
        logger?.error?.(
          '[WinthorTeste] Erro ao fechar conexão TESTE:',
          err && err.message ? err.message : err
        );
      }
    }
  }
}

/**
 * Atualiza a classificação (CODREDE e CATEGORIA) de um cliente no PCCLIENT do banco TESTE.
 * Registra a data da alteração com SYSDATE.
 */
async function atualizarClassificacaoCliente(codcli, novoCodRede, novaCategoria, logger) {
  const pool = await getPoolTeste(logger);
  let conn;

  try {
    conn = await pool.getConnection();

    const schema = process.env.ORA_TEST_SCHEMA || process.env.ORA_SCHEMA;
    if (schema) {
      await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${schema}`);
    }

    const sql = `
        UPDATE PCCLIENT 
        SET 
            CODREDE = :novoCodRede, 
            CATEGORIA = :novaCategoria
            
        WHERE CODCLI = :codcli
    `;

    const result = await conn.execute(
      sql,
      { novoCodRede, novaCategoria, codcli },
      { autoCommit: true }
    );

    logger?.log?.(
      `[WinthorTeste] PCCLIENT (TESTE) Classificação CODCLI=${codcli} ATUALIZADA para CODREDE=${novoCodRede}, CATEGORIA=${novaCategoria} (rowsAffected=${result.rowsAffected})`
    );

    return result.rowsAffected || 0;
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (err) {
        logger?.error?.(
          '[WinthorTeste] Erro ao fechar conexão TESTE:',
          err && err.message ? err.message : err
        );
      }
    }
  }
}

module.exports = {
  atualizarRcaClienteTeste,
  atualizarClassificacaoCliente,
};
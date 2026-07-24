// cliente-repository.js
// Busca dados cadastrais (Telefones, OBS4) no WinThor
// ✅ FIX #4: Migrado para usar dbSwitch (respeita ambiente TEST/PROD)

const oracledb = require('oracledb');
const dbSwitch = require('./db-switch');

class ClienteRepository {
  constructor() {
    // ✅ FIX #4: Não usa mais credenciais hardcoded
    // Usa dbSwitch para respeitar o ambiente atual (TEST/PROD)
  }

  // Helper para pegar o pool correto via dbSwitch
  async _getPool() {
    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }
    return pool;
  }

  /**
   * Retorna telefones e OBS4 do cliente
   */
  async buscarDadosCadastrais(codcli) {
    let connection;
    try {
      const pool = await this._getPool();
      connection = await pool.getConnection();
      
      // Seleciona campos de contato
      const sql = `
        SELECT 
          TELCOM,
          TELCELENT,
          TELCOB,
          TELENT,
          OBS4,
          CODATV1
        FROM PCCLIENT
        WHERE CODCLI = :codcli
      `;
      const result = await connection.execute(sql, [codcli], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (result.rows && result.rows.length > 0) {
        return result.rows[0];
      }
      return null;
    } catch (err) {
      console.error(`[ClienteRepository] Erro ao buscar dados cadastrais (${dbSwitch.getCurrentEnvName()}):`, err);
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (err) {
          // ignore
        }
      }
    }
  }
}

module.exports = ClienteRepository;
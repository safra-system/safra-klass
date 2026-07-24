// rca-repository.js
const oracledb = require('oracledb');
const dbSwitch = require('./db-switch'); 
const RotativoRepository = require('./rotativo-repository'); // Importa para ler configs

class RcaRepository {
  constructor(logger) {
    this.logger = logger || console;
    // Inicializa o repo de parâmetros
    try {
        this.rotativoRepo = new RotativoRepository(this.logger);
    } catch (e) {
        this.logger.error('[RcaRepo] Erro ao init RotativoRepo:', e);
    }
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

  // Helper para obter a lista de RCAs configurada ou usar default
  async _obterRcasConfigurados() {
      try {
          if (this.rotativoRepo) {
              const params = await this.rotativoRepo.obterParametrosSistema();
              if (params && params.rcas_rotativa && Array.isArray(params.rcas_rotativa) && params.rcas_rotativa.length > 0) {
                  return params.rcas_rotativa;
              }
          }
      } catch (err) {
          this.logger.error('[RcaRepo] Erro ao ler configs:', err.message);
      }
      // Fallback (Padrão antigo se não tiver config)
      return [10, 110]; 
  }

  /**
   * Busca vendedores e detalha a ocupação por nível
   */
  async buscarVendedoresDetalhados() {
    let conn;
    try {
      const pool = await this._getPool();
      conn = await pool.getConnection();
      
      // 1. Busca lista dinâmica do banco
      const rcasAlvo = await this._obterRcasConfigurados();
      
      // Validação de segurança
      if (!rcasAlvo || rcasAlvo.length === 0) throw new Error("Lista de RCAs vazia");
      
      const rcasString = rcasAlvo.join(',');

      const sql = `
        SELECT 
            U.CODUSUR,
            U.NOME,
            COUNT(C.CODCLI) AS TOTAL_ATUAL,
            SUM(CASE WHEN UPPER(TRIM(C.CATEGORIA)) = 'DIAMANTE' THEN 1 ELSE 0 END) AS QTD_DIAMANTE,
            SUM(CASE WHEN UPPER(TRIM(C.CATEGORIA)) = 'PLATINUM' THEN 1 ELSE 0 END) AS QTD_PLATINUM,
            SUM(CASE WHEN UPPER(TRIM(C.CATEGORIA)) = 'OURO'     THEN 1 ELSE 0 END) AS QTD_OURO,
            SUM(CASE WHEN UPPER(TRIM(C.CATEGORIA)) = 'PRATA'    THEN 1 ELSE 0 END) AS QTD_PRATA,
            SUM(CASE WHEN UPPER(TRIM(C.CATEGORIA)) = 'BRONZE'   THEN 1 ELSE 0 END) AS QTD_BRONZE,
            SUM(CASE WHEN C.CATEGORIA IS NULL THEN 1 ELSE 0 END) AS QTD_OUTROS
        FROM PCUSUARI U
        LEFT JOIN PCCLIENT C ON U.CODUSUR = C.CODUSUR1 AND C.DTEXCLUSAO IS NULL  -- ✅ FIX #5: Filtra clientes excluídos
        WHERE U.CODUSUR IN (${rcasString})
          AND (U.BLOQUEIO = 'N' OR U.BLOQUEIO IS NULL)
        GROUP BY U.CODUSUR, U.NOME
        ORDER BY U.CODUSUR ASC, TOTAL_ATUAL ASC  -- ✅ FIX #7: Prioridade para veteranos (CODUSUR menor = mais veterano)
      `;

      const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return result.rows;

    } catch (err) {
      this.logger.error(`[RcaRepo] Erro ao buscar vendedores detalhados: ${err.message}`);
      throw err;
    } finally {
      if (conn) {
        try { await conn.close(); } catch (e) { console.error(e); }
      }
    }
  }

  /**
   * Busca Simples (Atualizado para usar config também)
   */
  async buscarVendedoresElegiveis() {
    let conn;
    try {
      const pool = await this._getPool();
      conn = await pool.getConnection();
      
      const rcasAlvo = await this._obterRcasConfigurados();
      if (!rcasAlvo || rcasAlvo.length === 0) throw new Error("Lista de RCAs vazia");
      const rcasString = rcasAlvo.join(',');

      const sql = `
        SELECT 
            U.CODUSUR,
            U.NOME,
            COUNT(C.CODCLI) AS TOTAL_CLIENTES,
            (300 - COUNT(C.CODCLI)) AS VAGAS_DISPONIVEIS
        FROM PCUSUARI U
        LEFT JOIN PCCLIENT C ON U.CODUSUR = C.CODUSUR1 AND C.DTEXCLUSAO IS NULL  -- ✅ FIX #5: Filtra clientes excluídos
        WHERE U.CODUSUR IN (${rcasString})
          AND (U.BLOQUEIO = 'N' OR U.BLOQUEIO IS NULL)
        GROUP BY U.CODUSUR, U.NOME
        HAVING COUNT(C.CODCLI) < 300
        ORDER BY U.CODUSUR ASC, VAGAS_DISPONIVEIS DESC  -- ✅ FIX #7: Veteranos primeiro
      `;

      const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return result.rows;
    } catch (err) {
      this.logger.error(`[RcaRepo] Erro ao buscar vendedores simples: ${err.message}`);
      throw err;
    } finally {
      if (conn) {
        try { await conn.close(); } catch (e) { console.error(e); }
      }
    }
  }
}

module.exports = RcaRepository;
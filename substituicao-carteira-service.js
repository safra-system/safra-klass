// substituicao-carteira-service.js
const oracledb = require('oracledb');
const dbSwitch = require('./db-switch');
const { Pool } = require('pg');

class SubstituicaoCarteiraService {
  constructor(logger) {
    this.logger = logger || console;
    
    // Pool Postgres
    const pgConnString = process.env.POSTGRES_CONN_STRING;
    if (pgConnString) {
      this.pgPool = new Pool({ connectionString: pgConnString });
    }
  }

  // Helper para pegar pool Oracle
  async _getOraclePool() {
    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }
    return pool;
  }

  _getAllowedCodAtvForRca(rca) {
    const codRca = Number(rca);

    if (codRca === 10) return [11, 12];
    if (codRca === 110) return [10];

    return null;
  }

  _buildCodAtvFilterSql(rca, columnName = 'CODATV1') {
    const allowedCodAtv = this._getAllowedCodAtvForRca(rca);
    if (!allowedCodAtv || allowedCodAtv.length === 0) {
      return '';
    }

    return ` AND ${columnName} IN (${allowedCodAtv.join(',')})`;
  }

  _describeCodAtvRule(rca) {
    const allowedCodAtv = this._getAllowedCodAtvForRca(rca);
    if (!allowedCodAtv || allowedCodAtv.length === 0) {
      return null;
    }

    return `RCA ${Number(rca)} aceita apenas clientes com CODATV1 ${allowedCodAtv.join(', ')}`;
  }

  async _listarClientesIncompativeisParaRca(connection, rca, codclis = []) {
    const allowedCodAtv = this._getAllowedCodAtvForRca(rca);
    const ids = [...new Set((codclis || []).map(Number).filter(n => !isNaN(n) && n > 0))];

    if (!allowedCodAtv || allowedCodAtv.length === 0 || ids.length === 0) {
      return [];
    }

    const sql = `
      SELECT
        CODCLI,
        CLIENTE,
        FANTASIA,
        CODATV1
      FROM PCCLIENT
      WHERE CODCLI IN (${ids.join(',')})
        AND NVL(CODATV1, -1) NOT IN (${allowedCodAtv.join(',')})
    `;

    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    return result.rows || [];
  }

  /**
   * 🆕 Lista TODOS os vendedores ativos do WinThor
   */
  async listarTodosVendedoresAtivos() {
    let connection;
    try {
      this.logger.log('[SubstituicaoService] Buscando vendedores do WinThor...');
      
      const pool = await this._getOraclePool();
      connection = await pool.getConnection();

      const sql = `
        SELECT 
          U.CODUSUR,
          U.NOME,
          COUNT(C.CODCLI) AS TOTAL_CLIENTES
        FROM PCUSUARI U
        LEFT JOIN PCCLIENT C ON U.CODUSUR = C.CODUSUR1 AND C.DTEXCLUSAO IS NULL
        WHERE (U.BLOQUEIO = 'N' OR U.BLOQUEIO IS NULL)
          AND U.CODUSUR IS NOT NULL
        GROUP BY U.CODUSUR, U.NOME
        HAVING COUNT(C.CODCLI) > 0 OR U.CODUSUR IN (10, 110, 121, 122, 123, 124, 125, 126, 127, 128)
        ORDER BY U.NOME
      `;

      const result = await connection.execute(sql, [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT
      });

      this.logger.log(`[SubstituicaoService] ✓ ${result.rows.length} vendedores encontrados`);

      return result.rows.map(v => ({
        codusur: v.CODUSUR,
        nome: v.NOME,
        totalClientes: v.TOTAL_CLIENTES || 0,
        ocupacao: Math.round((v.TOTAL_CLIENTES / 250) * 100)
      }));

    } catch (err) {
      this.logger.error('[SubstituicaoService] ❌ Erro ao listar vendedores:', err);
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

  /**
   * 🆕 Busca carteira de um RCA DIRETO do WinThor (tabela PCCLIENT)
   * Coluna que liga cliente ao vendedor: CODUSUR1
   */
  async buscarCarteiraRca(rcaCodigo) {
    let connection;
    try {
      this.logger.log(`[SubstituicaoService] Buscando carteira do RCA ${rcaCodigo} no WinThor...`);
      
      const pool = await this._getOraclePool();
      connection = await pool.getConnection();

      // 🎯 SQL CORRETO: PCCLIENT com CODUSUR1
      const sql = `
        SELECT 
          C.CODCLI,
          C.CLIENTE,
          C.FANTASIA,
          C.CATEGORIA,
          C.DTULTCOMP,
          TRUNC(SYSDATE - NVL(C.DTULTCOMP, SYSDATE - 999)) AS DIAS_SEM_COMPRA
        FROM PCCLIENT C
        WHERE C.CODUSUR1 = :rca
          AND C.DTEXCLUSAO IS NULL
        ORDER BY C.DTULTCOMP ASC NULLS FIRST
      `;

      this.logger.log(`[SubstituicaoService] Executando query: PCCLIENT WHERE CODUSUR1 = ${rcaCodigo}`);

      const result = await connection.execute(sql, [rcaCodigo], {
        outFormat: oracledb.OUT_FORMAT_OBJECT
      });

      this.logger.log(`[SubstituicaoService] ✓ ${result.rows.length} clientes encontrados para RCA ${rcaCodigo}`);

      // Mapeia os resultados
      const clientes = result.rows.map(cli => ({
        codcli: cli.CODCLI,
        cliente: cli.CLIENTE || cli.FANTASIA,
        classificacao_atual: cli.CATEGORIA || 'BRONZE',
        data_ultimo_pedido: cli.DTULTCOMP,
        dias_sem_compra: cli.DIAS_SEM_COMPRA || 0
      }));

      return clientes;

    } catch (err) {
      this.logger.error(`[SubstituicaoService] ❌ Erro ao buscar carteira RCA ${rcaCodigo}:`, err.message);
      this.logger.error('Stack:', err.stack);
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (err) {
          this.logger.error('[SubstituicaoService] Erro ao fechar conexão:', err);
        }
      }
    }
  }

  /**
   * Busca clientes compatíveis baseado na distribuição de classificações
   */
// No arquivo: substituicao-carteira-service.js

  async buscarClientesCompativeis({ rcaAtual, clientesRemover, distribuicaoDesejada, quantidade }) {
    let connection;
    try {
      const pool = await this._getOraclePool();
      connection = await pool.getConnection();
      const regraCodAtv = this._describeCodAtvRule(rcaAtual);

      let novosClientes = [];
      
      // Lista de IDs já selecionados para não repetir na repescagem
      let idsSelecionados = [...clientesRemover]; 

      if (regraCodAtv) {
        this.logger.log(`[SubstituicaoService] Aplicando regra fixa de segmento: ${regraCodAtv}.`);
      }

      // 1. TENTATIVA PRINCIPAL: Buscar por categoria exata (Ouro por Ouro, etc)
      for (const [nivel, qtd] of Object.entries(distribuicaoDesejada)) {
        if (qtd > 0) {
          const sql = `
            SELECT 
              CODCLI,
              CLIENTE,
              FANTASIA,
              CATEGORIA,
              DTULTCOMP,
              MUNICENT AS CIDADE,
              ESTENT AS UF
            FROM PCCLIENT
            WHERE (CODUSUR1 IS NULL OR CODUSUR1 = 118)
              AND DTEXCLUSAO IS NULL
              AND CODCLI NOT IN (${idsSelecionados.length > 0 ? idsSelecionados.join(',') : 0})
              ${this._buildCodAtvFilterSql(rcaAtual)}
              ${nivel !== 'OUTROS' ? `AND UPPER(TRIM(CATEGORIA)) = :nivel` : `AND (CATEGORIA IS NULL OR UPPER(TRIM(CATEGORIA)) NOT IN ('DIAMANTE', 'PLATINUM', 'OURO', 'PRATA', 'BRONZE'))`}
            ORDER BY DTULTCOMP DESC NULLS LAST
            FETCH FIRST :qtd ROWS ONLY
          `;

          const params = { qtd };
          if (nivel !== 'OUTROS') params.nivel = nivel;

          const result = await connection.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT });
          
          if (result.rows.length > 0) {
            novosClientes.push(...result.rows);
            // Adiciona os encontrados na lista de IDs proibidos para não duplicar
            result.rows.forEach(c => idsSelecionados.push(c.CODCLI));
          }
        }
      }

      // 2. REPESCAGEM (PREENCHER O DESFALQUE):
      // Se a quantidade encontrada for menor que a solicitada, completamos com o que tiver de melhor
      if (novosClientes.length < quantidade) {
        const faltam = quantidade - novosClientes.length;
        
        this.logger.log(`[SubstituicaoService] Desfalque detectado! Faltam ${faltam} clientes. Iniciando repescagem...`);

        const sqlRepescagem = `
          SELECT 
            CODCLI,
            CLIENTE,
            FANTASIA,
            CATEGORIA,
            DTULTCOMP,
            MUNICENT AS CIDADE,
            ESTENT AS UF
          FROM PCCLIENT
          WHERE (CODUSUR1 IS NULL OR CODUSUR1 = 118)
            AND DTEXCLUSAO IS NULL
            AND CODCLI NOT IN (${idsSelecionados.length > 0 ? idsSelecionados.join(',') : 0})
            ${this._buildCodAtvFilterSql(rcaAtual)}
          ORDER BY 
            -- Prioridade na repescagem: Categorias melhores primeiro, depois data de compra
            CASE WHEN UPPER(TRIM(CATEGORIA)) = 'DIAMANTE' THEN 1
                 WHEN UPPER(TRIM(CATEGORIA)) = 'PLATINUM' THEN 2
                 WHEN UPPER(TRIM(CATEGORIA)) = 'OURO' THEN 3
                 WHEN UPPER(TRIM(CATEGORIA)) = 'PRATA' THEN 4
                 WHEN UPPER(TRIM(CATEGORIA)) = 'BRONZE' THEN 5
                 ELSE 6 END ASC,
            DTULTCOMP DESC NULLS LAST
          FETCH FIRST :qtd ROWS ONLY
        `;

        const resultRepescagem = await connection.execute(sqlRepescagem, { qtd: faltam }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        
        if (resultRepescagem.rows.length > 0) {
          novosClientes.push(...resultRepescagem.rows);
        }
      }

      // Calcula a nova distribuição para mostrar na tela
      const distribuicaoNovos = {
        DIAMANTE: 0, PLATINUM: 0, OURO: 0, PRATA: 0, BRONZE: 0, OUTROS: 0
      };

      novosClientes.forEach(c => {
        const cat = (c.CATEGORIA || 'OUTROS').toUpperCase().trim();
        if (distribuicaoNovos[cat] !== undefined) distribuicaoNovos[cat]++;
        else distribuicaoNovos.OUTROS++;
      });

      return { novosClientes, distribuicaoNovos };

    } catch (error) {
      this.logger.error('[SubstituicaoService] Erro ao buscar clientes:', error);
      throw error;
    } finally {
      if (connection) {
        try { await connection.close(); } catch (err) { console.error(err); }
      }
    }
  }

  /**
   * Executa a substituição de carteira
   * ✅ FIX: Commit atômico, tipo Number no RCA, verificação de rows affected
   */
  async executarSubstituicao(params) {
    let { rcaAtual, clientesRemover, clientesAdicionar } = params;

    rcaAtual = Number(rcaAtual);
    if (isNaN(rcaAtual) || !rcaAtual) {
      throw new Error('RCA inválido: ' + params.rcaAtual);
    }

    if (!Array.isArray(clientesAdicionar)) {
      clientesAdicionar = [];
    }

    clientesRemover = (clientesRemover || []).map(Number).filter(n => !isNaN(n) && n > 0);
    clientesAdicionar = clientesAdicionar.map(Number).filter(n => !isNaN(n) && n > 0);

    this.logger.log(`[SubstituicaoService] Executando substituição...`);
    this.logger.log(`[SubstituicaoService] RCA: ${rcaAtual}`);
    this.logger.log(`[SubstituicaoService] Remover: ${clientesRemover.length} clientes`);
    this.logger.log(`[SubstituicaoService] Adicionar: ${clientesAdicionar.length} clientes`);

    let connection;
    let pgClient;

    try {
      const pool = await this._getOraclePool();
      connection = await pool.getConnection();
      
      if (this.pgPool) {
        pgClient = await this.pgPool.connect();
        await pgClient.query('BEGIN');
      }

      if (clientesAdicionar.length > 0) {
        const clientesIncompativeis = await this._listarClientesIncompativeisParaRca(connection, rcaAtual, clientesAdicionar);

        if (clientesIncompativeis.length > 0) {
          const regraCodAtv = this._describeCodAtvRule(rcaAtual);
          const resumoIncompativeis = clientesIncompativeis
            .slice(0, 10)
            .map(cli => `${cli.CODCLI}(CODATV1=${cli.CODATV1 == null ? 'null' : cli.CODATV1})`)
            .join(', ');

          throw new Error(
            `${regraCodAtv}. Clientes incompativeis: ${resumoIncompativeis}${clientesIncompativeis.length > 10 ? '...' : ''}`
          );
        }
      }

      let rowsRemovidos = 0;
      let rowsAdicionados = 0;

      // ETAPA 1: Remove clientes (envia para RCA 118)
      if (clientesRemover.length > 0) {
        const sqlRemover = `
          UPDATE PCCLIENT 
          SET CODUSUR1 = 118
          WHERE CODCLI IN (${clientesRemover.join(',')})
        `;

        const resRemover = await connection.execute(sqlRemover);
        rowsRemovidos = resRemover.rowsAffected || 0;
        this.logger.log(`[SubstituicaoService] ETAPA 1: ${rowsRemovidos} rows removidas (commit pendente)`);
      }

      // ETAPA 2: Adiciona novos clientes
      if (clientesAdicionar.length > 0) {
        const sqlAdicionar = `
          UPDATE PCCLIENT 
          SET CODUSUR1 = :rca
          WHERE CODCLI IN (${clientesAdicionar.join(',')})
        `;

        this.logger.log(`[SubstituicaoService] ETAPA 2: UPDATE CODUSUR1 = ${rcaAtual} para CODCLIs: [${clientesAdicionar.join(',')}]`);

        const resAdicionar = await connection.execute(sqlAdicionar, { rca: rcaAtual });
        rowsAdicionados = resAdicionar.rowsAffected || 0;
        this.logger.log(`[SubstituicaoService] ETAPA 2: ${rowsAdicionados} rows adicionadas (commit pendente)`);

        if (rowsAdicionados < clientesAdicionar.length) {
          this.logger.error(`[SubstituicaoService] ⚠️ Esperava ${clientesAdicionar.length} mas só atualizou ${rowsAdicionados}!`);
        }
      }

      // COMMIT ATÔMICO — ambas as etapas juntas
      await connection.commit();
      this.logger.log(`[SubstituicaoService] ✅ COMMIT Oracle executado`);

      // Registra movimentações no Postgres
      if (pgClient) {
        for (const codcli of clientesRemover) {
          await this._registrarMovimentacao(pgClient, {
            codcli, rca_anterior: rcaAtual, rca_novo: 118,
            origem: 'SUBSTITUICAO_MANUAL', dias_sem_compra: 0
          });
        }
        for (const codcli of clientesAdicionar) {
          await this._registrarMovimentacao(pgClient, {
            codcli, rca_anterior: null, rca_novo: rcaAtual,
            origem: 'SUBSTITUICAO_MANUAL', dias_sem_compra: 0
          });
        }
        await pgClient.query('COMMIT');
      }

      const sqlTotal = `
        SELECT COUNT(*) AS TOTAL FROM PCCLIENT
        WHERE CODUSUR1 = :rca AND DTEXCLUSAO IS NULL
      `;
      const resultTotal = await connection.execute(sqlTotal, { rca: rcaAtual }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const totalAtual = resultTotal.rows[0]?.TOTAL || 0;

      this.logger.log(`[SubstituicaoService] ✅ Concluído! Removidos: ${rowsRemovidos}, Adicionados: ${rowsAdicionados}, Total: ${totalAtual}`);

      return { removidos: rowsRemovidos, adicionados: rowsAdicionados, totalAtual };

    } catch (err) {
      this.logger.error(`[SubstituicaoService] ❌ Erro:`, err);
      
      if (connection) {
        try { await connection.rollback(); } catch (e) { this.logger.error('Rollback Oracle falhou:', e); }
      }
      if (pgClient) {
        try { await pgClient.query('ROLLBACK'); } catch (e) { this.logger.error('Rollback PG falhou:', e); }
      }

      throw err;
    } finally {
      if (connection) {
        try { await connection.close(); } catch (err) { this.logger.error('Erro ao fechar Oracle:', err); }
      }
      if (pgClient) { pgClient.release(); }
    }
  }

  /**
   * Registra a movimentação no histórico do Postgres
   */
  async _registrarMovimentacao(pgClient, dados) {
    try {
      const pool = await this._getOraclePool();
      const conn = await pool.getConnection();
      
      const sqlCliente = `
        SELECT CLIENTE, FANTASIA 
        FROM PCCLIENT 
        WHERE CODCLI = :codcli
      `;
      
      const result = await conn.execute(sqlCliente, [dados.codcli], {
        outFormat: oracledb.OUT_FORMAT_OBJECT
      });

      await conn.close();

      const nomeCliente = result.rows[0]?.FANTASIA || result.rows[0]?.CLIENTE || 'Cliente Desconhecido';

      const sql = `
        INSERT INTO movimentacao_carteira 
        (codcli, cliente, rca_anterior, rca_novo, data_remanejamento, origem, dias_sem_compra)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6)
      `;

      await pgClient.query(sql, [
        dados.codcli,
        nomeCliente,
        dados.rca_anterior,
        dados.rca_novo,
        dados.origem,
        dados.dias_sem_compra
      ]);

    } catch (err) {
      this.logger.error('[SubstituicaoService] Erro ao registrar movimentação:', err);
    }
  }
}

module.exports = SubstituicaoCarteiraService;

// rotativo-repository.js
// RepositÃ³rio para gerenciar a tabela clientes_rotativos (Postgres)

const { Pool } = require('pg');
const oracledb = require('oracledb');
const dbSwitch = require('./db-switch');
const { normalizeCronConfig } = require('./execution-policy');

class RotativoRepository {
  /**
   * @param {Console|{log:Function,error:Function}} logger
   */
  constructor(logger, options = {}) {
    this.logger = logger || console;
    this._protecaoManualSchemaReady = false;

    if (options.pool) {
      this.pool = options.pool;
      return;
    }

    const connString = process.env.POSTGRES_CONN_STRING;
    if (!connString) {
      const msg = '[RotativoRepository] POSTGRES_CONN_STRING nÃ£o definido no .env';
      if (this.logger?.error) this.logger.error(msg);
      throw new Error(msg);
    }

    this.pool = new Pool({
      connectionString: connString,
      // se precisar depois: ssl, max, idleTimeoutMillis etc.
    });
  }

  async _getOraclePool() {
    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }
    return pool;
  }

  _getFallbackRcasPainel() {
    return [10, 110, 121, 122, 123, 124, 125, 126, 127, 128];
  }

  async _obterRcasPainel(client) {
    try {
      const result = await client.query(`
        SELECT extra_config
        FROM parametros_sistema
        LIMIT 1
      `);

      const extra = result.rows?.[0]?.extra_config;
      const listaConfigurada = Array.isArray(extra?.rcas_rotativa)
        ? extra.rcas_rotativa.map(Number).filter(n => Number.isFinite(n) && n > 0)
        : [];
      // Sempre inclui o grupo padrão do painel para não ocultar vendedores
      // quando a configuração estiver parcial (ex.: só 10 e 110).
      const listaFinal = [
        ...this._getFallbackRcasPainel(),
        ...listaConfigurada
      ];

      return Array.from(new Set(listaFinal));
    } catch (err) {
      this.logger?.error?.('[RotativoRepo] Erro ao obter RCAs do painel. Usando fallback:', err.message);
      return this._getFallbackRcasPainel();
    }
  }

  async _obterDiasProtecaoPadrao(client) {
    try {
      const result = await client.query(`
        SELECT COALESCE(NULLIF(dias_protecao_upgrade, 0), 60) AS dias_protecao_upgrade
        FROM parametros_sistema
        LIMIT 1
      `);

      return Number(result.rows?.[0]?.dias_protecao_upgrade || 60);
    } catch (err) {
      this.logger?.error?.('[RotativoRepo] Erro ao obter dias padrão de proteção. Usando 60:', err.message);
      return 60;
    }
  }

  async _ensureProtecaoManualTable(client) {
    if (this._protecaoManualSchemaReady) return;

    await client.query(`
      CREATE TABLE IF NOT EXISTS clientes_protecao_manual (
        codcli INTEGER PRIMARY KEY,
        cliente TEXT,
        dias_protecao INTEGER NOT NULL CHECK (dias_protecao > 0),
        data_inicio TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        data_fim TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this._protecaoManualSchemaReady = true;
  }

  _getProtecoesAtivasCteSql(diasPlaceholder = '$1') {
    return `
      ProtecoesBase AS (
        SELECT
          codcli,
          COALESCE(NULLIF(cliente, ''), 'Cliente ' || codcli::text) AS cliente,
          classificacao_anterior,
          classificacao_nova,
          data_upgrade,
          (data_upgrade + (${diasPlaceholder}::int * INTERVAL '1 day')) AS data_fim_protecao,
          EXTRACT(EPOCH FROM ((data_upgrade + (${diasPlaceholder}::int * INTERVAL '1 day')) - NOW())) / 86400 AS dias_restantes,
          'UPGRADE' AS origem_protecao,
          ${diasPlaceholder}::int AS dias_protecao
        FROM clientes_upgrade
        WHERE (data_upgrade + (${diasPlaceholder}::int * INTERVAL '1 day')) > NOW()

        UNION ALL

        SELECT
          codcli,
          COALESCE(NULLIF(cliente, ''), 'Cliente ' || codcli::text) AS cliente,
          'MANUAL' AS classificacao_anterior,
          'MANUAL' AS classificacao_nova,
          data_inicio AS data_upgrade,
          data_fim AS data_fim_protecao,
          EXTRACT(EPOCH FROM (data_fim - NOW())) / 86400 AS dias_restantes,
          'MANUAL' AS origem_protecao,
          dias_protecao
        FROM clientes_protecao_manual
        WHERE data_fim > NOW()
      ),
      ProtecoesAtivas AS (
        SELECT DISTINCT ON (codcli)
          codcli,
          cliente,
          classificacao_anterior,
          classificacao_nova,
          data_upgrade,
          data_fim_protecao,
          dias_restantes,
          origem_protecao,
          dias_protecao
        FROM ProtecoesBase
        ORDER BY codcli, data_fim_protecao DESC, CASE WHEN origem_protecao = 'MANUAL' THEN 0 ELSE 1 END
      )
    `;
  }

  async _buscarClienteWinthorPorCodigo(codcli) {
    let oracleConn;
    try {
      const pool = await this._getOraclePool();
      oracleConn = await pool.getConnection();

      const sql = `
        SELECT
          CODCLI,
          NVL(FANTASIA, CLIENTE) AS CLIENTE,
          CATEGORIA
        FROM PCCLIENT
        WHERE CODCLI = :codcli
          AND DTEXCLUSAO IS NULL
      `;

      const result = await oracleConn.execute(sql, { codcli: Number(codcli) }, {
        outFormat: oracledb.OUT_FORMAT_OBJECT
      });

      const row = result.rows?.[0];
      if (!row) return null;

      return {
        codcli: Number(row.CODCLI),
        cliente: row.CLIENTE || `Cliente ${row.CODCLI}`,
        classificacaoAtual: row.CATEGORIA || null
      };
    } catch (err) {
      this.logger?.error?.(`[RotativoRepo] Erro ao buscar cliente ${codcli} no WinThor:`, err.message);
      throw err;
    } finally {
      if (oracleConn) {
        try { await oracleConn.close(); } catch (_) {}
      }
    }
  }

  async _buscarVisaoGeralWinthor() {
    let oracleConn;
    try {
      const pool = await this._getOraclePool();
      oracleConn = await pool.getConnection();

      const sql = `
        SELECT
          U.CODUSUR AS RCA_CODIGO,
          U.NOME AS RCA_NOME,
          COUNT(C.CODCLI) AS TOTAL_CLIENTES,
          SUM(CASE WHEN TRUNC(SYSDATE - NVL(C.DTULTCOMP, SYSDATE - 999)) <= 30 THEN 1 ELSE 0 END) AS ATIVOS,
          SUM(CASE WHEN TRUNC(SYSDATE - NVL(C.DTULTCOMP, SYSDATE - 999)) BETWEEN 31 AND 60 THEN 1 ELSE 0 END) AS ALERTAS,
          SUM(CASE WHEN TRUNC(SYSDATE - NVL(C.DTULTCOMP, SYSDATE - 999)) > 60 THEN 1 ELSE 0 END) AS RISCO
        FROM PCUSUARI U
        LEFT JOIN PCCLIENT C
          ON C.CODUSUR1 = U.CODUSUR
         AND C.DTEXCLUSAO IS NULL
        WHERE (U.BLOQUEIO = 'N' OR U.BLOQUEIO IS NULL)
          AND U.CODUSUR IS NOT NULL
          AND U.CODUSUR > 0
        GROUP BY U.CODUSUR, U.NOME
        ORDER BY COUNT(C.CODCLI) DESC, U.CODUSUR ASC
      `;

      const result = await oracleConn.execute(sql, {}, {
        outFormat: oracledb.OUT_FORMAT_OBJECT
      });

      return (result.rows || []).map(row => ({
        rca_codigo: Number(row.RCA_CODIGO),
        rca_nome: row.RCA_NOME || null,
        total_clientes: Number(row.TOTAL_CLIENTES || 0),
        ativos: Number(row.ATIVOS || 0),
        alertas: Number(row.ALERTAS || 0),
        risco: Number(row.RISCO || 0)
      }));
    } catch (err) {
      this.logger?.error?.('[RotativoRepo] Erro ao montar visÃ£o geral no WinThor:', err.message);
      return [];
    } finally {
      if (oracleConn) {
        try { await oracleConn.close(); } catch (_) {}
      }
    }
  }

  /**
   * Sincroniza um cliente na tabela clientes_rotativos:
   * - Se grupoCarteira === 'CARTEIRA_ROTATIVA' â†’ faz upsert (INSERT ... ON CONFLICT).
   * - Caso contrÃ¡rio â†’ apaga qualquer registro existente desse cliente (se houver).
   *
   * @param {object} cliente
   */
  async syncRotativo(cliente) {
    if (!cliente || !cliente.codcli) return;

    if (cliente.grupoCarteira === 'CARTEIRA_ROTATIVA') {
      return this._upsertRotativo(cliente);
    }

    // Se nÃ£o Ã© mais rotativo, remove da tabela (mantemos sÃ³ quem estÃ¡ na regra)
    return this._deleteRotativo(cliente.codcli);
  }

  async _upsertRotativo(cliente) {
    const query = `
      INSERT INTO clientes_rotativos (
        codcli,
        cliente_nome,
        rca_responsavel,
        data_ultimo_pedido,
        dias_sem_compra,
        qualificacao,
        classificacao_atual,
        grupo_carteira,
        em_alerta_rotativa,
        atualizado_em
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
      ON CONFLICT (codcli) DO UPDATE SET
        cliente_nome        = EXCLUDED.cliente_nome,
        rca_responsavel     = EXCLUDED.rca_responsavel,
        data_ultimo_pedido  = EXCLUDED.data_ultimo_pedido,
        dias_sem_compra     = EXCLUDED.dias_sem_compra,
        qualificacao        = EXCLUDED.qualificacao,
        classificacao_atual = EXCLUDED.classificacao_atual,
        grupo_carteira      = EXCLUDED.grupo_carteira,
        em_alerta_rotativa  = EXCLUDED.em_alerta_rotativa,
        atualizado_em       = NOW();
    `;

    const values = [
      cliente.codcli,
      cliente.cliente || null,
      cliente.rcaResponsavel || null,
      cliente.dataUltimoPedido ? new Date(cliente.dataUltimoPedido) : null,
      cliente.diasSemCompra != null ? cliente.diasSemCompra : null,
      cliente.qualificacao || null,
      cliente.classificacaoAtual || null,
      cliente.grupoCarteira || null,
      cliente.emAlertaRotativa === true,
    ];

    await this.pool.query(query, values);

    if (this.logger?.log) {
      this.logger.log(
        `[RotativoRepository] Upsert cliente_rotativo codcli=${cliente.codcli}, grupo=${cliente.grupoCarteira}, dias=${cliente.diasSemCompra}`
      );
    }
  }

  async _deleteRotativo(codcli) {
    const query = `DELETE FROM clientes_rotativos WHERE codcli = $1`;
    await this.pool.query(query, [codcli]);

    if (this.logger?.log) {
      this.logger.log(
        `[RotativoRepository] Removido (se existia) cliente_rotativo codcli=${codcli} da tabela clientes_rotativos`
      );
    }
  }

    /**
   * Registra no Postgres o remanejamento de RCA do Grupo 2
   * (Carteira de Longo Prazo).
   *
   * Espera algo como:
   * {
   *   codcli,
   *   cliente,
   *   rcaAnterior,
   *   rcaNovo,
   *   dataRemanejamento: Date,
   *   diasSemCompra,
   *   notaMediaGeral,
   *   classificacaoAtual,
   *   dataUltimoPedido,
   *   payload
   * }
   */
  async registrarRemanejamentoGrupo2(dados) {
    if (!this.pool) {
      this.logger?.error?.(
        '[RemanejamentoRCA] Pool Postgres nÃ£o inicializado'
      );
      return;
    }

    const {
      codcli,
      cliente,
      rcaAnterior,
      rcaNovo,
      dataRemanejamento,
      diasSemCompra,
      payload
    } = dados;

    // âœ… AJUSTE: Nome da tabela no banco do Tiago Ã© 'movimentacao_carteira'
    // E as colunas sÃ£o: codcli, cliente, rca_anterior, rca_novo, data_remanejamento, origem, dias_sem_compra, payload
    const sql = `
      INSERT INTO movimentacao_carteira (
        codcli,
        cliente,
        rca_anterior,
        rca_novo,
        data_remanejamento,
        origem,
        dias_sem_compra,
        payload
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8
      )
    `;

    const params = [
      codcli,
      cliente,
      rcaAnterior,
      rcaNovo,
      dataRemanejamento || new Date(),
      dados.origem || 'MOV_CART_GRUPO2',
      diasSemCompra ?? null,
      payload ? JSON.stringify(payload) : null,
    ];

    let client;
    try {
      client = await this.pool.connect();
      await client.query(sql, params);

      this.logger?.log?.(
        `[RemanejamentoRCA] Registrado remanejamento Grupo 2 codcli=${codcli} ` +
        `(RCA ${rcaAnterior} â†’ ${rcaNovo})`
      );
    } catch (err) {
      this.logger?.error?.(
        '[RemanejamentoRCA] Erro ao registrar remanejamento Grupo 2:',
        err && err.message ? err.message : err
      );
    } finally {
      if (client) client.release();
    }
  }

  async registrarUpgradeCliente(payload) {
    if (!this.pool || !payload.codcli) return;

    const {
      codcli,
      cliente,
      classificacaoAnterior,
      classificacaoNova,
    } = payload;

    // Usamos ON CONFLICT (UPSERT) para garantir que sempre teremos o registro mais recente
    const sql = `
      INSERT INTO clientes_upgrade (
        codcli,
        cliente,
        classificacao_anterior,
        classificacao_nova,
        data_upgrade
      ) VALUES (
        $1, $2, $3, $4, CURRENT_TIMESTAMP
      )
      ON CONFLICT (codcli) DO UPDATE SET
        cliente = EXCLUDED.cliente,
        classificacao_anterior = EXCLUDED.classificacao_anterior,
        classificacao_nova = EXCLUDED.classificacao_nova,
        data_upgrade = EXCLUDED.data_upgrade,
        data_registro = CURRENT_TIMESTAMP -- Atualiza a data de registro
    `;

    const params = [
      codcli,
      cliente || null,
      classificacaoAnterior || null,
      classificacaoNova || null,
    ];

    let client;
    try {
      client = await this.pool.connect();
      await client.query(sql, params);

      this.logger?.log?.(
        `[RotativoRepo] Upgrade Registrado/Atualizado: Cli ${codcli} (${classificacaoAnterior} â†’ ${classificacaoNova})`
      );
    } catch (err) {
      this.logger?.error?.(
        `[RotativoRepo] FALHA ao registrar upgrade para Cli ${codcli}:`,
        err && err.message ? err.message : err
      );
    } finally {
      if (client) client.release();
    }
  }

  async salvarProtecaoManual(payload) {
    if (!this.pool) return null;

    const codcli = Number(payload?.codcli);
    const diasProtecao = Number(payload?.diasProtecao);

    if (!Number.isInteger(codcli) || codcli <= 0) {
      throw new Error('Codigo do cliente invalido.');
    }

    if (!Number.isInteger(diasProtecao) || diasProtecao <= 0) {
      throw new Error('Dias de protecao invalido.');
    }

    const clienteWinthor = await this._buscarClienteWinthorPorCodigo(codcli);
    if (!clienteWinthor) {
      throw new Error(`Cliente ${codcli} nao encontrado no WinThor.`);
    }

    const sql = `
      INSERT INTO clientes_protecao_manual (
        codcli,
        cliente,
        dias_protecao,
        data_inicio,
        data_fim,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + ($3::int * INTERVAL '1 day'),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (codcli) DO UPDATE SET
        cliente = EXCLUDED.cliente,
        dias_protecao = EXCLUDED.dias_protecao,
        data_inicio = EXCLUDED.data_inicio,
        data_fim = EXCLUDED.data_fim,
        updated_at = CURRENT_TIMESTAMP
      RETURNING
        codcli,
        cliente,
        dias_protecao,
        data_inicio,
        data_fim
    `;

    let client;
    try {
      client = await this.pool.connect();
      await this._ensureProtecaoManualTable(client);

      const result = await client.query(sql, [
        codcli,
        clienteWinthor.cliente,
        diasProtecao
      ]);

      const row = result.rows?.[0] || null;
      if (row) {
        this.logger?.log?.(
          `[RotativoRepo] Protecao manual gravada: Cli ${row.codcli} por ${row.dias_protecao} dias.`
        );
      }

      return row;
    } catch (err) {
      this.logger?.error?.('[RotativoRepo] Erro ao salvar protecao manual:', err.message);
      throw err;
    } finally {
      if (client) client.release();
    }
  }

  async consultarProtecaoAtiva(codcli, diasProtecaoPadrao = 60) {
    if (!this.pool || !codcli) return null;

    const sql = `
      WITH ${this._getProtecoesAtivasCteSql('$2')}
      SELECT
        codcli,
        cliente,
        classificacao_anterior,
        classificacao_nova,
        data_upgrade,
        data_fim_protecao,
        dias_restantes,
        origem_protecao,
        dias_protecao
      FROM ProtecoesAtivas
      WHERE codcli = $1
      LIMIT 1
    `;

    let client;
    try {
      client = await this.pool.connect();
      await this._ensureProtecaoManualTable(client);

      const res = await client.query(sql, [Number(codcli), Number(diasProtecaoPadrao) || 60]);
      return res.rows?.[0] || null;
    } catch (err) {
      this.logger?.error?.(`[RotativoRepo] Erro ao consultar protecao ativa Cli ${codcli}:`, err.message);
      return null;
    } finally {
      if (client) client.release();
    }
  }

  // Se vocÃª precisar depois, aqui estaria o mÃ©todo para consultar a data de upgrade:
  async consultarDataUpgrade(codcli) {
      if (!this.pool || !codcli) return null;
      const sql = 'SELECT data_upgrade FROM clientes_upgrade WHERE codcli = $1';
      let client;
      try {
          client = await this.pool.connect();
          const res = await client.query(sql, [codcli]);
          if (res.rows.length > 0) {
              return res.rows[0].data_upgrade; // Retorna o objeto Date/Timestamp
          }
      } catch (err) {
          this.logger?.error?.(`[RotativoRepo] Erro ao consultar data upgrade Cli ${codcli}:`, err);
      } finally {
          if (client) client.release();
      }
      return null;
  }

async listarTodosRotativos() {
    if (!this.pool) return [];
    const sql = 'SELECT * FROM clientes_rotativos ORDER BY dias_sem_compra DESC';
    
    try {
      const res = await this.pool.query(sql);
      return res.rows; // Retorna array de objetos { codcli, ... }
    } catch (err) {
      this.logger.error('[RotativoRepo] Erro ao listar clientes rotativos:', err.message);
      return [];
    }
  }

  /**
   * Remove cliente da tabela clientes_rotativos apÃ³s redistribuiÃ§Ã£o
   */
  async removerClienteRotativo(codcli) {
    if (!this.pool) return;
    const sql = 'DELETE FROM clientes_rotativos WHERE codcli = $1';
    try {
      await this.pool.query(sql, [codcli]);
      this.logger.log(`[RotativoRepo] Cliente ${codcli} removido da rotativa (RedistribuÃ­do).`);
    } catch (err) {
      this.logger.error(`[RotativoRepo] Erro ao remover cli ${codcli}:`, err.message);
    }
  }

  // ===========================================================================
  // ðŸ†• NOVO MÃ‰TODO: SALVAR DADOS PARA RELATÃ“RIO (ETAPA 6)
  // ===========================================================================
  async salvarDadosRelatorio(dados) {
    if (!this.pool) return;

    // Define o Status Visual
    let statusSituacao = 'ATIVO';
    if (dados.diasSemCompra >= 60) statusSituacao = 'RISCO';
    else if (dados.diasSemCompra >= 30) statusSituacao = 'ALERTA';

    // Prepara SQL
    const sql = `
      INSERT INTO relatorio_carteira (
        codcli, cliente, fantasia, rca_codigo, dias_sem_compra,
        nivel, nota_media, status_situacao, grupo_carteira, 
        motivo_bloqueio, valor_ultimo_pedido, data_ultimo_pedido,
        data_processamento
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
      )
      -- Se quiser evitar duplicados no mesmo dia, pode usar ON CONFLICT, 
      -- mas como o ID Ã© serial, ele vai apenas empilhar registros novos a cada teste.
    `;

    // Extrai valor do Ãºltimo pedido do histÃ³rico (se existir)
    let valorUltimo = 0;
    if (dados.historicoFaturamento && dados.historicoFaturamento.length > 0) {
        valorUltimo = dados.historicoFaturamento[0].vlLiquido || 0;
    }

    const params = [
      dados.codcli,
      dados.cliente,
      dados.fantasia || dados.cliente, // Fallback se fantasia nulo
      dados.rcaResponsavel,
      dados.diasSemCompra || 0,
      dados.faixaCalculada || 'SEM_NIVEL',
      parseFloat(dados.notaMediaGeral) || 0, // âœ… Garantindo que seja numÃ©rico para o numeric(10,2)
      statusSituacao,
      dados.grupoCarteira || 'NORMAL',
      dados.motivoBloqueio || null,
      valorUltimo,
      dados.dataUltimoPedido ? new Date(dados.dataUltimoPedido) : null
    ];

    try {
      await this.pool.query(sql, params);
      this.logger?.log?.(`[RotativoRepo] ðŸ“Š Dados de relatÃ³rio gravados para Cli ${dados.codcli}`);
    } catch (err) {
      this.logger?.error?.(`[RotativoRepo] âŒ Erro ao gravar relatÃ³rio Cli ${dados.codcli}:`, err.message);
    }
  }

// --- MÃ‰TODOS PARA O RELATÃ“RIO DE GESTORES ---
  async obterResumoGerencial(client) {
    if (!this.pool) return {};
    const dbClient = client || await this.pool.connect();
    const releaseClient = !client;

    try {
      await this._ensureProtecaoManualTable(dbClient);
      const diasProtecaoPadrao = await this._obterDiasProtecaoPadrao(dbClient);

      const sqlResumo = `
        WITH UltimaPosicao AS (
          SELECT DISTINCT ON (codcli) *
          FROM relatorio_carteira
          ORDER BY codcli, data_processamento DESC
        ),
        ${this._getProtecoesAtivasCteSql('$1')}
        SELECT
          (SELECT COUNT(*)::int
             FROM movimentacao_carteira
            WHERE data_remanejamento >= (CURRENT_DATE - INTERVAL '60 days')
          ) AS movimentacoes_total,
          (SELECT COUNT(*)::int
             FROM movimentacao_carteira
            WHERE data_remanejamento >= (CURRENT_DATE - INTERVAL '60 days')
              AND rca_novo = 118
          ) AS longo_prazo_total,
          (SELECT COUNT(*)::int
             FROM clientes_upgrade
            WHERE data_upgrade >= (CURRENT_DATE - INTERVAL '90 days')
          ) AS reclassificacoes_total,
          (SELECT COUNT(*)::int
             FROM ProtecoesAtivas
           ) AS protecoes_total,
          (SELECT COUNT(*)::int
             FROM UltimaPosicao
            WHERE motivo_bloqueio LIKE '%BITRIX%'
          ) AS bitrix_total,
          (SELECT COUNT(*)::int
             FROM movimentacao_carteira
          ) AS substituicoes_total
      `;

      const result = await dbClient.query(sqlResumo, [diasProtecaoPadrao]);
      const row = result.rows?.[0] || {};

      return {
        movimentacoes_total: Number(row.movimentacoes_total || 0),
        longo_prazo_total: Number(row.longo_prazo_total || 0),
        reclassificacoes_total: Number(row.reclassificacoes_total || 0),
        protecoes_total: Number(row.protecoes_total || 0),
        bitrix_total: Number(row.bitrix_total || 0),
        substituicoes_total: Number(row.substituicoes_total || 0)
      };
    } finally {
      if (releaseClient) dbClient.release();
    }
  }

  async obterDadosGerenciaisIniciais() {
    if (!this.pool) return { visaoGeral: [], resumo: {} };
    const client = await this.pool.connect();
    try {
      const [visaoGeral, resumo] = await Promise.all([
        this._buscarVisaoGeralWinthor(),
        this.obterResumoGerencial(client)
      ]);
      return { visaoGeral, resumo };
    } finally {
      client.release();
    }
  }

  async obterSubstituicoesRecentes(limit = 1000) {
    if (!this.pool) return [];
    const lim = Math.min(5000, Math.max(1, Number(limit) || 1000));
    const sql = `
      SELECT
        codcli,
        cliente,
        rca_anterior,
        rca_novo,
        data_remanejamento,
        origem,
        dias_sem_compra
      FROM movimentacao_carteira
      ORDER BY data_remanejamento DESC
      LIMIT $1
    `;
    const result = await this.pool.query(sql, [lim]);
    return result.rows || [];
  }

  async obterDadosGerenciaisPaginados({ tab, page = 1, pageSize = 50, texto = '', codigos = [], origem = '' }) {
    if (!this.pool) {
      return { tab, page: 1, pageSize: 50, total: 0, totalPages: 1, rows: [] };
    }

    const pagina = Math.max(1, Number(page) || 1);
    const tamanho = Math.min(200, Math.max(10, Number(pageSize) || 50));
    const offset = (pagina - 1) * tamanho;
    const termo = String(texto || '').trim();
    const origemFiltro = String(origem || '').trim();
    const codigosLista = Array.isArray(codigos)
      ? [...new Set(codigos.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
      : [];

    const client = await this.pool.connect();
    try {
      let countSql = '';
      let dataSql = '';
      const params = [];

      if (tab === 'movimentacoes') {
        const where = [`data_remanejamento >= (CURRENT_DATE - INTERVAL '60 days')`];

        if (origemFiltro) {
          params.push(origemFiltro);
          where.push(`origem = $${params.length}`);
        }

        if (codigosLista.length) {
          params.push(codigosLista);
          where.push(`codcli = ANY($${params.length}::int[])`);
        } else if (termo) {
          params.push(`%${termo}%`);
          where.push(`(
            CAST(codcli AS TEXT) ILIKE $${params.length}
            OR COALESCE(cliente, '') ILIKE $${params.length}
            OR COALESCE(origem, '') ILIKE $${params.length}
          )`);
        }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        countSql = `SELECT COUNT(*)::int AS total FROM movimentacao_carteira ${whereSql}`;
        dataSql = `
          SELECT
            id,
            codcli,
            cliente,
            rca_anterior,
            rca_novo,
            data_remanejamento,
            origem,
            dias_sem_compra
          FROM movimentacao_carteira
          ${whereSql}
          ORDER BY data_remanejamento DESC, id DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `;
      } else if (tab === 'longo_prazo') {
        const where = [
          `data_remanejamento >= (CURRENT_DATE - INTERVAL '60 days')`,
          `rca_novo = 118`
        ];

        if (codigosLista.length) {
          params.push(codigosLista);
          where.push(`codcli = ANY($${params.length}::int[])`);
        } else if (termo) {
          params.push(`%${termo}%`);
          where.push(`(
            CAST(codcli AS TEXT) ILIKE $${params.length}
            OR COALESCE(cliente, '') ILIKE $${params.length}
            OR CAST(COALESCE(rca_anterior, 0) AS TEXT) ILIKE $${params.length}
          )`);
        }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        countSql = `SELECT COUNT(*)::int AS total FROM movimentacao_carteira ${whereSql}`;
        dataSql = `
          SELECT
            id,
            codcli,
            cliente,
            rca_anterior,
            rca_novo,
            data_remanejamento,
            dias_sem_compra,
            payload
          FROM movimentacao_carteira
          ${whereSql}
          ORDER BY data_remanejamento DESC, id DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `;
      } else if (tab === 'reclassificacoes') {
        const where = [`data_upgrade >= (CURRENT_DATE - INTERVAL '90 days')`];

        if (codigosLista.length) {
          params.push(codigosLista);
          where.push(`codcli = ANY($${params.length}::int[])`);
        } else if (termo) {
          params.push(`%${termo}%`);
          where.push(`(
            CAST(codcli AS TEXT) ILIKE $${params.length}
            OR COALESCE(cliente, '') ILIKE $${params.length}
            OR COALESCE(classificacao_anterior, '') ILIKE $${params.length}
            OR COALESCE(classificacao_nova, '') ILIKE $${params.length}
          )`);
        }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        countSql = `SELECT COUNT(*)::int AS total FROM clientes_upgrade ${whereSql}`;
        dataSql = `
          SELECT
            codcli,
            cliente,
            classificacao_anterior,
            classificacao_nova,
            data_upgrade
          FROM clientes_upgrade
          ${whereSql}
          ORDER BY data_upgrade DESC, codcli DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `;
      } else if (tab === 'protecoes') {
        await this._ensureProtecaoManualTable(client);
        const diasProtecaoPadrao = await this._obterDiasProtecaoPadrao(client);
        params.push(diasProtecaoPadrao);

        const cteProtecoes = `
          WITH ${this._getProtecoesAtivasCteSql('$1')}
        `;
        const where = ['1=1'];

        if (codigosLista.length) {
          params.push(codigosLista);
          where.push(`codcli = ANY($${params.length}::int[])`);
        } else if (termo) {
          params.push(`%${termo}%`);
          where.push(`(
            CAST(codcli AS TEXT) ILIKE $${params.length}
            OR COALESCE(cliente, '') ILIKE $${params.length}
            OR COALESCE(classificacao_nova, '') ILIKE $${params.length}
            OR COALESCE(origem_protecao, '') ILIKE $${params.length}
          )`);
        }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        countSql = `
          ${cteProtecoes}
          SELECT COUNT(*)::int AS total
          FROM ProtecoesAtivas
          ${whereSql}
        `;
        dataSql = `
          ${cteProtecoes}
          SELECT
            codcli,
            cliente,
            classificacao_anterior,
            classificacao_nova,
            data_upgrade,
            data_fim_protecao,
            dias_restantes,
            origem_protecao,
            dias_protecao
          FROM ProtecoesAtivas
          ${whereSql}
          ORDER BY data_fim_protecao DESC, codcli DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `;
      } else if (tab === 'bitrix') {
        const cte = `
          WITH UltimaPosicao AS (
            SELECT DISTINCT ON (codcli)
              codcli,
              cliente,
              rca_codigo,
              motivo_bloqueio,
              dias_sem_compra,
              data_processamento
            FROM relatorio_carteira
            ORDER BY codcli, data_processamento DESC
          )
        `;
        const where = [`motivo_bloqueio LIKE '%BITRIX%'`];

        if (codigosLista.length) {
          params.push(codigosLista);
          where.push(`codcli = ANY($${params.length}::int[])`);
        } else if (termo) {
          params.push(`%${termo}%`);
          where.push(`(
            CAST(codcli AS TEXT) ILIKE $${params.length}
            OR COALESCE(cliente, '') ILIKE $${params.length}
            OR CAST(COALESCE(rca_codigo, 0) AS TEXT) ILIKE $${params.length}
            OR COALESCE(motivo_bloqueio, '') ILIKE $${params.length}
          )`);
        }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        countSql = `
          ${cte}
          SELECT COUNT(*)::int AS total
          FROM UltimaPosicao
          ${whereSql}
        `;
        dataSql = `
          ${cte}
          SELECT
            codcli,
            cliente,
            rca_codigo,
            motivo_bloqueio,
            dias_sem_compra,
            data_processamento
          FROM UltimaPosicao
          ${whereSql}
          ORDER BY data_processamento DESC, codcli ASC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `;
      } else {
        throw new Error(`Tab inválida para paginação: ${tab}`);
      }

      const countResult = await client.query(countSql, params);
      const total = Number(countResult.rows?.[0]?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / tamanho));
      const pageFinal = Math.min(pagina, totalPages);
      const offsetFinal = (pageFinal - 1) * tamanho;

      const dataParams = [...params, tamanho, offsetFinal];
      const dataResult = await client.query(dataSql, dataParams);

      return {
        tab,
        page: pageFinal,
        pageSize: tamanho,
        total,
        totalPages,
        rows: dataResult.rows || []
      };
    } catch (err) {
      this.logger?.error?.('[RotativoRepo] Erro ao obter dados paginados de gestores:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  async obterDadosGerenciais() {
    if (!this.pool) return null;
    const client = await this.pool.connect();
    try {
      const sqlMovimentacoes = `
        SELECT *
        FROM movimentacao_carteira
        WHERE data_remanejamento >= (CURRENT_DATE - INTERVAL '60 days')
        ORDER BY data_remanejamento DESC
      `;

      const sqlUpgrades = `
        SELECT *,
          (data_upgrade + INTERVAL '60 days') as data_fim_protecao,
          EXTRACT(DAY FROM (data_upgrade + INTERVAL '60 days') - NOW()) as dias_restantes
        FROM clientes_upgrade
        WHERE data_upgrade >= (CURRENT_DATE - INTERVAL '90 days')
        ORDER BY data_upgrade DESC
      `;

      const sqlBitrix = `
        WITH UltimaPosicao AS (
          SELECT DISTINCT ON (codcli) *
          FROM relatorio_carteira
          ORDER BY codcli, data_processamento DESC
        )
        SELECT *
        FROM UltimaPosicao
        WHERE motivo_bloqueio LIKE '%BITRIX%'
      `;

      const [resGeral, resMov, resUp, resBitrix, substituicoes, resumo] = await Promise.all([
        this._buscarVisaoGeralWinthor(),
        client.query(sqlMovimentacoes),
        client.query(sqlUpgrades),
        client.query(sqlBitrix),
        this.obterSubstituicoesRecentes(1000),
        this.obterResumoGerencial(client)
      ]);

      return {
        visaoGeral: resGeral,
        movimentacoes: resMov.rows,
        upgrades: resUp.rows,
        bloqueiosBitrix: resBitrix.rows,
        substituicoes,
        resumo
      };
    } catch (err) {
      this.logger?.error?.('[RotativoRepo] Erro ao obter dados gerenciais:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  // ===========================================================================
  // ðŸ†• MÃ‰TODO PARA DETALHES DO RCA (DRILL-DOWN) - CORRIGIDO TAMBÃ‰M
  // ===========================================================================
  async listarCarteiraPorRca(rcaCodigo) {
    let oracleConn;
    const rca = Number(rcaCodigo);
    if (!Number.isFinite(rca)) return [];

    try {
      const pool = await this._getOraclePool();
      oracleConn = await pool.getConnection();

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
        ORDER BY TRUNC(SYSDATE - NVL(C.DTULTCOMP, SYSDATE - 999)) DESC, C.CODCLI ASC
      `;

      const res = await oracleConn.execute(sql, { rca }, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      return (res.rows || []).map((row) => {
        const diasSemCompra = Number(row.DIAS_SEM_COMPRA || 0);
        let status = 'ATIVO';
        if (diasSemCompra > 60) status = 'RISCO';
        else if (diasSemCompra > 30) status = 'ALERTA';

        return {
          codcli: Number(row.CODCLI),
          cliente: row.FANTASIA || row.CLIENTE || `Cliente ${row.CODCLI}`,
          classificacao_atual: row.CATEGORIA || 'BRONZE',
          grupo_carteira: 'NORMAL',
          dias_sem_compra: diasSemCompra,
          data_ultimo_pedido: row.DTULTCOMP || null,
          status_situacao: status
        };
      });
    } catch (err) {
      this.logger.error(`[RotativoRepo] Erro ao listar carteira RCA ${rcaCodigo}:`, err.message);
      return [];
    } finally {
      if (oracleConn) {
        try { await oracleConn.close(); } catch (_) {}
      }
    }
  }

  // ===========================================================================
  // ðŸ†• NOVOS MÃ‰TODOS: GERENCIAMENTO DE PARÃ‚METROS
  // ===========================================================================

  /**
   * Busca os parÃ¢metros do sistema (regras de movimentaÃ§Ã£o)
   */
async obterParametrosSistema() {
    let conn;
    try {
        conn = await this.pool.connect();

        const result = await conn.query(`
            SELECT
                dias_rotativa,
                dias_longo_prazo,
                dias_protecao_upgrade,
                meses_sazonalidade_inicio,
                meses_sazonalidade_fim,
                fases_bitrix_bloqueio,
                mapa_bitrix,
                rca_segmento_map,
                extra_config
            FROM parametros_sistema
            LIMIT 1
        `);

        if (!result.rows || result.rows.length === 0) return null;

        const row   = result.rows[0];
        const extra = (typeof row.extra_config === 'object' && row.extra_config !== null)
            ? row.extra_config
            : {};

        return {
            dias_rotativa:              Number(row.dias_rotativa)             || 31,
            dias_longo_prazo:           Number(row.dias_longo_prazo)          || 60,
            dias_protecao_upgrade:      Number(row.dias_protecao_upgrade)     || 60,
            meses_sazonalidade_inicio:  Number(row.meses_sazonalidade_inicio) || 10,
            meses_sazonalidade_fim:     Number(row.meses_sazonalidade_fim)    || 3,

            fases_bitrix_bloqueio: Array.isArray(row.fases_bitrix_bloqueio)
                ? row.fases_bitrix_bloqueio
                : ['C1:NEW', 'EM_NEGOCIACAO', 'COBRADO_ORCAMENTO', 'UC_L7NUC2', 'C4:FINAL_INVOICE'],

            mapa_bitrix: (typeof row.mapa_bitrix === 'object' && row.mapa_bitrix !== null)
                ? row.mapa_bitrix
                : {},

            rca_segmento_map: _normalizarMapaSegmentos(row.rca_segmento_map),

            // Campos vindos do JSONB extra_config
            rcas_rotativa: Array.isArray(extra.rcas_rotativa) ? extra.rcas_rotativa : [],
            filiais_cron:  Array.isArray(extra.filiais_cron)  ? extra.filiais_cron  : [],
            cron_config:   normalizeCronConfig(extra.cron_config || { ativo: false, datetime: '', frequency: 'monthly' }),
            pdf_config:    extra.pdf_config   || { ativo: false, modo_teste: false, id_tester: 0 },
            winthor_fix_config: {
                ativo: (typeof extra?.winthor_fix_config?.ativo === 'boolean')
                    ? extra.winthor_fix_config.ativo
                    : true,
                intervalo_minutos: [1, 15, 30].includes(Number(extra?.winthor_fix_config?.intervalo_minutos))
                    ? Number(extra.winthor_fix_config.intervalo_minutos)
                    : 15
            },
        };

    } catch (err) {
        this.logger?.error?.('[RotativoRepo] Erro ao obter parÃ¢metros:', err.message);
        return null;
    } finally {
        if (conn) conn.release();
    }
}



// ---------------------------------------------------------------------------
// 3. salvarParametrosSistema â€” persiste parÃ¢metros incluindo o mapa de segmentos
// ---------------------------------------------------------------------------
async salvarParametrosSistema(params) {
    let conn;
    try {
        conn = await this.pool.connect();

        // Garante estrutura mÃ­nima antes de salvar
        const mapaSegmentos = _normalizarMapaSegmentos(params.rca_segmento_map || {});

        // Campos "extra" sem coluna prÃ³pria ficam no JSONB extra_config
        const extraConfig = {
            rcas_rotativa: params.rcas_rotativa ?? [],
            filiais_cron:  params.filiais_cron  ?? [],
            cron_config:   normalizeCronConfig(params.cron_config ?? { ativo: false, datetime: '', frequency: 'monthly' }),
            pdf_config:    params.pdf_config    ?? { ativo: false, modo_teste: false, id_tester: 0 },
            winthor_fix_config: {
                ativo: (typeof params?.winthor_fix_config?.ativo === 'boolean')
                    ? params.winthor_fix_config.ativo
                    : true,
                intervalo_minutos: [1, 15, 30].includes(Number(params?.winthor_fix_config?.intervalo_minutos))
                    ? Number(params.winthor_fix_config.intervalo_minutos)
                    : 15
            },
        };

        await conn.query(`
            INSERT INTO parametros_sistema (
                id,
                chave,
                valor,
                dias_rotativa,
                dias_longo_prazo,
                dias_protecao_upgrade,
                meses_sazonalidade_inicio,
                meses_sazonalidade_fim,
                fases_bitrix_bloqueio,
                mapa_bitrix,
                rca_segmento_map,
                extra_config
            )
            VALUES (1, 'regras_movimentacao', '{}'::jsonb, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
            ON CONFLICT (id) DO UPDATE SET
                dias_rotativa              = EXCLUDED.dias_rotativa,
                dias_longo_prazo           = EXCLUDED.dias_longo_prazo,
                dias_protecao_upgrade      = EXCLUDED.dias_protecao_upgrade,
                meses_sazonalidade_inicio  = EXCLUDED.meses_sazonalidade_inicio,
                meses_sazonalidade_fim     = EXCLUDED.meses_sazonalidade_fim,
                fases_bitrix_bloqueio      = EXCLUDED.fases_bitrix_bloqueio,
                mapa_bitrix                = EXCLUDED.mapa_bitrix,
                rca_segmento_map           = EXCLUDED.rca_segmento_map,
                extra_config               = EXCLUDED.extra_config
        `, [
            params.dias_rotativa             ?? 31,
            params.dias_longo_prazo          ?? 60,
            params.dias_protecao_upgrade     ?? 60,
            params.meses_sazonalidade_inicio ?? 10,
            params.meses_sazonalidade_fim    ?? 3,
            JSON.stringify(params.fases_bitrix_bloqueio ?? []),
            JSON.stringify(params.mapa_bitrix ?? {}),
            JSON.stringify(mapaSegmentos),
            JSON.stringify(extraConfig),
        ]);

        this.logger?.log?.('[RotativoRepo] ParÃ¢metros salvos com sucesso (incluindo rca_segmento_map e extra_config).');
        return true;

    } catch (err) {
        this.logger?.error?.('[RotativoRepo] Erro ao salvar parÃ¢metros:', err.message);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}



  /**
   * Atualiza os parÃ¢metros do sistema
   * @param {Object} novosValores Objeto JSON com as novas regras
   */
  async atualizarParametrosSistema(novosValores) {
    if (!this.pool) return false;
    try {
      await this.pool.query(
        "UPDATE parametros_sistema SET valor = $1, updated_at = NOW() WHERE chave = 'regras_movimentacao'",
        [JSON.stringify(novosValores)]
      );
      return true;
    } catch (err) {
      this.logger.error('[RotativoRepo] Erro ao atualizar parÃ¢metros:', err.message);
      throw err;
    }
  }


}

function _normalizarMapaSegmentos(mapa) {
    if (!mapa || typeof mapa !== 'object') return {};

    const normalizado = {};
    for (const [chave, valores] of Object.entries(mapa)) {
        const codRca = Number(chave);
        if (isNaN(codRca)) continue; // ignora chaves invÃ¡lidas

        // Valores tambÃ©m devem ser nÃºmeros (CODATV1)
        const codativs = Array.isArray(valores)
            ? valores.map(Number).filter(v => !isNaN(v))
            : [];

        if (codativs.length > 0) {
            normalizado[codRca] = codativs;
        }
    }
    return normalizado;
}

module.exports = RotativoRepository;


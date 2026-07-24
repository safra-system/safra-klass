const oracledb = require('oracledb');
const crypto = require('crypto');
const dbSwitch = require('./db-switch');

const PROCEDURE_NAME = 'PRC_CORRIGIR_PCCLIENT_CAMPOS';
const LOG_ORIGEM = 'PROC_WINT_CORR_CADASTRO';
const LOG_ORIGEM_ROLLBACK = 'ROLLBACK_WINT_CORR_CADASTRO';

function gerarUuid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

class WinthorCadastroCorrecaoService {
  constructor(options = {}) {
    if (options && typeof options.log === 'function' && !options.logger) {
      this.logger = options || console;
      this.pgPool = null;
      this.bitrixService = null;
    } else {
      this.logger = options.logger || console;
      this.pgPool = options.pgPool || null;
      this.bitrixService = options.bitrixService || null;
    }
    this.procedureReadyByEnv = new Set();
    this.procedureOwnerByEnv = new Map();
    this.logTableReady = false;
  }

  async _getPool() {
    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }
    return pool;
  }

  _normalizeOracleIdentifier(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized || !/^[A-Z][A-Z0-9_$#]*$/.test(normalized)) {
      throw new Error(`Identificador Oracle invalido: ${value}`);
    }
    return normalized;
  }

  _getProcedureReference(envKey = dbSwitch.getCurrentEnvKey()) {
    const owner = this.procedureOwnerByEnv.get(envKey);
    return owner ? `${owner}.${PROCEDURE_NAME}` : PROCEDURE_NAME;
  }

  async _getOracleSessionContext(connection) {
    const result = await connection.execute(`
      SELECT
        SYS_CONTEXT('USERENV', 'SESSION_USER') AS SESSION_USER,
        SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS CURRENT_SCHEMA
      FROM DUAL
    `, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    const row = result.rows?.[0] || {};
    const fallbackUser = dbSwitch.getConfig()?.user || '';

    return {
      sessionUser: this._normalizeOracleIdentifier(row.SESSION_USER || fallbackUser),
      currentSchema: this._normalizeOracleIdentifier(row.CURRENT_SCHEMA || row.SESSION_USER || fallbackUser)
    };
  }

  async _resolveProcedureOwner(connection, context) {
    const owner1 = this._normalizeOracleIdentifier(context.currentSchema);
    const owner2 = this._normalizeOracleIdentifier(context.sessionUser);

    const result = await connection.execute(`
      SELECT owner, status
      FROM all_objects
      WHERE object_name = :procedureName
        AND object_type = 'PROCEDURE'
        AND owner IN (:owner1, :owner2)
      ORDER BY
        CASE
          WHEN owner = :preferredOwner THEN 0
          WHEN owner = :fallbackOwner THEN 1
          ELSE 2
        END,
        last_ddl_time DESC
      FETCH FIRST 1 ROWS ONLY
    `, {
      procedureName: PROCEDURE_NAME,
      owner1,
      owner2,
      preferredOwner: owner1,
      fallbackOwner: owner2
    }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    return result.rows?.[0]?.OWNER || owner1 || owner2 || null;
  }

  async _getProcedureStatus(connection, owner) {
    const result = await connection.execute(`
      SELECT owner, object_name, status
      FROM all_objects
      WHERE owner = :owner
        AND object_name = :procedureName
        AND object_type = 'PROCEDURE'
      FETCH FIRST 1 ROWS ONLY
    `, {
      owner: this._normalizeOracleIdentifier(owner),
      procedureName: PROCEDURE_NAME
    }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    return result.rows?.[0] || null;
  }

  async _getProcedureCompileErrors(connection, owner) {
    const result = await connection.execute(`
      SELECT line, position, text
      FROM all_errors
      WHERE owner = :owner
        AND name = :procedureName
        AND type = 'PROCEDURE'
      ORDER BY sequence
    `, {
      owner: this._normalizeOracleIdentifier(owner),
      procedureName: PROCEDURE_NAME
    }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    return (result.rows || []).map((row) => {
      const line = row.LINE != null ? Number(row.LINE) : null;
      const position = row.POSITION != null ? Number(row.POSITION) : null;
      const text = String(row.TEXT || '').trim();
      return `${line != null ? `linha ${line}` : 'linha ?'}${position != null ? `, coluna ${position}` : ''}: ${text}`;
    });
  }

  async _assertProcedureValid(connection, owner, context) {
    const objectInfo = await this._getProcedureStatus(connection, owner);
    if (!objectInfo) {
      throw new Error(
        `[WinthorFix/${dbSwitch.getCurrentEnvName()}] Procedure ${owner}.${PROCEDURE_NAME} nao foi encontrada apos o CREATE OR REPLACE. ` +
        `(sessionUser=${context.sessionUser}, currentSchema=${context.currentSchema})`
      );
    }

    if (String(objectInfo.STATUS || '').toUpperCase() === 'VALID') {
      return;
    }

    const compileErrors = await this._getProcedureCompileErrors(connection, owner);
    const details = compileErrors.length > 0
      ? compileErrors.join(' | ')
      : 'Oracle nao retornou detalhes em ALL_ERRORS.';

    throw new Error(
      `[WinthorFix/${dbSwitch.getCurrentEnvName()}] Procedure ${owner}.${PROCEDURE_NAME} ficou INVALIDA. ` +
      `(sessionUser=${context.sessionUser}, currentSchema=${context.currentSchema}) ` +
      `Erros de compilacao: ${details}`
    );
  }

  _buildProcedureDDL() {
    return `
      CREATE OR REPLACE PROCEDURE ${PROCEDURE_NAME} (
        p_total_lidos OUT NUMBER,
        p_total_corrigidos OUT NUMBER
      ) AS
      BEGIN
        SELECT COUNT(1)
          INTO p_total_lidos
          FROM PCCLIENT P
         WHERE P.DTEXCLUSAO IS NULL;

        MERGE INTO PCCLIENT P
        USING (
          SELECT
            P.CODCLI,
            CASE
              WHEN P.CODREDE IN (1, 6, 11) THEN 'DIAMANTE'
              WHEN P.CODREDE IN (2, 7, 12) THEN 'PLATINUM'
              WHEN P.CODREDE IN (3, 8, 13) THEN 'OURO'
              WHEN P.CODREDE IN (4, 9, 14) THEN 'PRATA'
              WHEN P.CODREDE IN (5, 10, 15) THEN 'BRONZE'
              ELSE NULL
            END AS CATEGORIA_CORRIGIDA
          FROM PCCLIENT P
          WHERE P.DTEXCLUSAO IS NULL
        ) SRC
           ON (P.CODCLI = SRC.CODCLI)
         WHEN MATCHED THEN UPDATE SET
          P.CATEGORIA = SRC.CATEGORIA_CORRIGIDA
         WHERE SRC.CATEGORIA_CORRIGIDA IS NOT NULL
           AND NVL(UPPER(TRIM(P.CATEGORIA)), '#') <> NVL(SRC.CATEGORIA_CORRIGIDA, '#');

        p_total_corrigidos := SQL%ROWCOUNT;
      END;
    `;
  }

  _buildPendenciasSelectSql() {
    return `
      SELECT
        B.CODCLI,
        B.CLIENTE,
        B.FANTASIA,
        B.CODATV1_ATUAL,
        B.CODATV1_CORRIGIDO,
        B.CATEGORIA_ATUAL,
        B.CATEGORIA_CORRIGIDA,
        B.CODREDE_ATUAL,
        B.CODREDE_ATUAL AS CODREDE_CORRIGIDO
      FROM (
        SELECT
          P.CODCLI,
          P.CLIENTE,
          P.FANTASIA,
          P.CODREDE AS CODREDE_ATUAL,
          NULL AS CODATV1_ATUAL,
          P.CATEGORIA AS CATEGORIA_ATUAL,
          CASE
            WHEN P.CODREDE IN (1, 6, 11) THEN 'DIAMANTE'
            WHEN P.CODREDE IN (2, 7, 12) THEN 'PLATINUM'
            WHEN P.CODREDE IN (3, 8, 13) THEN 'OURO'
            WHEN P.CODREDE IN (4, 9, 14) THEN 'PRATA'
            WHEN P.CODREDE IN (5, 10, 15) THEN 'BRONZE'
            ELSE NULL
          END AS CATEGORIA_CORRIGIDA,
          NULL AS CODATV1_CORRIGIDO
        FROM PCCLIENT P
        WHERE P.DTEXCLUSAO IS NULL
      ) B
      WHERE
        B.CATEGORIA_CORRIGIDA IS NOT NULL
        AND NVL(UPPER(TRIM(B.CATEGORIA_ATUAL)), '#') <> NVL(B.CATEGORIA_CORRIGIDA, '#')
      ORDER BY B.CODCLI
    `;
  }

  async _garantirTabelaLogPostgres() {
    if (this.logTableReady || !this.pgPool) return;

    await this.pgPool.query(`
      CREATE TABLE IF NOT EXISTS winthor_correcao_cadastro_log (
        id BIGSERIAL PRIMARY KEY,
        exec_id UUID NOT NULL,
        ambiente VARCHAR(32) NOT NULL,
        codcli INTEGER NOT NULL,
        cliente TEXT,
        fantasia TEXT,
        categoria_ant TEXT,
        categoria_nova TEXT,
        codatv1_ant INTEGER,
        codatv1_novo INTEGER,
        codrede_ant INTEGER,
        codrede_novo INTEGER,
        origem VARCHAR(80) NOT NULL DEFAULT '${LOG_ORIGEM}',
        alterado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB
      )
    `);
    await this.pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_winthor_correcao_cadastro_log_codcli_data
        ON winthor_correcao_cadastro_log (codcli, alterado_em DESC)
    `);
    await this.pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_winthor_correcao_cadastro_log_exec
        ON winthor_correcao_cadastro_log (exec_id)
    `);

    this.logTableReady = true;
  }

  async _registrarLogsCorrecao(ajustes, { execId, ambiente }) {
    if (!Array.isArray(ajustes) || ajustes.length === 0) return 0;
    if (!this.pgPool) {
      this.logger?.warn?.('[WinthorFix] pgPool não configurado, log de correção não será persistido.');
      return 0;
    }

    await this._garantirTabelaLogPostgres();

    const chunkSize = 200;
    let totalInserido = 0;

    for (let i = 0; i < ajustes.length; i += chunkSize) {
      const chunk = ajustes.slice(i, i + chunkSize);
      const values = [];
      const placeholders = chunk.map((r, idx) => {
        const b = idx * 13;
        values.push(
          execId,
          ambiente,
          r.codcli,
          r.cliente || null,
          r.fantasia || null,
          r.categoria_ant || null,
          r.categoria_nova || null,
          r.codatv1_ant,
          r.codatv1_novo,
          r.codrede_ant,
          r.codrede_novo,
          LOG_ORIGEM,
          JSON.stringify({
            regra: 'CODREDE_GERA_CATEGORIA',
            codrede_referencia: r.codrede_novo ?? r.codrede_ant ?? null,
            categoria: { de: r.categoria_ant, para: r.categoria_nova },
            codatv1: { de: r.codatv1_ant, para: r.codatv1_novo },
            codrede: { de: r.codrede_ant, para: r.codrede_novo }
          })
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13}::jsonb)`;
      });

      const insertSql = `
        INSERT INTO winthor_correcao_cadastro_log (
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
          payload
        ) VALUES ${placeholders.join(', ')}
      `;

      await this.pgPool.query(insertSql, values);
      totalInserido += chunk.length;
    }

    return totalInserido;
  }

  async _atualizarPayloadBitrixLog({ execId, codcli, bitrixSync }) {
    if (!this.pgPool) return 0;
    await this._garantirTabelaLogPostgres();

    const result = await this.pgPool.query(`
      UPDATE winthor_correcao_cadastro_log
         SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('bitrix_sync', $1::jsonb)
       WHERE exec_id = $2::uuid
         AND codcli = $3
         AND origem = $4
    `, [
      JSON.stringify(bitrixSync || {}),
      execId,
      codcli,
      LOG_ORIGEM
    ]);

    return Number(result.rowCount || 0);
  }

  _normalizarExecIds(execIds) {
    if (!Array.isArray(execIds)) return [];
    const unicos = new Set();
    for (const raw of execIds) {
      const txt = String(raw || '').trim();
      if (!txt) continue;
      // UUID v4/v1 canonical format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(txt)) {
        continue;
      }
      unicos.add(txt.toLowerCase());
    }
    return [...unicos];
  }

  async _buscarLogsLegadoParaRollback({
    execIds = [],
    codcli = null,
    dataInicio = null,
    dataFim = null,
    limit = 5000
  } = {}) {
    if (!this.pgPool) {
      throw new Error('Pool Postgres nao configurado para rollback legado.');
    }
    await this._garantirTabelaLogPostgres();

    const where = [
      `origem = $1`,
      `(
        (codatv1_ant IS NOT NULL AND codatv1_novo IS NOT NULL AND codatv1_ant <> codatv1_novo)
        OR
        (codrede_ant IS NOT NULL AND codrede_novo IS NOT NULL AND codrede_ant <> codrede_novo)
      )`
    ];
    const params = [LOG_ORIGEM];
    let p = params.length;

    const execIdsNorm = this._normalizarExecIds(execIds);
    if (execIdsNorm.length > 0) {
      p += 1;
      where.push(`exec_id = ANY($${p}::uuid[])`);
      params.push(execIdsNorm);
    }

    if (Number.isFinite(codcli) && Number(codcli) > 0) {
      p += 1;
      where.push(`codcli = $${p}`);
      params.push(Math.trunc(Number(codcli)));
    }

    if (dataInicio) {
      p += 1;
      where.push(`alterado_em >= $${p}::timestamptz`);
      params.push(dataInicio);
    }

    if (dataFim) {
      p += 1;
      where.push(`alterado_em <= $${p}::timestamptz`);
      params.push(dataFim);
    }

    p += 1;
    const limitSafe = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(20000, Math.trunc(Number(limit))))
      : 5000;
    params.push(limitSafe);

    const sql = `
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
        alterado_em
      FROM winthor_correcao_cadastro_log
      WHERE ${where.join('\n        AND ')}
      ORDER BY alterado_em DESC, id DESC
      LIMIT $${p}
    `;

    const result = await this.pgPool.query(sql, params);
    return result.rows || [];
  }

  async _registrarLogsRollback(rollbackRows, { execId, ambiente }) {
    if (!Array.isArray(rollbackRows) || rollbackRows.length === 0) return 0;
    if (!this.pgPool) return 0;
    await this._garantirTabelaLogPostgres();

    const chunkSize = 200;
    let totalInserido = 0;

    for (let i = 0; i < rollbackRows.length; i += chunkSize) {
      const chunk = rollbackRows.slice(i, i + chunkSize);
      const values = [];
      const placeholders = chunk.map((r, idx) => {
        const b = idx * 13;
        values.push(
          execId,
          ambiente,
          r.codcli,
          r.cliente || null,
          r.fantasia || null,
          r.categoria_ant ?? null,
          r.categoria_nova ?? null,
          r.codatv1_ant ?? null,
          r.codatv1_novo ?? null,
          r.codrede_ant ?? null,
          r.codrede_novo ?? null,
          LOG_ORIGEM_ROLLBACK,
          JSON.stringify({
            regra: 'ROLLBACK_LOGS_LEGADOS',
            origem_exec_id: r.origem_exec_id || null,
            origem_log_id: r.origem_log_id || null,
            campos_revertidos: {
              codatv1: Boolean(r.codatv1_revertido),
              codrede: Boolean(r.codrede_revertido)
            }
          })
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13}::jsonb)`;
      });

      const insertSql = `
        INSERT INTO winthor_correcao_cadastro_log (
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
          payload
        ) VALUES ${placeholders.join(', ')}
      `;

      await this.pgPool.query(insertSql, values);
      totalInserido += chunk.length;
    }

    return totalInserido;
  }

  async garantirProcedure({ force = false } = {}) {
    const envKey = dbSwitch.getCurrentEnvKey();
    if (!force && this.procedureReadyByEnv.has(envKey)) {
      return;
    }

    const pool = await this._getPool();
    let connection;
    try {
      connection = await pool.getConnection();
      const context = await this._getOracleSessionContext(connection);
      let ddlError = null;

      try {
        await connection.execute(this._buildProcedureDDL());
      } catch (err) {
        ddlError = err;
      }

      const owner = await this._resolveProcedureOwner(connection, context);
      await this._assertProcedureValid(connection, owner, context);

      if (ddlError && ddlError.errorNum !== 24344) {
        throw ddlError;
      }

      this.procedureReadyByEnv.add(envKey);
      this.procedureOwnerByEnv.set(envKey, owner);
      this.logger?.log?.(
        `[WinthorFix/${dbSwitch.getCurrentEnvName()}] Procedure ${owner}.${PROCEDURE_NAME} pronta.`
      );
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  clearProcedureCache() {
    this.procedureReadyByEnv.clear();
    this.procedureOwnerByEnv.clear();
  }

  async garantirInfraestrutura() {
    await this._garantirTabelaLogPostgres();
  }

  _isProcedureRecoverableError(err) {
    const message = String(err?.message || '').toUpperCase();
    return (
      message.includes('PLS-00201') ||
      message.includes('PLS-00905') ||
      message.includes('ORA-04063') ||
      (message.includes('ORA-06550') && message.includes(PROCEDURE_NAME))
    );
  }

  _normalizarCategoriaBitrix(categoria) {
    const normalized = String(categoria || '').trim().toUpperCase();
    return normalized || null;
  }

  _normalizarRamoBitrix(ramo) {
    const normalized = String(ramo || '')
      .trim()
      .toUpperCase()
      .replace(/\\/g, '/')
      .replace(/\s*\/\s*/g, '/')
      .replace(/\s+/g, ' ');

    return normalized || null;
  }

  _normalizarClassificacaoBitrix(classificacao) {
    const normalized = String(classificacao || '')
      .trim()
      .toUpperCase()
      .replace(/\\/g, '/')
      .replace(/\s*\/\s*/g, '/')
      .replace(/\s*\|\s*/g, '|')
      .replace(/\s+/g, ' ')
      .replace(/\/{2,}/g, '/')
      .replace(/\|{2,}/g, '|');

    if (!normalized) return null;

    const match = normalized.match(/^(.*?)(?:\||\/)(DIAMANTE|PLATINUM|OURO|PRATA|BRONZE)$/);
    if (match) {
      const ramo = this._normalizarRamoBitrix(match[1]);
      const faixa = match[2];
      return ramo ? `${ramo} | ${faixa}` : faixa;
    }

    return normalized.replace(/\|/g, ' | ') || null;
  }

  _mapCodAtvToRamoBitrix(codAtv) {
    const cod = Number(codAtv);
    if (cod === 12) return 'CORPORATIVO/INDUSTRIAL';
    if (cod === 11) return 'SERVICOS';
    if (cod === 10) return 'REVENDA';
    return null;
  }

  _mapCodRedeToRamoBitrix(codRede) {
    const cod = Number(codRede);
    if (!Number.isFinite(cod)) return null;
    if (cod >= 1 && cod <= 5) return 'REVENDA';
    if (cod >= 6 && cod <= 10) return 'SERVICOS';
    if (cod >= 11 && cod <= 15) return 'CORPORATIVO/INDUSTRIAL';
    return null;
  }

  _montarClassificacaoBitrix({ categoria, codatv1, codrede } = {}) {
    const faixa = this._normalizarCategoriaBitrix(categoria);
    if (!faixa) return null;

    const ramo = this._mapCodAtvToRamoBitrix(codatv1)
      || this._mapCodRedeToRamoBitrix(codrede);

    if (!ramo) return null;
    return this._normalizarClassificacaoBitrix(`${ramo}|${faixa}`);
  }

  _determinarStatusBitrixSync(info) {
    const atualizados = Number(info?.atualizados || 0);
    const jaAlinhados = Number(info?.ja_alinhados || 0);
    const erros = Number(info?.erros || 0);
    const encontrados = Number(info?.encontrados || 0);

    if (erros > 0 && (atualizados > 0 || jaAlinhados > 0)) {
      return 'PARCIAL';
    }
    if (erros > 0) return 'ERRO';
    if (atualizados > 0) return 'ATUALIZADO';
    if (jaAlinhados > 0) return 'JA_ALINHADO';
    if (encontrados <= 0) return 'NAO_ENCONTRADO';
    return 'SEM_ACAO';
  }

  async _sincronizarClassificacaoBitrix(ajustes, { ambiente, execId }) {
    const resumo = {
      habilitado: Boolean(this.bitrixService),
      ambiente,
      execId,
      totalPendencias: Array.isArray(ajustes) ? ajustes.length : 0,
      totalProcessados: 0,
      encontrados: 0,
      atualizados: 0,
      jaAlinhados: 0,
      naoEncontrados: 0,
      erros: 0
    };

    if (!this.bitrixService) {
      resumo.motivo = 'BitrixService nao configurado.';
      return resumo;
    }

    const pendencias = (Array.isArray(ajustes) ? ajustes : []).reduce((acc, ajuste) => {
      const codcli = Number(ajuste?.codcli);
      if (!Number.isFinite(codcli) || codcli <= 0) {
        return acc;
      }

      const classificacaoBitrix = this._montarClassificacaoBitrix({
        categoria: ajuste?.categoria_nova,
        codatv1: ajuste?.codatv1_novo ?? ajuste?.codatv1_ant ?? null,
        codrede: ajuste?.codrede_novo ?? ajuste?.codrede_ant ?? null
      });

      if (!classificacaoBitrix) {
        return acc;
      }

      acc.push({
        ...ajuste,
        classificacao_bitrix: classificacaoBitrix
      });
      return acc;
    }, []);

    resumo.totalProcessados = pendencias.length;
    if (!pendencias.length) {
      return resumo;
    }

    for (const ajuste of pendencias) {
      const codcli = Math.trunc(Number(ajuste.codcli));
      const classificacaoBitrixDestino = this._normalizarClassificacaoBitrix(
        ajuste.classificacao_bitrix
      );
      const syncInfo = {
        status: 'PENDENTE',
        lookup_field: 'UF_CRM_1674573988685',
        target_field: 'UF_CRM_1774022930',
        valor_destino: classificacaoBitrixDestino,
        encontrados: 0,
        atualizados: 0,
        ja_alinhados: 0,
        erros: 0,
        detalhes: []
      };

      try {
        const contatos = await this.bitrixService.buscarContatosPorCampo('UF_CRM_1674573988685', codcli, {
          select: ['NAME', 'LAST_NAME', 'UF_CRM_1774022930']
        });

        if (!Array.isArray(contatos) || contatos.length === 0) {
          resumo.naoEncontrados += 1;
          syncInfo.status = 'NAO_ENCONTRADO';
          this.logger?.log?.(`[WinthorFix/${ambiente}] Bitrix sem contato para CODCLI ${codcli}.`);
          await this._atualizarPayloadBitrixLog({ execId, codcli, bitrixSync: syncInfo });
          continue;
        }

        resumo.encontrados += contatos.length;
        syncInfo.encontrados = contatos.length;

        for (const contato of contatos) {
          const bitrixId = Number(contato?.ID);
          const nomeContato = [contato?.NAME, contato?.LAST_NAME].filter(Boolean).join(' ').trim() || null;

          if (!Number.isFinite(bitrixId) || bitrixId <= 0) {
            resumo.erros += 1;
            syncInfo.erros += 1;
            syncInfo.detalhes.push({
              bitrix_id: contato?.ID ?? null,
              nome: nomeContato,
              status: 'ERRO',
              erro: 'ID_INVALIDO'
            });
            continue;
          }

          const categoriaBitrixAtual = this._normalizarClassificacaoBitrix(contato?.UF_CRM_1774022930);
          if (categoriaBitrixAtual === classificacaoBitrixDestino) {
            resumo.jaAlinhados += 1;
            syncInfo.ja_alinhados += 1;
            syncInfo.detalhes.push({
              bitrix_id: bitrixId,
              nome: nomeContato,
              status: 'JA_ALINHADO',
              valor_anterior: categoriaBitrixAtual,
              valor_novo: classificacaoBitrixDestino
            });
            continue;
          }

          const atualizado = await this.bitrixService.atualizarContatoCampos(bitrixId, {
            UF_CRM_1774022930: classificacaoBitrixDestino
          }, {
            contextLabel: `CODCLI ${codcli} -> ${classificacaoBitrixDestino}`
          });

          if (atualizado) {
            resumo.atualizados += 1;
            syncInfo.atualizados += 1;
            syncInfo.detalhes.push({
              bitrix_id: bitrixId,
              nome: nomeContato,
              status: 'ATUALIZADO',
              valor_anterior: categoriaBitrixAtual,
              valor_novo: classificacaoBitrixDestino
            });
          } else {
            resumo.erros += 1;
            syncInfo.erros += 1;
            syncInfo.detalhes.push({
              bitrix_id: bitrixId,
              nome: nomeContato,
              status: 'ERRO',
              valor_anterior: categoriaBitrixAtual,
              valor_novo: classificacaoBitrixDestino,
              erro: 'UPDATE_FALSE'
            });
          }
        }

        syncInfo.status = this._determinarStatusBitrixSync(syncInfo);
        await this._atualizarPayloadBitrixLog({ execId, codcli, bitrixSync: syncInfo });
      } catch (err) {
        resumo.erros += 1;
        syncInfo.erros += 1;
        syncInfo.status = 'ERRO';
        syncInfo.erro = err?.message || String(err);
        syncInfo.detalhes.push({
          status: 'ERRO',
          erro: syncInfo.erro
        });
        this.logger?.error?.(
          `[WinthorFix/${ambiente}] Erro ao sincronizar CODCLI ${codcli} no Bitrix:`,
          err?.message || err
        );
        await this._atualizarPayloadBitrixLog({ execId, codcli, bitrixSync: syncInfo });
      }
    }

    return resumo;
  }

  async executarCorrecao({ forceRecreateProcedure = false } = {}) {
    const envKey = dbSwitch.getCurrentEnvKey();
    await this.garantirProcedure({ force: forceRecreateProcedure });
    await this._garantirTabelaLogPostgres();

    const pool = await this._getPool();
    let connection;
    try {
      connection = await pool.getConnection();
      const procedureRef = this._getProcedureReference(envKey);
      const pendenciasResult = await connection.execute(
        this._buildPendenciasSelectSql(),
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const ajustes = (pendenciasResult.rows || []).map((row) => ({
        codcli: row.CODCLI != null ? Number(row.CODCLI) : null,
        cliente: row.CLIENTE || null,
        fantasia: row.FANTASIA || null,
        categoria_ant: row.CATEGORIA_ATUAL || null,
        categoria_nova: row.CATEGORIA_CORRIGIDA || null,
        codatv1_ant: row.CODATV1_ATUAL != null ? Number(row.CODATV1_ATUAL) : null,
        codatv1_novo: row.CODATV1_CORRIGIDO != null ? Number(row.CODATV1_CORRIGIDO) : null,
        codrede_ant: row.CODREDE_ATUAL != null ? Number(row.CODREDE_ATUAL) : null,
        codrede_novo: row.CODREDE_CORRIGIDO != null ? Number(row.CODREDE_CORRIGIDO) : null
      })).filter((r) => Number.isFinite(r.codcli) && r.codcli > 0);

      const result = await connection.execute(
        `BEGIN ${procedureRef}(:p_total_lidos, :p_total_corrigidos); END;`,
        {
          p_total_lidos: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
          p_total_corrigidos: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
        },
        { autoCommit: true }
      );

      const totalLidos = Number(result.outBinds?.p_total_lidos || 0);
      const totalCorrigidos = Number(result.outBinds?.p_total_corrigidos || 0);
      const execId = gerarUuid();
      const ambiente = dbSwitch.getCurrentEnvName();

      let totalRegistrosLog = 0;
      if (ajustes.length > 0) {
        totalRegistrosLog = await this._registrarLogsCorrecao(ajustes, { execId, ambiente });
      }

      const bitrixSync = await this._sincronizarClassificacaoBitrix(ajustes, { ambiente, execId });

      return {
        ambiente,
        procedure: procedureRef,
        totalLidos,
        totalCorrigidos,
        totalRegistrosLog,
        bitrixSync,
        execId,
        executadoEm: new Date().toISOString()
      };
    } catch (err) {
      if (!forceRecreateProcedure && this._isProcedureRecoverableError(err)) {
        this.procedureReadyByEnv.delete(envKey);
        this.procedureOwnerByEnv.delete(envKey);
        await this.garantirProcedure({ force: true });
        return this.executarCorrecao({ forceRecreateProcedure: true });
      }
      throw err;
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  async executarRollbackLegado({
    execIds = [],
    codcli = null,
    dataInicio = null,
    dataFim = null,
    limit = 5000,
    executarCorrecaoPosRollback = true
  } = {}) {
    await this._garantirTabelaLogPostgres();
    const ambiente = dbSwitch.getCurrentEnvName();
    const logsLegados = await this._buscarLogsLegadoParaRollback({
      execIds,
      codcli,
      dataInicio,
      dataFim,
      limit
    });

    if (!logsLegados.length) {
      return {
        ambiente,
        rollbackExecId: gerarUuid(),
        logsLegadosEncontrados: 0,
        linhasProcessadas: 0,
        codatv1Revertidos: 0,
        codredeRevertidos: 0,
        totalClientesAfetados: 0,
        totalLogsRollback: 0,
        correcaoPosRollback: null,
        executadoEm: new Date().toISOString()
      };
    }

    const pool = await this._getPool();
    let connection;
    let codatv1Revertidos = 0;
    let codredeRevertidos = 0;
    const rollbackRows = [];
    const clientesAfetados = new Set();

    try {
      connection = await pool.getConnection();
      for (const row of logsLegados) {
        const codcliRow = Number(row.codcli);
        if (!Number.isFinite(codcliRow) || codcliRow <= 0) continue;

        const codatv1Ant = row.codatv1_ant != null ? Number(row.codatv1_ant) : null;
        const codatv1Novo = row.codatv1_novo != null ? Number(row.codatv1_novo) : null;
        const codredeAnt = row.codrede_ant != null ? Number(row.codrede_ant) : null;
        const codredeNovo = row.codrede_novo != null ? Number(row.codrede_novo) : null;

        const podeReverterAtv = Number.isFinite(codatv1Ant) && Number.isFinite(codatv1Novo) && codatv1Ant !== codatv1Novo;
        const podeReverterRede = Number.isFinite(codredeAnt) && Number.isFinite(codredeNovo) && codredeAnt !== codredeNovo;
        if (!podeReverterAtv && !podeReverterRede) continue;

        let atvRevertido = false;
        let redeRevertido = false;

        if (podeReverterAtv) {
          const upAtv = await connection.execute(
            `
              UPDATE PCCLIENT
                 SET CODATV1 = :codatv1_ant
               WHERE CODCLI = :codcli
                 AND CODATV1 = :codatv1_novo
            `,
            {
              codcli: codcliRow,
              codatv1_ant: codatv1Ant,
              codatv1_novo: codatv1Novo
            },
            { autoCommit: false }
          );
          const n = Number(upAtv.rowsAffected || 0);
          if (n > 0) {
            codatv1Revertidos += n;
            atvRevertido = true;
          }
        }

        if (podeReverterRede) {
          const upRede = await connection.execute(
            `
              UPDATE PCCLIENT
                 SET CODREDE = :codrede_ant
               WHERE CODCLI = :codcli
                 AND CODREDE = :codrede_novo
            `,
            {
              codcli: codcliRow,
              codrede_ant: codredeAnt,
              codrede_novo: codredeNovo
            },
            { autoCommit: false }
          );
          const n = Number(upRede.rowsAffected || 0);
          if (n > 0) {
            codredeRevertidos += n;
            redeRevertido = true;
          }
        }

        if (atvRevertido || redeRevertido) {
          clientesAfetados.add(codcliRow);
          rollbackRows.push({
            origem_log_id: row.id != null ? Number(row.id) : null,
            origem_exec_id: row.exec_id || null,
            codcli: codcliRow,
            cliente: row.cliente || null,
            fantasia: row.fantasia || null,
            categoria_ant: row.categoria_nova || null,
            categoria_nova: row.categoria_ant || null,
            codatv1_ant: podeReverterAtv ? codatv1Novo : null,
            codatv1_novo: podeReverterAtv ? codatv1Ant : null,
            codrede_ant: podeReverterRede ? codredeNovo : null,
            codrede_novo: podeReverterRede ? codredeAnt : null,
            codatv1_revertido: atvRevertido,
            codrede_revertido: redeRevertido
          });
        }
      }

      if (rollbackRows.length > 0) {
        await connection.commit();
      } else {
        await connection.rollback();
      }
    } catch (err) {
      if (connection) {
        try { await connection.rollback(); } catch (_) {}
      }
      throw err;
    } finally {
      if (connection) {
        await connection.close();
      }
    }

    const rollbackExecId = gerarUuid();
    const totalLogsRollback = await this._registrarLogsRollback(rollbackRows, {
      execId: rollbackExecId,
      ambiente
    });

    let correcaoPosRollback = null;
    if (executarCorrecaoPosRollback) {
      correcaoPosRollback = await this.executarCorrecao();
    }

    return {
      ambiente,
      rollbackExecId,
      logsLegadosEncontrados: logsLegados.length,
      linhasProcessadas: rollbackRows.length,
      codatv1Revertidos,
      codredeRevertidos,
      totalClientesAfetados: clientesAfetados.size,
      totalLogsRollback,
      correcaoPosRollback,
      executadoEm: new Date().toISOString()
    };
  }
}

module.exports = WinthorCadastroCorrecaoService;

// performance-clientes.js
// Indicador de Performance por Cliente â€” compatÃ­vel com 8145
// - Thick mode (Instant Client)
// - CURRENT_SCHEMA automÃ¡tico
// - ResoluÃ§Ã£o dinÃ¢mica de nomes (PCNFENT, PCMOV etc.)
// - CTEs alinhadas ao SQL da 8145 para DEVOLUÃ‡Ã•ES e FRETE

const oracledb = require('oracledb');
const fs = require('fs');
const csv = require('csv-writer').createObjectCsvWriter;
const NodeCache = require('node-cache');
const dbSwitch = require('./db-switch');

// Configuracao Oracle centralizada em db-switch.js.

// Schema fixo opcional via ENV (se quiser forÃ§ar)
const FIXED_SCHEMA = (process.env.ORACLE_SCHEMA || '').trim();

// Cache para consultas (5 minutos)
const queryCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

function clearQueryCache() {
  try {
    queryCache.flushAll();
    console.log('ðŸ§¹ queryCache (PerformanceClientes) limpo com sucesso');
  } catch (err) {
    console.error('Erro ao limpar queryCache:', err.message || err);
  }
}

// ================= Thick mode (Instant Client) =============
function configureOracleClient() {
  try {
    console.log('ðŸ”§ Configurando Oracle Client...');
    const paths = [
      'C:\\instantclient_19_28',
      process.env.ORACLE_HOME,
      process.env.ORACLE_CLIENT_HOME,
    ].filter(Boolean);

    let ok = false;
    for (const p of paths) {
      try {
        if (p && fs.existsSync(p)) {
          console.log(`ðŸ“ Tentando inicializar Oracle Client em: ${p}`);
          oracledb.initOracleClient({ libDir: p });
          console.log(`âœ… Oracle Client inicializado em: ${p}`);
          ok = true;
          break;
        }
      } catch (e) {
        console.log(`âŒ Falha em ${p}: ${e.message}`);
      }
    }
    if (!ok) {
      console.log('âš ï¸  Oracle Client nÃ£o encontrado em paths conhecidos. Tentando PATH do sistema...');
      oracledb.initOracleClient();
      console.log('âœ… Oracle Client inicializado via PATH');
    }
    console.log('âœ… ConfiguraÃ§Ã£o do Oracle Client concluÃ­da');
  } catch (err) {
    console.error('âŒ Erro na configuraÃ§Ã£o do Oracle Client:', err.message);
    throw err;
  }
}

// Inicializar apenas uma vez
if (!oracledb.oracleClientVersion) {
  configureOracleClient();
}

// ============== Helpers robustos de execuÃ§Ã£o ===============
const BIND_NAME_RE = /:(\w+)/g;

function sanitizeBinds(binds = {}) {
  const out = {};
  for (const [k, v] of Object.entries(binds)) out[k] = (typeof v === 'undefined') ? null : v;
  return out;
}

function expandInClause(sql, binds = {}) {
  let newSql = sql;
  const newBinds = { ...binds };
  for (const [name, value] of Object.entries(binds)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        newSql = newSql.replace(new RegExp(':' + name + '\\b', 'g'), 'NULL');
        delete newBinds[name];
        continue;
      }
      const ph = value.map((_, i) => `:${name}_${i}`).join(',');
      newSql = newSql.replace(new RegExp(':' + name + '\\b', 'g'), ph);
      value.forEach((item, i) => { newBinds[`${name}_${i}`] = item; });
      delete newBinds[name];
    }
  }
  return { sql: newSql, binds: newBinds };
}

function validateBinds(sql, binds = {}) {
  const inSql = new Set();
  for (const m of sql.matchAll(BIND_NAME_RE)) inSql.add(m[1]);
  const inObj = new Set(Object.keys(binds));
  const missing = [...inSql].filter(n => !inObj.has(n));
  const extra = [...inObj].filter(n => !inSql.has(n));
  if (missing.length || extra.length) {
    const err = new Error(`Bind mismatch: faltando=[${missing.join(', ')}] sobrando=[${extra.join(', ')}]`);
    err.missing = missing; err.extra = extra; err.sql = sql; err.binds = binds;
    throw err;
  }
}

async function execSQL(conn, sql, binds = {}, options = {}) {
  let b = sanitizeBinds(binds);
  const expanded = expandInClause(sql, b);
  const finalSql = expanded.sql;
  b = expanded.binds;

  validateBinds(finalSql, b);

  const execOpts = {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    autoCommit: false,
    ...options,
  };

  try {
    return await conn.execute(finalSql, b, execOpts);
  } catch (e) {
    console.error('[execSQL] Falha ao executar SQL');
    console.error('SQL  :', finalSql);
    console.error('Binds:', b);
    console.error('Erro :', e);
    throw e;
  }
}

// ============== Resolver dinÃ¢mico de Schema e Tabelas ==============
async function detectOwner(conn, candidates = ['PCPEDC','PCNFSAID','PCCLIENTE','PCCLIENT','PCPEDI']) {
  const sql = `
    SELECT owner, object_name
    FROM all_objects
    WHERE UPPER(object_name) IN (${candidates.map((_,i)=>`:n${i}`).join(',')})
      AND object_type IN ('TABLE','VIEW','SYNONYM')
    ORDER BY owner
  `;
  const binds = {};
  candidates.forEach((n,i)=> binds[`n${i}`] = n.toUpperCase());
  const rs = await execSQL(conn, sql, binds);
  if (!rs.rows || rs.rows.length === 0) return null;
  return rs.rows[0].OWNER;
}

async function setCurrentSchemaAuto(conn) {
  try {
    if (FIXED_SCHEMA) {
      await execSQL(conn, `ALTER SESSION SET CURRENT_SCHEMA = ${FIXED_SCHEMA}`);
      console.log(`âœ… CURRENT_SCHEMA definido via ENV para: ${FIXED_SCHEMA}`);
      return;
    }
    let owner = await detectOwner(conn);
    if (!owner) {
      const rs = await execSQL(conn, `
        SELECT owner
        FROM all_tab_columns
        WHERE UPPER(column_name) IN ('NUMTRANSVENDA','PVENDA','QT')
        GROUP BY owner, table_name
        HAVING COUNT(DISTINCT UPPER(column_name)) >= 3
        ORDER BY owner
      `);
      owner = rs.rows?.[0]?.OWNER || null;
    }
    if (!owner) {
      console.log('âš ï¸  NÃ£o foi possÃ­vel inferir o CURRENT_SCHEMA automaticamente.');
      return;
    }
    await execSQL(conn, `ALTER SESSION SET CURRENT_SCHEMA = ${owner}`);
    console.log(`âœ… CURRENT_SCHEMA definido automaticamente para: ${owner}`);
  } catch (e) {
    console.log('âš ï¸  Falha ao definir CURRENT_SCHEMA automaticamente:', e.message);
  }
}

async function findBySynonym(conn, names) {
  const sql = `
    SELECT owner, synonym_name, table_owner, table_name
    FROM all_synonyms
    WHERE UPPER(synonym_name) IN (${names.map((_, i) => `:n${i}`).join(',')})
  `;
  const binds = {};
  names.forEach((n, i) => binds[`n${i}`] = n.toUpperCase());
  const rs = await execSQL(conn, sql, binds);
  if (!rs.rows || rs.rows.length === 0) return null;
  const r = rs.rows[0];
  if (r.TABLE_OWNER && r.TABLE_NAME) return `${r.TABLE_OWNER}.${r.TABLE_NAME}`;
  return r.OWNER + '.' + r.SYNONYM_NAME;
}

async function findByAllObjects(conn, names) {
  const sql = `
    SELECT owner, object_name
    FROM all_objects
    WHERE UPPER(object_name) IN (${names.map((_, i) => `:n${i}`).join(',')})
      AND object_type IN ('TABLE','VIEW')
    ORDER BY owner
  `;
  const binds = {};
  names.forEach((n, i) => binds[`n${i}`] = n.toUpperCase());
  const rs = await execSQL(conn, sql, binds);
  if (!rs.rows || rs.rows.length === 0) return null;
  const r = rs.rows[0];
  return `${r.OWNER}.${r.OBJECT_NAME}`;
}

async function findBySignatureNFItem(conn) {
  const sql = `
    WITH tabs AS (
      SELECT owner, table_name
      FROM all_tab_columns
      WHERE UPPER(column_name) IN ('NUMTRANSVENDA','PVENDA','QT')
      GROUP BY owner, table_name
      HAVING COUNT(DISTINCT UPPER(column_name)) >= 3
    )
    SELECT owner, table_name
    FROM tabs
    WHERE table_name LIKE 'PC%'
    ORDER BY owner, table_name
  `;
  const rs = await execSQL(conn, sql, {});
  if (!rs.rows || rs.rows.length === 0) return null;
  const r = rs.rows[0];
  return `${r.OWNER}.${r.TABLE_NAME}`;
}

async function resolveTableNames(conn) {
  const candidates = {
    PCPEDC:      ['PCPEDC'],
    PCPEDI:      ['PCPEDI'],
    PCPRODUT:    ['PCPRODUT', 'PCPRODUTO'],
    PCNFSAID:    ['PCNFSAID'],
    PCNFENT:     ['PCNFENT'],
    PCMOV:       ['PCMOV'],
    PCNFITEM:    ['PCNFITEM','PCNFSAIDITEM','PCNFITENS','PCINDI','PCNFITE'],
    PCCLIENT:    ['PCCLIENTE','PCCLIENT'],
    PCUSUARI:    ['PCUSUARI','PCUSUARIO'],
    PCATIVI:     ['PCATIVI','PCATIVIDADE'],
    PCREDECLIENTE: ['PCREDECLIENTE','PCREDECLI','PC_REDE_CLIENTE'],
    PCPREST:     ['PCPREST'],
  };

  const found = {};
  for (const [logical, names] of Object.entries(candidates)) {
    const objBySyn = await findBySynonym(conn, names);
    if (objBySyn) { found[logical] = objBySyn; continue; }

    const objByAll = await findByAllObjects(conn, names);
    if (objByAll) { found[logical] = objByAll; continue; }

    if (logical === 'PCNFITEM') {
      const sig = await findBySignatureNFItem(conn);
      if (sig) { found[logical] = sig; continue; }
    }
    if (!found[logical]) {
      throw new Error(`Objeto nÃ£o encontrado com nenhum nome candidato: ${logical} => [${names.join(', ')}]. Verifique grants/sinÃ´nimos/schema.`);
    }
  }

  console.log('ðŸ”Ž Objetos resolvidos:', found);
  return found;
}

// =================== Pool Global de ConexÃµes =====================
/*let connectionPool;

async function initPool() {
  try {
    connectionPool = await oracledb.createPool(dbConfig);
    console.log('âœ… Pool de conexÃµes Oracle criado');
  } catch (err) {
    console.error('âŒ Erro ao criar pool:', err);
    throw err;
  }
}

// Inicializar o pool ao carregar o mÃ³dulo
initPool();*/

// =================== Classe principal ======================
class PerformanceClientes {
  constructor() {
    this.connection = null;
    this.dtIni = null;
    this.dtFim = null;
    this.T = null;
  }

// --- ALTERAÃ‡ÃƒO PRINCIPAL AQUI ---
  // ObtÃ©m o Pool dinamicamente do db-switch
  async _getPool() {
    let pool = dbSwitch.getPool();

    if (!pool) {
        const configAtual = dbSwitch.getConfig();
        const nomeAmbiente = dbSwitch.getCurrentEnvName();
        console.log(`[PerformanceClientes] Inicializando Pool para: ${nomeAmbiente}`);
        
        try {
            pool = await oracledb.createPool(configAtual);
            dbSwitch.setPool(pool);
            console.log('âœ… Pool criado e salvo no dbSwitch.');
        } catch (err) {
            console.error('âŒ Erro ao criar pool:', err);
            throw err;
        }
    }
    return pool;
  }

  async connect() {
    try {
      const pool = await this._getPool(); // Pega o pool atual
      this.connection = await pool.getConnection();
      
      console.log(`ðŸ”Œ Conectado ao Oracle (${dbSwitch.getCurrentEnvName()})`);
      
      await setCurrentSchemaAuto(this.connection);
      this.T = await resolveTableNames(this.connection);
    } catch (err) {
      console.error('Erro na conexÃ£o:', err);
      throw err;
    }
  }

  async disconnect() {
    if (!this.connection) return;
    try {
      await this.connection.close();
      console.log('ConexÃ£o liberada para o pool');
    } catch (err) {
      console.error('Erro ao liberar conexÃ£o:', err);
    }
  }

async calcularPerformance(params) {
    try {
      await this.connect();
      this.dtIni = params.DataIni;
      this.dtFim = params.DataFim;

      console.log('â³ Buscando dados (Vendas + TÃ­tulos) em paralelo...');
      
      // 1. Executa sua query original + a nova query de tÃ­tulos AO MESMO TEMPO
      const [dadosClientes, todosTitulos] = await Promise.all([
          this.executarConsultaPrincipal(params), // Sua query complexa original (MANTIDA)
          this.buscarTitulos(params)              // A nova query leve
      ]);
      
      console.log(`âœ… Dados carregados. Clientes: ${dadosClientes.length}, TÃ­tulos: ${todosTitulos.length}`);

      if (dadosClientes.length === 0) return [];

      // 2. Agrupa tÃ­tulos por cliente (Map para velocidade extrema)
      const mapaTitulos = new Map();
      for (const t of todosTitulos) {
          // Agrupa apenas pelo cÃ³digo do cliente para facilitar
          // (Se sua lÃ³gica de nota AU for mensal, filtre por mÃªs dentro do loop abaixo)
          if (!mapaTitulos.has(t.CODCLI)) mapaTitulos.set(t.CODCLI, []);
          mapaTitulos.get(t.CODCLI).push(t);
      }

      // 3. Calcula notas na memÃ³ria
      const resultados = [];
      
      for (const c of dadosClientes) {
          // Pega os tÃ­tulos deste cliente
          const titulosDoCliente = mapaTitulos.get(c.CODCLI) || [];
          
          // Filtra titulos do mes/ano da linha usando data de baixa/pagamento.
          const titulosDoMes = titulosDoCliente.filter(t => {
              const dataRef = t.DTBAIXA || t.DTPAG || t.DTVENC;
              if (!dataRef) return false;
              const d = new Date(dataRef);
              return (d.getMonth() + 1) === parseInt(c.MES) && d.getFullYear() === parseInt(c.ANO);
          });

          const notas = await this.calcularTodasNotas(c, titulosDoMes);
          
          const mediaPonderada = this.calcularMediaPonderada(notas);
          const classificacao = this.getClassificacao(mediaPonderada);

          resultados.push({ 
            ...c, 
            ...notas, 
            MEDIA_PONDERADA: mediaPonderada,
            CLASSIFICACAO: classificacao 
          });
      }

      return resultados;

    } catch (err) {
      console.error('Erro no cÃ¡lculo de performance:', err);
      throw err;
    } finally {
      await this.disconnect();
    }
  }

  async buscarInsightsProdutos(params) {
    try {
      await this.connect();
      const topProdutos = await this.buscarTopProdutosCliente(params);
      const sugestoes = this.gerarSugestoesProdutos(topProdutos);
      const resumo = this.gerarResumoTopProdutos(topProdutos);
      return { topProdutos, sugestoes, resumo };
    } catch (err) {
      console.error('Erro ao buscar insights de produtos:', err);
      throw err;
    } finally {
      await this.disconnect();
    }
  }

  async buscarPedidosInsights(params) {
    try {
      await this.connect();
      const pedidos = await this.buscarPedidosClienteDetalhado(params);
      const resumo = this.gerarResumoPedidos(pedidos);
      return { pedidos, resumo };
    } catch (err) {
      console.error('Erro ao buscar insights de pedidos:', err);
      throw err;
    } finally {
      await this.disconnect();
    }
  }

  async buscarTopProdutosCliente(params) {
    const envKey = dbSwitch.getCurrentEnvKey ? dbSwitch.getCurrentEnvKey() : 'DEFAULT';
    const cacheKey = JSON.stringify({
      env: envKey,
      queryVersion: 'v1_top_produtos_cliente',
      ClienteCod: params.ClienteCod,
      DataIni: params.DataIni,
      DataFim: params.DataFim,
      CodFilial: params.CodFilial,
      TopN: params.TopN || 12,
    });

    const cached = queryCache.get(cacheKey);
    if (cached) return cached;

    const T = this.T;
    const topN = Number(params.TopN || 12);

    const sql = `
      WITH base AS (
        SELECT
          p.CODPROD,
          NVL(TRIM(pr.DESCRICAO), 'PRODUTO ' || TO_CHAR(p.CODPROD)) AS PRODUTO,
          SUM(NVL(p.QT, 0)) AS QT_TOTAL,
          SUM(NVL(p.QT, 0) * (NVL(p.PVENDA, 0) + NVL(p.VLOUTRASDESP, 0))) AS VL_TOTAL,
          COUNT(DISTINCT c.NUMPED) AS QTD_PEDIDOS,
          MAX(s.DTSAIDA) AS ULTIMA_COMPRA
        FROM ${T.PCPEDC} c
        JOIN ${T.PCPEDI} p    ON p.NUMPED = c.NUMPED
        JOIN ${T.PCNFSAID} s  ON s.NUMTRANSVENDA = c.NUMTRANSVENDA
        LEFT JOIN ${T.PCPRODUT} pr ON pr.CODPROD = p.CODPROD
        WHERE c.CODCLI = :ClienteCod
          AND s.DTSAIDA BETWEEN TO_DATE(:DataIni, 'DD/MM/YYYY') AND TO_DATE(:DataFim, 'DD/MM/YYYY')
          AND c.DTCANCEL IS NULL
          AND c.CODFILIAL IN (:CodFilial)
          AND c.POSICAO = 'F'
          AND c.CONDVENDA IN (1,2,3,7,9,14,15,17,18,19,98)
        GROUP BY p.CODPROD, NVL(TRIM(pr.DESCRICAO), 'PRODUTO ' || TO_CHAR(p.CODPROD))
      ),
      ranked AS (
        SELECT
          b.*,
          ROW_NUMBER() OVER (ORDER BY b.QT_TOTAL DESC, b.VL_TOTAL DESC, b.CODPROD ASC) AS RN
        FROM base b
      )
      SELECT
        CODPROD,
        PRODUTO,
        QT_TOTAL,
        VL_TOTAL,
        QTD_PEDIDOS,
        ULTIMA_COMPRA,
        RN
      FROM ranked
      WHERE RN <= :TopN
      ORDER BY RN
    `;

    const binds = {
      ClienteCod: Number(params.ClienteCod),
      DataIni: params.DataIni,
      DataFim: params.DataFim,
      CodFilial: params.CodFilial,
      TopN: topN,
    };

    const rs = await execSQL(this.connection, sql, binds);
    const rows = rs.rows || [];

    const totalQtd = rows.reduce((acc, row) => acc + (Number(row.QT_TOTAL) || 0), 0);
    const totalValor = rows.reduce((acc, row) => acc + (Number(row.VL_TOTAL) || 0), 0);

    const produtos = rows.map((row) => {
      const qtdTotal = Number(row.QT_TOTAL) || 0;
      const valorTotal = Number(row.VL_TOTAL) || 0;
      const pedidos = Number(row.QTD_PEDIDOS) || 0;
      const ultimaCompraDate = row.ULTIMA_COMPRA ? new Date(row.ULTIMA_COMPRA) : null;
      const ultimaCompra = ultimaCompraDate && !Number.isNaN(ultimaCompraDate.getTime())
        ? ultimaCompraDate.toISOString()
        : null;

      return {
        posicao: Number(row.RN) || 0,
        codprod: Number(row.CODPROD) || 0,
        produto: row.PRODUTO || `PRODUTO ${row.CODPROD}`,
        qtdTotal,
        valorTotal,
        pedidos,
        ultimaCompra,
        participacaoQtd: totalQtd > 0 ? Number(((qtdTotal / totalQtd) * 100).toFixed(2)) : 0,
        participacaoValor: totalValor > 0 ? Number(((valorTotal / totalValor) * 100).toFixed(2)) : 0,
      };
    });

    queryCache.set(cacheKey, produtos);
    return produtos;
  }

  async buscarPedidosClienteDetalhado(params) {
    const envKey = dbSwitch.getCurrentEnvKey ? dbSwitch.getCurrentEnvKey() : 'DEFAULT';
    const cacheKey = JSON.stringify({
      env: envKey,
      queryVersion: 'v1_pedidos_cliente_detalhado',
      ClienteCod: params.ClienteCod,
      DataIni: params.DataIni,
      DataFim: params.DataFim,
      CodFilial: params.CodFilial,
    });

    const cached = queryCache.get(cacheKey);
    if (cached) return cached;

    const T = this.T;
    const filtrosBase = `
      c.CODCLI = :ClienteCod
      AND s.DTSAIDA BETWEEN TO_DATE(:DataIni, 'DD/MM/YYYY') AND TO_DATE(:DataFim, 'DD/MM/YYYY')
      AND c.DTCANCEL IS NULL
      AND c.CODFILIAL IN (:CodFilial)
      AND c.POSICAO = 'F'
      AND c.CONDVENDA IN (1,2,3,7,9,14,15,17,18,19,98)
    `;

    const sqlPedidos = `
      SELECT
        c.NUMPED,
        MAX(s.DTSAIDA) AS DT_PEDIDO,
        SUM(NVL(p.QT, 0)) AS QTD_ITENS,
        COUNT(DISTINCT p.CODPROD) AS QTD_PRODUTOS,
        SUM(NVL(p.QT, 0) * (NVL(p.PVENDA, 0) + NVL(p.VLOUTRASDESP, 0))) AS VL_TOTAL
      FROM ${T.PCPEDC} c
      JOIN ${T.PCPEDI} p    ON p.NUMPED = c.NUMPED
      JOIN ${T.PCNFSAID} s  ON s.NUMTRANSVENDA = c.NUMTRANSVENDA
      WHERE ${filtrosBase}
      GROUP BY c.NUMPED
      ORDER BY MAX(s.DTSAIDA), c.NUMPED
    `;

    const sqlItens = `
      SELECT
        c.NUMPED,
        p.CODPROD,
        NVL(TRIM(pr.DESCRICAO), 'PRODUTO ' || TO_CHAR(p.CODPROD)) AS PRODUTO,
        SUM(NVL(p.QT, 0)) AS QT_TOTAL,
        SUM(NVL(p.QT, 0) * (NVL(p.PVENDA, 0) + NVL(p.VLOUTRASDESP, 0))) AS VL_TOTAL
      FROM ${T.PCPEDC} c
      JOIN ${T.PCPEDI} p    ON p.NUMPED = c.NUMPED
      JOIN ${T.PCNFSAID} s  ON s.NUMTRANSVENDA = c.NUMTRANSVENDA
      LEFT JOIN ${T.PCPRODUT} pr ON pr.CODPROD = p.CODPROD
      WHERE ${filtrosBase}
      GROUP BY c.NUMPED, p.CODPROD, NVL(TRIM(pr.DESCRICAO), 'PRODUTO ' || TO_CHAR(p.CODPROD))
      ORDER BY c.NUMPED, QT_TOTAL DESC, VL_TOTAL DESC, p.CODPROD
    `;

    const binds = {
      ClienteCod: Number(params.ClienteCod),
      DataIni: params.DataIni,
      DataFim: params.DataFim,
      CodFilial: params.CodFilial,
    };

    const rsPedidos = await execSQL(this.connection, sqlPedidos, binds);
    const rsItens = await execSQL(this.connection, sqlItens, binds);
    const rowsPedidos = rsPedidos.rows || [];
    const rowsItens = rsItens.rows || [];

    const itensPorPedido = new Map();
    for (const row of rowsItens) {
      const numped = Number(row.NUMPED) || 0;
      if (!itensPorPedido.has(numped)) itensPorPedido.set(numped, []);
      itensPorPedido.get(numped).push({
        codprod: Number(row.CODPROD) || 0,
        produto: row.PRODUTO || `PRODUTO ${row.CODPROD}`,
        qtd: Number(row.QT_TOTAL) || 0,
        valorTotal: Number(row.VL_TOTAL) || 0,
      });
    }

    const pedidos = rowsPedidos.map((row) => {
      const numped = Number(row.NUMPED) || 0;
      const dtPedido = row.DT_PEDIDO ? new Date(row.DT_PEDIDO) : null;
      const dataPedido = dtPedido && !Number.isNaN(dtPedido.getTime())
        ? dtPedido.toISOString()
        : null;

      return {
        numped,
        dataPedido,
        valorTotal: Number(row.VL_TOTAL) || 0,
        qtdItens: Number(row.QTD_ITENS) || 0,
        qtdProdutos: Number(row.QTD_PRODUTOS) || 0,
        itens: itensPorPedido.get(numped) || [],
      };
    });

    queryCache.set(cacheKey, pedidos);
    return pedidos;
  }

  gerarSugestoesProdutos(topProdutos) {
    if (!Array.isArray(topProdutos) || topProdutos.length === 0) return [];

    const hoje = new Date();
    const sugestoes = [];

    topProdutos.slice(0, 6).forEach((item, idx) => {
      const dtUltimaCompra = item.ultimaCompra ? new Date(item.ultimaCompra) : null;
      const diasSemCompra = dtUltimaCompra && !Number.isNaN(dtUltimaCompra.getTime())
        ? Math.floor((hoje.getTime() - dtUltimaCompra.getTime()) / 86400000)
        : null;

      let tipo = 'oportunidade';
      let titulo = `Aumentar mix com ${item.produto}`;
      let descricao = `Produto recorrente na carteira. Participação: ${item.participacaoQtd}% do volume top.`;
      let prioridade = 70 - idx;

      if (diasSemCompra === null || diasSemCompra > 45) {
        tipo = 'reativacao';
        titulo = `Reofertar ${item.produto}`;
        descricao = diasSemCompra === null
          ? 'Sem compra recente registrada no período. Bom candidato para reativação.'
          : `Última compra há ${diasSemCompra} dias. Vale ativar nova oferta para retomada.`;
        prioridade = 100 - idx;
      } else if (item.pedidos >= 3) {
        tipo = 'recorrencia';
        titulo = `Manter recorrência de ${item.produto}`;
        descricao = `Produto com ${item.pedidos} pedidos no período. Oportunidade de aumentar ticket médio.`;
        prioridade = 85 - idx;
      }

      sugestoes.push({
        tipo,
        prioridade,
        codprod: item.codprod,
        produto: item.produto,
        titulo,
        descricao,
      });
    });

    const unicos = [];
    const vistos = new Set();
    for (const s of sugestoes.sort((a, b) => b.prioridade - a.prioridade)) {
      if (vistos.has(s.codprod)) continue;
      vistos.add(s.codprod);
      unicos.push(s);
      if (unicos.length >= 5) break;
    }
    return unicos;
  }

  gerarResumoTopProdutos(topProdutos) {
    if (!Array.isArray(topProdutos) || topProdutos.length === 0) {
      return {
        totalProdutos: 0,
        qtdTotal: 0,
        valorTotal: 0,
        produtoLider: null,
      };
    }

    const qtdTotal = topProdutos.reduce((acc, p) => acc + (Number(p.qtdTotal) || 0), 0);
    const valorTotal = topProdutos.reduce((acc, p) => acc + (Number(p.valorTotal) || 0), 0);

    return {
      totalProdutos: topProdutos.length,
      qtdTotal: Number(qtdTotal.toFixed(2)),
      valorTotal: Number(valorTotal.toFixed(2)),
      produtoLider: topProdutos[0]?.produto || null,
    };
  }

  gerarResumoPedidos(pedidos) {
    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      return {
        totalPedidos: 0,
        valorTotal: 0,
        qtdItens: 0,
        ticketMedio: 0,
      };
    }

    const totalPedidos = pedidos.length;
    const valorTotal = pedidos.reduce((acc, p) => acc + (Number(p.valorTotal) || 0), 0);
    const qtdItens = pedidos.reduce((acc, p) => acc + (Number(p.qtdItens) || 0), 0);
    const ticketMedio = totalPedidos > 0 ? (valorTotal / totalPedidos) : 0;

    return {
      totalPedidos,
      valorTotal: Number(valorTotal.toFixed(2)),
      qtdItens: Number(qtdItens.toFixed(2)),
      ticketMedio: Number(ticketMedio.toFixed(2)),
    };
  }

  getClassificacao(media) {
    if (media < 6.0) return 'BRONZE';
    else if (media >= 6.0 && media < 7.0) return 'PRATA';
    else if (media >= 7.0 && media < 8.0) return 'OURO';
    else if (media >= 8.0 && media < 9.0) return 'PLATINUM';
    else return 'DIAMANTE';
  }

async executarConsultaPrincipal(params) {
  // Inclui o ambiente atual na chave do cache
  const envKey = dbSwitch.getCurrentEnvKey ? dbSwitch.getCurrentEnvKey() : 'DEFAULT';
  const cacheKey = JSON.stringify({ env: envKey, queryVersion: 'v3_fantasia_cnpj', ...params });

  const cached = queryCache.get(cacheKey);
    
  if (cached) {
    console.log('ðŸ“¦ Retornando dados do cache');
    return cached;
  }

  const T = this.T;
  const temFiltroCliente = Boolean(params.ClienteCod || params.ClienteNome || params.Cnpj);
  const filtroBaseClientes = params.ClienteCod
    ? 'AND c.CODCLI = :ClienteCod'
    : (temFiltroCliente ? '' : 'AND c.CODCLI IN (SELECT DISTINCT CODCLI FROM vendas)');

    // ======= CTEs otimizadas com hints de paralelismo =======
const sql = `
      WITH 
      -- 1. GERADOR DE MESES (CALENDÃRIO)
      calendar AS (
        SELECT TO_CHAR(ADD_MONTHS(TRUNC(TO_DATE(:DataIni, 'DD/MM/YYYY'), 'MM'), LEVEL - 1), 'MM/YYYY') AS MES_ANO,
               TO_CHAR(ADD_MONTHS(TRUNC(TO_DATE(:DataIni, 'DD/MM/YYYY'), 'MM'), LEVEL - 1), 'MM') AS MES,
               TO_CHAR(ADD_MONTHS(TRUNC(TO_DATE(:DataIni, 'DD/MM/YYYY'), 'MM'), LEVEL - 1), 'YYYY') AS ANO,
               ADD_MONTHS(TRUNC(TO_DATE(:DataIni, 'DD/MM/YYYY'), 'MM'), LEVEL - 1) AS DT_REF
        FROM DUAL
        CONNECT BY LEVEL <= MONTHS_BETWEEN(TRUNC(TO_DATE(:DataFim, 'DD/MM/YYYY'), 'MM'), TRUNC(TO_DATE(:DataIni, 'DD/MM/YYYY'), 'MM')) + 1
      ),

      -- 2. DADOS DE VENDAS
      vendas AS (
        SELECT /*+ PARALLEL(4) */
          c.CODCLI,
          TO_CHAR(s.DTSAIDA, 'MM/YYYY') AS MES_ANO,
          SUM(NVL(p.QT,0) * ( NVL(p.PVENDA,0) + NVL(p.VLOUTRASDESP,0) + NVL(p.VLFRETE,0) )) AS VLVENDA,
          SUM(NVL(p.QT,0) * NVL(p.PVENDA,0))  AS VLVENDA_PROD,
          SUM(NVL(p.QT,0) * NVL(p.PTABELA,0)) AS VLTABELA_PROD,
          COUNT(DISTINCT s.NUMNOTA) AS QTD_NOTAS,
          COUNT(DISTINCT c.NUMPED) AS QTD_PEDIDOS,
          COUNT(DISTINCT p.CODPROD) AS MIX_ITENS,
          SUM(NVL(p.QT,0)) AS QTD_ITENS_FATURADOS,
          AVG(c.PRAZOMEDIO) AS PRAZO_MEDIO_PEDIDO,
          MAX(c.CODCOB) AS CODCOB_PEDIDO,
          COUNT(DISTINCT c.CODCOB) AS QTD_CODCOB_NO_MES,
          -- Seu desconto â€œgeralâ€ (mantido)
          SUM( (NVL(p.PTABELA,0) - NVL(p.PVENDA,0)) * NVL(p.QT,0) ) AS VLDESCONTOS,

          -- Flag geral (mantida)
          MAX(CASE WHEN c.CODCOB = 'DPIX' THEN 1 ELSE 0 END) AS HAS_DPIX,

              /* =========================
                NOVO: identificar SITE
                ========================= */
              MAX(
                CASE
                  WHEN REGEXP_LIKE(UPPER(COALESCE(c.ROTINA, c.ROTINALANC, '')), 'INTEGRADORA')
                  THEN 1 ELSE 0
                END
              ) AS HAS_SITE,

              /* =========================
                NOVO: DESCONTO do SITE (somente pedidos SITE)
                ========================= */
              SUM(
                CASE
                  WHEN REGEXP_LIKE(UPPER(COALESCE(c.ROTINA, c.ROTINALANC, '')), 'INTEGRADORA')
                  THEN (NVL(p.PTABELA,0) - NVL(p.PVENDA,0)) * NVL(p.QT,0)
                  ELSE 0
                END
              ) AS VLDESCONTOS_SITE,

              /* =========================
                NOVO: DESCONTO do SITE AJUSTADO (DPIX vira 0)
                ========================= */
              SUM(
                CASE
                  WHEN REGEXP_LIKE(UPPER(COALESCE(c.ROTINA, c.ROTINALANC, '')), 'INTEGRADORA')
                  THEN CASE
                        WHEN c.CODCOB = 'DPIX' THEN 0
                        ELSE (NVL(p.PTABELA,0) - NVL(p.PVENDA,0)) * NVL(p.QT,0)
                      END
                  ELSE 0
                END
              ) AS VLDESCONTOS_SITE_AJUST,

              /* =========================
                NOVO: HAS_DPIX dentro do SITE
                ========================= */
              MAX(
                CASE
                  WHEN REGEXP_LIKE(UPPER(COALESCE(c.ROTINA, c.ROTINALANC, '')), 'INTEGRADORA')
                  AND c.CODCOB = 'DPIX'
                  THEN 1 ELSE 0
                END
              ) AS HAS_DPIX_SITE

        FROM ${T.PCPEDC} c
        JOIN ${T.PCPEDI} p      ON p.NUMPED = c.NUMPED
        JOIN ${T.PCCLIENT} cli  ON cli.CODCLI = c.CODCLI
        JOIN ${T.PCPRODUT} pr   ON pr.CODPROD = p.CODPROD
        JOIN ${T.PCNFSAID} s    ON s.NUMTRANSVENDA = c.NUMTRANSVENDA
        WHERE s.DTSAIDA BETWEEN TO_DATE(:DataIni, 'DD/MM/YYYY') AND TO_DATE(:DataFim, 'DD/MM/YYYY')
          AND cli.DTEXCLUSAO IS NULL
          AND c.DTCANCEL IS NULL
          AND c.CODFILIAL IN (:CodFilial)
          AND c.POSICAO = 'F'
          AND c.CONDVENDA IN (1,2,3,7,9,14,15,17,18,19,98)
          ${params.ClienteCod ? 'AND c.CODCLI = :ClienteCod' : ''}
          ${params.ClienteNome ? "AND (UPPER(NVL(cli.FANTASIA, cli.CLIENTE)) LIKE UPPER(:ClienteNome) OR REGEXP_REPLACE(TRANSLATE(UPPER(NVL(cli.FANTASIA, cli.CLIENTE)), 'ÃÃ€Ã‚ÃƒÃ„Ã‰ÃˆÃŠÃ‹ÃÃŒÃŽÃÃ“Ã’Ã”Ã•Ã–ÃšÃ™Ã›ÃœÃ‡Ã‘', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9]', '') LIKE :ClienteNomeFlat)" : ''}
          ${params.Cnpj ? "AND REGEXP_REPLACE(NVL(cli.CGCENT, ''), '[^0-9]', '') LIKE :Cnpj" : ''}
          ${params.Municipio ? 'AND UPPER(cli.MUNICENT) LIKE UPPER(:Municipio)' : ''}
          ${params.CodAtividade && params.CodAtividade.length > 0 ? 'AND cli.CODATV1 IN (:CodAtividade)' : ''}
        GROUP BY c.CODCLI, TO_CHAR(s.DTSAIDA, 'MM/YYYY')
      ),

      -- 3. DADOS DE DEVOLUÃ‡Ã•ES
      devolucoes AS (
        SELECT /*+ PARALLEL(4) */
          cli.CODCLI,
          TO_CHAR(nf.DTENT, 'MM/YYYY') AS MES_ANO,
          SUM(
            DECODE(m.TIPOITEM, 'C', 0,
              (NVL(m.QT, NVL(m.QTCONT,0)) *
                (NVL(m.PUNIT, NVL(m.PUNITCONT,0)) +
                NVL(m.VLOUTROS,0) + NVL(m.VLFRETE,0))
              ))
          ) AS VLDEVOLUCAO,
          COUNT(DISTINCT nf.NUMNOTA) AS QTD_DEVOLUCOES
        FROM ${T.PCNFENT} nf
        JOIN ${T.PCMOV} m      ON nf.NUMTRANSENT = m.NUMTRANSENT
        JOIN ${T.PCPRODUT} pr  ON pr.CODPROD = m.CODPROD
        LEFT JOIN ${T.PCNFSAID} said ON nf.NUMTRANSENT = said.NUMTRANSVENDA
        JOIN ${T.PCCLIENT} cli ON nf.CODFORNEC = cli.CODCLI
        WHERE
          nf.DTENT BETWEEN TO_DATE(:DataIni, 'DD/MM/YYYY') AND TO_DATE(:DataFim, 'DD/MM/YYYY')
          AND nf.TIPODESCARGA IN ('6','7','T')
          AND NVL(nf.OBS, 'X') <> 'NF CANCELADA'
          AND nf.CODFISCAL IN ('131','132','231','232','199','299')
          AND ( NVL(SUBSTR(nf.ROTINALANC, 7, 4), ' ') <> '4113'
                OR (NVL(SUBSTR(nf.ROTINALANC, 7, 4), ' ') = '4113' AND m.STATUS IN ('A','AB')) )
          AND NVL(SUBSTR(nf.ROTINALANC, 7, 4), ' ') NOT IN ('1346','1757','.EXE')
          AND NVL(nf.CODFILIALNF, nf.CODFILIAL) IN (:CodFilial)
          AND NVL(said.CONDVENDA, 0) NOT IN (4, 8, 10, 13, 20, 98, 99)
          AND m.CODOPER IN ('ED','EN')
          AND m.DTCANCEL IS NULL
        GROUP BY cli.CODCLI, TO_CHAR(nf.DTENT, 'MM/YYYY')
      ),

      -- 4. FRETE
      frete_pedido AS (
        SELECT /*+ PARALLEL(4) */
          c.CODCLI,
          TO_CHAR(s.DTSAIDA, 'MM/YYYY') AS MES_ANO,
          SUM(NVL(c.VLFRETE, 0)) AS VL_FRETE_TOTAL
        FROM ${T.PCPEDC} c
        JOIN ${T.PCNFSAID} s ON s.NUMTRANSVENDA = c.NUMTRANSVENDA
        WHERE
          s.DTSAIDA BETWEEN TO_DATE(:DataIni, 'DD/MM/YYYY') AND TO_DATE(:DataFim, 'DD/MM/YYYY')
          AND c.DTCANCEL IS NULL
          AND c.CODFILIAL IN (:CodFilial)
          AND c.POSICAO = 'F'
          AND c.CONDVENDA IN (1,2,3,7,9,14,15,17,18,19,98)
        GROUP BY c.CODCLI, TO_CHAR(s.DTSAIDA, 'MM/YYYY')
      ),

      -- 5. ULTIMO RCA (Auxiliar)
      ult_rca AS (
        SELECT /*+ PARALLEL(4) */
          ped.CODCLI,
          MAX(ped.DATA) AS DT_ULTIMA_VENDA,
          MAX(ped.CODUSUR) KEEP (DENSE_RANK FIRST ORDER BY ped.DATA DESC) AS ULT_RCA
        FROM ${T.PCPEDC} ped
        LEFT JOIN ${T.PCNFSAID} s ON s.NUMTRANSVENDA = ped.NUMTRANSVENDA
        WHERE ped.DTCANCEL IS NULL
          AND ped.CODFILIAL IN (:CodFilial)
          AND ped.POSICAO = 'F'
          AND ped.CONDVENDA IN (1,2,3,7,9,14,15,17,18,19,98)
          AND s.DTSAIDA BETWEEN TO_DATE(:DataIni, 'DD/MM/YYYY') AND TO_DATE(:DataFim, 'DD/MM/YYYY')
        GROUP BY ped.CODCLI
      ),


      -- 6. TIPO DE VENDA (por cliente/mÃªs)
      tipo_venda_cli AS (
        SELECT 
          CODCLI,
          MES_ANO,
          CASE 
            -- Se no mÃªs o cliente usou mais de um canal REAL (SITE/CAIXA/316) â†’ DIVERSOS
            WHEN COUNT(DISTINCT CASE 
                                  WHEN tipo_venda IN ('SITE','CAIXA','316') 
                                  THEN tipo_venda 
                                END) > 1 
              THEN 'DIVERSOS'
            
            -- Se usou exatamente 1 canal REAL no mÃªs â†’ esse canal
            WHEN COUNT(DISTINCT CASE 
                                  WHEN tipo_venda IN ('SITE','CAIXA','316') 
                                  THEN tipo_venda 
                                END) = 1 
              THEN MAX(CASE 
                         WHEN tipo_venda IN ('SITE','CAIXA','316') 
                         THEN tipo_venda 
                       END)
            
            -- Se sÃ³ teve OUTROS (ou nada identificado) â†’ OUTROS
            ELSE 'OUTROS'
          END AS TIPO_VENDA
        FROM (
          SELECT 
            c.CODCLI,
            TO_CHAR(s.DTSAIDA, 'MM/YYYY') AS MES_ANO,
            CASE
              WHEN REGEXP_LIKE(
                     UPPER(COALESCE(c.ROTINA, c.ROTINALANC, '')), 
                     'INTEGRADORA'
                   ) THEN 'SITE'
              WHEN REGEXP_LIKE(
                     UPPER(COALESCE(c.ROTINA, c.ROTINALANC, '')), 
                     'AUTOSERVICO'
                   ) THEN 'CAIXA'
              WHEN REGEXP_LIKE(
                     UPPER(COALESCE(c.ROTINA, c.ROTINALANC, '')), 
                     'PCSIS316'
                   ) THEN '316'
              ELSE 'OUTROS'
            END AS tipo_venda
          FROM ${T.PCPEDC} c
          LEFT JOIN ${T.PCNFSAID} s 
            ON c.NUMTRANSVENDA = s.NUMTRANSVENDA
          WHERE s.DTSAIDA BETWEEN TO_DATE(:DataIni,'DD/MM/YYYY') 
                               AND TO_DATE(:DataFim,'DD/MM/YYYY')
            AND c.DTCANCEL IS NULL
            AND c.CODFILIAL IN (:CodFilial)
            AND c.POSICAO = 'F'
            AND c.CONDVENDA IN (1,2,3,7,9,14,15,17,18,19,98)
            ${params.ClienteCod ? 'AND c.CODCLI = :ClienteCod' : ''}
        )
        GROUP BY CODCLI, MES_ANO
      ),


      -- 7. CLIENTES BASE (Para o Cross Join)
      base_clientes AS (
         SELECT c.CODCLI, c.CLIENTE, c.FANTASIA, c.MUNICENT, c.ESTENT, c.CGCENT, c.IEENT, c.CODATV1
         FROM ${T.PCCLIENT} c
         WHERE 1=1
         ${filtroBaseClientes}
         ${params.ClienteNome ? "AND (UPPER(NVL(c.FANTASIA, c.CLIENTE)) LIKE UPPER(:ClienteNome) OR REGEXP_REPLACE(TRANSLATE(UPPER(NVL(c.FANTASIA, c.CLIENTE)), 'ÃÃ€Ã‚ÃƒÃ„Ã‰ÃˆÃŠÃ‹ÃÃŒÃŽÃÃ“Ã’Ã”Ã•Ã–ÃšÃ™Ã›ÃœÃ‡Ã‘', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9]', '') LIKE :ClienteNomeFlat)" : ''}
         ${params.Cnpj ? "AND REGEXP_REPLACE(NVL(c.CGCENT, ''), '[^0-9]', '') LIKE :Cnpj" : ''}
         ${params.Municipio ? 'AND UPPER(c.MUNICENT) LIKE UPPER(:Municipio)' : ''}
         ${params.CodAtividade && params.CodAtividade.length > 0 ? 'AND c.CODATV1 IN (:CodAtividade)' : ''}
      ),

      -- 8. SKELETON (Produto Cartesiano: Todo Cliente x Todo MÃªs)
      skeleton AS (
         SELECT 
            b.CODCLI, b.CLIENTE, b.FANTASIA, b.MUNICENT, b.ESTENT, b.CGCENT, b.IEENT, b.CODATV1,
            cal.MES_ANO, cal.MES, cal.ANO, cal.DT_REF
         FROM base_clientes b
         CROSS JOIN calendar cal
      )
      
      -- 9. SELECT FINAL
      SELECT /*+ PARALLEL(4) */
        sk.CODCLI,
        sk.CLIENTE,
        sk.FANTASIA,
        sk.MUNICENT,
        sk.ESTENT,
        sk.CGCENT,
        sk.IEENT,
        sk.MES,
        sk.ANO,
        sk.MES_ANO,
        
        -- [AQUI ESTA O SEGREDO]
        -- FINANCEIRO: Retorna 0 se for nulo (para o grÃ¡fico desenhar a linha no zero)
        ROUND(NVL(v.VLVENDA, 0), 2) AS VLVENDA,
        ROUND(NVL(d.VLDEVOLUCAO, 0), 2) AS VLDEVOLUCAO,
        ROUND(NVL(v.VLVENDA, 0) - NVL(d.VLDEVOLUCAO, 0), 2) AS VLLIQUIDO,
        
        -- MÃ‰TRICAS DE PONTUAÃ‡ÃƒO: Retorna NULL se nÃ£o houve venda nesse mÃªs
        -- (Isso evita que o Frontend some '0' na mÃ©dia e derrube a nota do cliente)
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.QTD_NOTAS END AS QTD_NOTAS,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.QTD_PEDIDOS END AS QTD_PEDIDOS,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.MIX_ITENS END AS MIX_ITENS,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.QTD_ITENS_FATURADOS END AS QTD_ITENS_FATURADOS,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE ROUND(NVL(v.PRAZO_MEDIO_PEDIDO, 0), 2) END AS PRAZOMEDIO,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.CODCOB_PEDIDO END AS CODCOB_PEDIDO,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.QTD_CODCOB_NO_MES END AS QTD_CODCOB_NO_MES,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.HAS_DPIX END AS HAS_DPIX,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.VLDESCONTOS_SITE END AS VLDESCONTOS_SITE,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.VLDESCONTOS_SITE_AJUST END AS VLDESCONTOS_SITE_AJUST,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE v.HAS_DPIX_SITE END AS HAS_DPIX_SITE,


        -- Frete e DevoluÃ§Ã£o (Qtd)
        ROUND(NVL(f.VL_FRETE_TOTAL, 0), 2) AS VL_FRETE_TOTAL_PEDIDOS,
        NVL(d.QTD_DEVOLUCOES, 0) AS QTD_DEVOLUCOES,
        
        -- Descontos
        CASE WHEN v.CODCLI IS NULL THEN NULL 
             ELSE ROUND(CASE WHEN NVL(v.VLDESCONTOS,0) >= 0 THEN NVL(v.VLDESCONTOS,0) ELSE -ABS(NVL(v.VLDESCONTOS,0)) END, 2) 
        END AS VLDESCONTOS,

        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE ROUND(NVL(v.VLVENDA_PROD, 0), 2) END AS VLVENDA_PROD,
        CASE WHEN v.CODCLI IS NULL THEN NULL ELSE ROUND(NVL(v.VLTABELA_PROD, 0), 2) END AS VLTABELA_PROD,

        
        -- DADOS CADASTRAIS (Sempre preenchidos via Join na PCCLIENT)
        pc.VIP AS CLASSIFICACAO_FATURAMENTO,
        pc.CODUSUR1 AS CODUSUR_ATUAL,
        pc.CODREDE AS CLASSE_CODIGO,
        pc.CATEGORIA AS CATEGORIA,
        ult.DT_ULTIMA_VENDA AS DT_ULTIMA_VENDA,
        ult.ULT_RCA AS CODUSUR_ULTIMA_VENDA,
        u.NOME AS NOME_ULTIMO_RCA,
        sk.CODATV1 AS COD_RAMO_ATIVIDADE,
        atv.RAMO AS RAMO_ATIVIDADE,
        atv_princ.RAMO AS RAMO_PRINCIPAL,
        tv.TIPO_VENDA AS TIPO_VENDA,
        pc.CODREDE AS COD_REDE,
        r.DESCRICAO AS REDE_CLIENTE

      FROM skeleton sk
      LEFT JOIN vendas v 
        ON sk.CODCLI = v.CODCLI AND sk.MES_ANO = v.MES_ANO
      LEFT JOIN devolucoes d
        ON d.CODCLI = sk.CODCLI AND d.MES_ANO = sk.MES_ANO
      LEFT JOIN frete_pedido f
        ON f.CODCLI = sk.CODCLI AND f.MES_ANO = sk.MES_ANO
      
      -- Joins Auxiliares (Baseados no SK para garantir dados mesmo sem venda)
      LEFT JOIN ${T.PCCLIENT} pc ON pc.CODCLI = sk.CODCLI
      LEFT JOIN ${T.PCREDECLIENTE} r ON r.CODREDE = pc.CODREDE
      LEFT JOIN ${T.PCATIVI} atv ON atv.CODATIV = sk.CODATV1
      LEFT JOIN ${T.PCATIVI} atv_princ ON atv_princ.CODATIV = atv.CODATIVPRINC
      LEFT JOIN ult_rca ult ON ult.CODCLI = sk.CODCLI
      LEFT JOIN ${T.PCUSUARI} u ON u.CODUSUR = ult.ULT_RCA
      LEFT JOIN tipo_venda_cli tv 
        ON tv.CODCLI = sk.CODCLI
      AND tv.MES_ANO = sk.MES_ANO

      ORDER BY NVL(sk.FANTASIA, sk.CLIENTE), sk.DT_REF DESC
    `;

    const binds = {
      DataIni: params.DataIni,
      DataFim: params.DataFim,
      CodFilial: params.CodFilial,
    };

    const normalizarTextoBusca = (valor) => String(valor || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    if (params.ClienteCod) binds.ClienteCod = params.ClienteCod;
    if (params.ClienteNome) binds.ClienteNome = `%${params.ClienteNome}%`;
    if (params.ClienteNome) binds.ClienteNomeFlat = `%${normalizarTextoBusca(params.ClienteNome)}%`;
    if (params.Cnpj) binds.Cnpj = `%${String(params.Cnpj).replace(/\D/g, '')}%`;
    if (params.Municipio) binds.Municipio = `%${params.Municipio}%`;
    if (params.CodAtividade && params.CodAtividade.length > 0) binds.CodAtividade = params.CodAtividade;

    console.log('ðŸ” Executando consulta com filtros:', Object.keys(binds));

    const rs = await execSQL(this.connection, sql, binds);
    const result = rs.rows || [];

    // Salva no cache
    queryCache.set(cacheKey, result);
    return result;
  }

  async buscarTitulos(params) {
    const T = this.T; // Usa seus nomes de tabela resolvidos
    
    const sql = `
      SELECT 
        P.CODCLI,
        P.DTVENC,
        P.DTPAG,
        P.DTBAIXA
      FROM ${T.PCPREST} P
      WHERE P.DTPAG IS NOT NULL
        AND P.DTBAIXA >= TO_DATE(:DataIni, 'DD/MM/YYYY')
        AND P.DTBAIXA < TO_DATE(:DataFim, 'DD/MM/YYYY') + 1
        AND P.CODCOB NOT IN ('DESD', 'DEVP', 'DEVT', 'BNF', 'BNFT', 'BNFR', 'BNTR', 'BNRP')
        AND NOT ((NVL(P.PERMITEESTORNO, 'S') = 'N') OR (P.CODCOB = 'ESTR'))
        ${params.ClienteCod ? 'AND P.CODCLI = :ClienteCod' : ''}
    `;

    const binds = { 
      DataIni: params.DataIni, 
      DataFim: params.DataFim 
    };
    
    if (params.ClienteCod) binds.ClienteCod = params.ClienteCod;

    // Usa a conexÃ£o que jÃ¡ estÃ¡ aberta na classe
    const rs = await this.connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return rs.rows || [];
  }

  async calcularTodasNotas(c, titulosDoCliente) {
    // Notas sÃ­ncronas (mantÃ©m sua lÃ³gica atual para as outras)
    const notas = {
      NOTA_AL: this.calcularNotaAL(c),
      NOTA_AM: this.calcularNotaAM(c),
      NOTA_AN: this.calcularNotaAN(c),
      NOTA_AO: this.calcularNotaAO(c),
      NOTA_AP: this.calcularNotaAP(c),
      NOTA_AQ: this.calcularNotaAQ(c),
      NOTA_AR: this.calcularNotaAR(c),
      NOTA_AS: this.calcularNotaAS(c),
      NOTA_AT: this.calcularNotaAT(c),
      
      // AQUI MUDA: Usa o cÃ¡lculo JS + Lista da memÃ³ria
      NOTA_AU: this.calcularNotaAU_JS(titulosDoCliente) 
    };

    return notas; // Removemos o 'await' interno, agora Ã© instantÃ¢neo
  }

  calcularNotaAL(c) {
    const vlliquido = c.VLLIQUIDO || 0;
    const ramoPrincipal = c.RAMO_PRINCIPAL || '';
    const codRamo = c.COD_RAMO_ATIVIDADE || 0;

    if (ramoPrincipal === 'ATACADO') {
      switch (parseInt(codRamo)) {
        case 12: if (vlliquido >= 10000) return 10; if (vlliquido <= 5000) return 0; return 5;
        case 10: if (vlliquido >= 4000) return 10;  if (vlliquido <= 2000) return 0; return 5;
        case 11: if (vlliquido >= 5000) return 10;  if (vlliquido <= 2500) return 0; return 5;
      }
    }
    return 0;
  }

  calcularNotaAM(c) {
    const vlvenda = c.VLVENDA || 0;
    const vldevolucao = c.VLDEVOLUCAO || 0;
    
    if (vlvenda === 0) return 10;
    if (vldevolucao === 0) return 10;
    
    const perc = (vldevolucao / vlvenda) * 100;
    return perc <= 1 ? 5 : 0;
  }

  calcularNotaAN(c) {
    const tipoVenda = c.TIPO_VENDA || '';
    const vlvenda = c.VLVENDA || 0;
    const vlFrete = c.VL_FRETE_TOTAL_PEDIDOS || 0;
    
    if (tipoVenda === 'SITE') return 10;
    if (vlvenda === 0) return 10;

    const perc = (vlFrete / vlvenda) * 100;
    if (perc === 0) return 10;
    else if (perc >= 10) return 5;
    else return 0;
  }

  calcularNotaAO(c) {
    const mix = c.MIX_ITENS || 0;
    const ramoPrincipal = c.RAMO_PRINCIPAL || '';
    const codRamo = c.COD_RAMO_ATIVIDADE || 0;

    if (ramoPrincipal === 'ATACADO') {
      switch (parseInt(codRamo)) {
        case 12: if (mix >= 25) return 10; if (mix <= 12) return 0; return 5;
        case 10: if (mix >= 8)  return 10; if (mix <= 4)  return 0; return 5;
        case 11: if (mix >= 14) return 10; if (mix <= 7)  return 0; return 5;
      }
    }
    return 0;
  }

  calcularNotaAP(c) {
    const qtd = c.QTD_ITENS_FATURADOS || 0;
    const ramoPrincipal = c.RAMO_PRINCIPAL || '';
    const codRamo = c.COD_RAMO_ATIVIDADE || 0;

    if (ramoPrincipal === 'ATACADO') {
      switch (parseInt(codRamo)) {
        case 12: if (qtd >= 570) return 10; if (qtd <= 285) return 0; return 5;
        case 10: if (qtd >= 280) return 10; if (qtd <= 140) return 0; return 5;
        case 11: if (qtd >= 300) return 10; if (qtd <= 150) return 0; return 5;
      }
    }
    return 0;
  }

  calcularNotaAQ(c) {
    const prazo = c.PRAZOMEDIO || 0;
    const ramoPrincipal = c.RAMO_PRINCIPAL || '';
    const codRamo = c.COD_RAMO_ATIVIDADE || 0;

    if (ramoPrincipal === 'ATACADO') {
      switch (parseInt(codRamo)) {
        case 12: if (prazo === 0) return 10; if (prazo <= 30) return 8; if (prazo <= 45) return 5; return 0;
        case 10: if (prazo === 0) return 10; if (prazo <= 45) return 8; if (prazo <= 60) return 5; return 0;
        case 11: if (prazo === 0) return 10; if (prazo <= 30) return 8; if (prazo <= 45) return 5; return 0;
      }
    }
    return 0;
  }

  calcularNotaAR(c) {
    const t = c.TIPO_VENDA || '';
    if (t === 'SITE') return 10;
    if (t === '316')  return 5;
    if (t === 'CAIXA') return 0;
    if (t === 'DIVERSOS' || t === 'OUTROS') return 3;
    return 0;
  }

  calcularNotaAS(c) {
    const tipoVenda = (c?.TIPO_VENDA || '').toUpperCase();

    const vlvenda = Number(c?.VLVENDA ?? 0) || 0;
    if (vlvenda === 0) return 10;

    // Helpers de nÃºmero (mantÃ©m seu cuidado com string "1.234,56")
    const toNumberBR = (raw) => {
      if (typeof raw === "string") {
        const n = Number(raw.replace(/\./g, "").replace(",", "."));
        return Number.isFinite(n) ? n : 0;
      }
      const n = Number(raw ?? 0);
      return Number.isFinite(n) ? n : 0;
    };

    const qtdCodCob = Number(c?.QTD_CODCOB_NO_MES ?? 0) || 0;
    const codCobPedido = (c?.CODCOB_PEDIDO || '').toUpperCase();
    const hasDpixSite = Number(c?.HAS_DPIX_SITE ?? 0) || 0;

    // 1) REGRA ESPECIAL: mÃªs Ã© somente SITE e sÃ³ teve DPIX no mÃªs => 10 direto
    // (usamos QTD_CODCOB_NO_MES + CODCOB_PEDIDO como garantia de "sÃ³ DPIX")
    if (tipoVenda === 'SITE' && qtdCodCob === 1 && codCobPedido === 'DPIX') {
      return 10;
    }

    // 2) Se Ã© SITE e tem DPIX misturado com outros: usar o desconto ajustado do SITE (DPIX=0)
    // Caso nÃ£o tenha DPIX no SITE, pode usar o desconto normal (ou o desconto do SITE, se vocÃª quiser isolar SITE sempre)
    let vldescBase;

    if (tipoVenda === 'SITE' && hasDpixSite === 1) {
      // aqui estÃ¡ o â€œ0 do DPIX + soma dos outros descontos do SITEâ€
      vldescBase = toNumberBR(c?.VLDESCONTOS_SITE_AJUST);
    } else if (tipoVenda === 'SITE') {
      // opcional: para SITE puro sem DPIX, usar sÃ³ desconto do SITE
      vldescBase = toNumberBR(c?.VLDESCONTOS_SITE);
    } else {
      // regra antiga para demais canais
      vldescBase = toNumberBR(c?.VLDESCONTOS);
    }

    // Regra: desconto negativo NÃƒO conta (nÃ£o penaliza)
    const vldescPositivo = Math.max(vldescBase, 0);

    const perc = (vldescPositivo / vlvenda) * 100;

    if (perc <= 5) return 10;
    if (perc >= 10) return 0;
    return 5;
  }


  calcularNotaAT(c) {
    const n = c.QTD_NOTAS || 0;
    if (n >= 4) return 10;
    if (n === 3) return 8;
    if (n === 2) return 7;
    if (n === 1) return 5;
    return 0;
  }

calcularNotaAU_JS(titulos) {
    // Se nÃ£o tem tÃ­tulos baixados no perÃ­odo, nota 0 ou neutra? 
    // Seguindo sua lÃ³gica original que retornava '' (vazio) -> assumimos 0 aqui
    if (!titulos || titulos.length === 0) return 0;

    let hasNegligente = false;
    let hasAtrasou = false;
    let hasAceitavel = false;

    for (const t of titulos) {
        if (!t.DTVENC) continue;
        
        const dtVenc = new Date(t.DTVENC).getTime();
        // Se DTPAG for nulo, ignora (pois sua query original usava dtpag no cÃ¡lculo)
        if (!t.DTPAG) continue; 
        const dtPag = new Date(t.DTPAG).getTime();

        // LÃ³gica do Oracle: (Vencimento - Pagamento)
        // Se pagou dia 13 e venceu dia 10: (10 - 13) = -3 dias
        const diffTime = dtVenc - dtPag;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

        // Sua regra de negÃ³cio exata:
        if (diffDays === -3) {
            hasNegligente = true;
            // Se achou negligente, jÃ¡ Ã© a pior nota, poderia parar, mas vamos seguir
        } else if (diffDays === -1 || diffDays === -2) {
            hasAceitavel = true;
        } else if (diffDays < 0) {
            hasAtrasou = true;
        }
    }

    // Prioridade das Notas (Do pior para o melhor)
    if (hasNegligente) return 5;
    if (hasAtrasou) return 0;
    if (hasAceitavel) return 8;
    
    return 10; // Se pagou tudo em dia ou adiantado
  }

  calcularMediaPonderada(notas) {
    const pesos = {
      NOTA_AL: 100, NOTA_AM: 20, NOTA_AN: 20, NOTA_AO: 100, NOTA_AP: 100,
      NOTA_AQ: 100, NOTA_AR: 60, NOTA_AS: 20, NOTA_AT: 20, NOTA_AU: 60,
    };
    let soma = 0, tot = 0;
    for (const k of Object.keys(pesos)) {
      soma += (notas[k] || 0) * pesos[k];
      tot += pesos[k];
    }
    return tot > 0 ? soma / tot : 0;
  }

  async exportarParaCSV(resultados, filename = 'performance_clientes.csv') {
    const writer = csv({
      path: filename,
      header: [
        { id: 'CODCLI', title: 'CODCLI' },
        { id: 'CLIENTE', title: 'CLIENTE' },
        { id: 'MUNICENT', title: 'MUNICENT' },
        { id: 'ESTENT', title: 'ESTENT' },
        { id: 'MES_ANO', title: 'MES_ANO' },
        { id: 'VLLIQUIDO', title: 'VLLIQUIDO' },
        { id: 'NOTA_AL', title: 'NOTA_AL' },
        { id: 'NOTA_AM', title: 'NOTA_AM' },
        { id: 'NOTA_AN', title: 'NOTA_AN' },
        { id: 'NOTA_AO', title: 'NOTA_AO' },
        { id: 'NOTA_AP', title: 'NOTA_AP' },
        { id: 'NOTA_AQ', title: 'NOTA_AQ' },
        { id: 'NOTA_AR', title: 'NOTA_AR' },
        { id: 'NOTA_AS', title: 'NOTA_AS' },
        { id: 'NOTA_AT', title: 'NOTA_AT' },
        { id: 'NOTA_AU', title: 'NOTA_AU' },
        { id: 'MEDIA_PONDERADA', title: 'MEDIA_PONDERADA' },
        { id: 'CLASSIFICACAO', title: 'CLASSIFICACAO' },
      ],
    });
    await writer.writeRecords(resultados);
    console.log(`Arquivo ${filename} exportado com sucesso!`);
  }
}

// Monitoramento de performance
class PerformanceMonitor {
  static startMonitoring() {
    setInterval(() => {
      const used = process.memoryUsage();
      console.log(`ðŸ’¾ Memory: RSS ${Math.round(used.rss / 1024 / 1024)}MB, Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
    }, 30000);
  }
}

// Iniciar monitoramento
PerformanceMonitor.startMonitoring();
// expÃµe um "mÃ©todo estÃ¡tico" para limpar o cache interno
PerformanceClientes.clearCache = clearQueryCache;
module.exports = PerformanceClientes;

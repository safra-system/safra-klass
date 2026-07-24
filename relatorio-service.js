// relatorio-service.js
const PDFDocument = require('pdfkit');
const oracledb = require('oracledb');
const { Pool } = require('pg');
const BitrixService = require('./bitrix-service');
const fs = require('fs'); 

// =============================================================================
// Inicialização do Oracle
// =============================================================================
try {
  let initOptions = {};
  if (process.env.ORACLE_CLIENT_LIB_DIR) {
    initOptions = { libDir: process.env.ORACLE_CLIENT_LIB_DIR };
  }
  oracledb.initOracleClient(initOptions);
} catch (err) {
  if (err.message.indexOf('NJS-009') === -1) {
    console.error('[RelatorioService] Aviso Oracle Client:', err.message);
  }
}

class RelatorioService {
  constructor(logger) {
    this.logger = logger || console;
    this.bitrixService = new BitrixService(this.logger);

    // Configuração Postgres
    const pgConnString = process.env.POSTGRES_CONN_STRING;
    if (pgConnString) {
        this.pgPool = new Pool({ connectionString: pgConnString });
    } else {
        this.logger.error('[RelatorioService] POSTGRES_CONN_STRING faltando!');
    }
  }

  // ✅ FIX: Conexão Oracle usa dbSwitch (respeita ambiente PROD/TEST)
  async _getOracleConnection() {
    const dbSwitch = require('./db-switch');
    let pool = dbSwitch.getPool();
    if (!pool) {
      const config = dbSwitch.getConfig();
      pool = await oracledb.createPool(config);
      dbSwitch.setPool(pool);
    }
    return await pool.getConnection();
  }

  async _obterIdBitrix(rca) {
      // 1. Tenta buscar dos parâmetros do sistema
      try {
          // Requer acesso ao repo. Se não tiver instanciado, instancia agora.
          if (!this.rotativoRepo) {
             const RotativoRepository = require('./rotativo-repository');
             this.rotativoRepo = new RotativoRepository(this.logger);
          }
          
          const params = await this.rotativoRepo.obterParametrosSistema();
          if (params && params.mapa_bitrix && params.mapa_bitrix[rca]) {
              return params.mapa_bitrix[rca];
          }
      } catch (e) { console.error('Erro ao ler mapa bitrix:', e); }

      // 2. Fallback Fixo
      const mapa = {
          121: 106114, 122: 106116, 123: 106118, 124: 106122,
          125: 106124, 126: 110994, 127: 110996, 128: 111002,
          10: 256, 110: 164
      };
      return mapa[rca];
  }

  // Helper para calcular dias (Hoje - DataCompra)
  _diffDias(dDataCompra, dHoje) {
    if (!dDataCompra) return 999;
    const t1 = dDataCompra.getTime();
    const t2 = dHoje.getTime();
    const diff = Math.floor((t2 - t1) / (24 * 3600 * 1000));
    return diff < 0 ? 0 : diff;
  }

  /**
   * Gera o PDF COMPLETO da carteira (Oracle + Dados Processados)
   */
  async processarRelatorioVendedor(codRca, bitrixIdOverride = null) {
    let oracleConn;
    try {
      let bitrixId = bitrixIdOverride || await this._obterIdBitrix(codRca);
      if (!bitrixId) {
          this.logger.error(`[Relatorio] RCA ${codRca} sem ID Bitrix. Abortando.`);
          return;
      }

      this.logger.log(`[Relatorio] Iniciando processamento completo para RCA ${codRca}...`);

      // 1. BUSCAR DADOS NO ORACLE (FONTE DA VERDADE - CARTEIRA COMPLETA)
      oracleConn = await this._getOracleConnection();
      
      // Busca Nome do Vendedor
      let nomeVendedor = `RCA ${codRca}`;
      try {
          const resVendedor = await oracleConn.execute(
              `SELECT NOME FROM PCUSUARI WHERE CODUSUR = :codRca`, 
              [codRca], { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
          if (resVendedor.rows.length) nomeVendedor = resVendedor.rows[0].NOME;
      } catch (e) {}

      // Busca TODOS os clientes da carteira no Oracle
      const sqlOracle = `
        SELECT 
            CODCLI, 
            CLIENTE, 
            FANTASIA, 
            DTULTCOMP, 
            CATEGORIA
        FROM PCCLIENT
        WHERE CODUSUR1 = :codRca
          AND DTEXCLUSAO IS NULL
        ORDER BY DTULTCOMP ASC
      `;
      
      const resOracle = await oracleConn.execute(sqlOracle, [codRca], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const carteiraOracle = resOracle.rows; 

      // 2. BUSCAR DADOS PROCESSADOS NO POSTGRES (ENRIQUECIMENTO)
      const sqlPostgres = `
        SELECT codcli, nivel, status_situacao, dias_sem_compra
        FROM relatorio_carteira
        WHERE rca_codigo = $1 AND data_processamento::date = CURRENT_DATE
      `;
      const resPg = await this.pgPool.query(sqlPostgres, [codRca]);
      
      const mapPostgres = new Map();
      resPg.rows.forEach(r => mapPostgres.set(r.codcli, r));

      // 3. FUSÃO DE DADOS (MERGE)
      const listaFinal = [];
      const hoje = new Date();

      const stats = {
        total: carteiraOracle.length,
        ativos: 0, alerta: 0, risco: 0,
        niveis: { 'DIAMANTE': 0, 'PLATINUM': 0, 'OURO': 0, 'PRATA': 0, 'BRONZE': 0, 'OUTROS': 0 }
      };

      for (const cli of carteiraOracle) {
          const cod = cli.CODCLI;
          const dadosPg = mapPostgres.get(cod);

          let dias, nivel, status;

          if (dadosPg) {
              // Confia no processamento do robô (Postgres)
              dias = dadosPg.dias_sem_compra;
              nivel = dadosPg.nivel;
              status = dadosPg.status_situacao;
          } else {
              // Calcula na hora usando o Oracle
              if (cli.DTULTCOMP) {
                  dias = this._diffDias(new Date(cli.DTULTCOMP), hoje);
              } else {
                  dias = 999; 
              }

              // Define Status Base
              if (dias >= 60) status = 'RISCO';
              else if (dias >= 30) status = 'ALERTA';
              else status = 'ATIVO';

              nivel = cli.CATEGORIA || 'OUTROS';
          }

          // Normalização
          const nivelNorm = nivel ? nivel.toUpperCase().trim() : 'OUTROS';
          
          // Estatísticas
          if (status === 'ATIVO') stats.ativos++;
          else if (status === 'ALERTA') stats.alerta++;
          else stats.risco++;

          if (stats.niveis[nivelNorm] !== undefined) stats.niveis[nivelNorm]++;
          else stats.niveis['OUTROS']++;

          listaFinal.push({
              codcli: cod,
              nome: cli.FANTASIA || cli.CLIENTE,
              nivel: nivelNorm,
              dias: dias,
              status: status
          });
      }

      // 🆕 4. ORDENAÇÃO (NÍVEL > DIAS)
      listaFinal.sort((a, b) => {
          // 1. Prioridade por Nível (Mapa de Pesos)
          const pesoNivel = {
              'DIAMANTE': 6,
              'PLATINUM': 5,
              'OURO': 4,
              'PRATA': 3,
              'BRONZE': 2,
              'OUTROS': 1
          };
          
          const pA = pesoNivel[a.nivel] || 0;
          const pB = pesoNivel[b.nivel] || 0;

          // Se os níveis forem diferentes, o maior peso vem primeiro
          if (pA !== pB) {
              return pB - pA;
          }

          // 2. Se for o mesmo nível, quem tem MAIS dias sem compra vem primeiro (mais crítico)
          return b.dias - a.dias;
      });

      this.logger.log(`[Relatorio] Gerando PDF com ${listaFinal.length} clientes (Carteira Completa)...`);

      // 5. Gerar e Enviar PDF
      const pdfBuffer = await this._gerarPdfEmBuffer(nomeVendedor, codRca, stats, listaFinal);
      const nomeArquivo = `Carteira_Completa_${codRca}_${new Date().toISOString().split('T')[0]}.pdf`;
      await this.bitrixService.enviarRelatorioPdf(bitrixId, pdfBuffer, nomeArquivo);

    } catch (err) {
      this.logger.error(`[Relatorio] Erro fatal RCA ${codRca}:`, err.message);
    } finally {
        if (oracleConn) await oracleConn.close();
    }
  }

  // ===========================================================================
  // 🆕 GERAR PDF DA CARTEIRA REAL DO WINTHOR (para download direto)
  // ===========================================================================
  async gerarPdfCarteiraAtualWinthor(codRca) {
    let oracleConn;
    try {
      this.logger.log(`[Relatorio] Gerando PDF da carteira REAL do WinThor para RCA ${codRca}...`);

      oracleConn = await this._getOracleConnection();

      let nomeVendedor = `RCA ${codRca}`;
      try {
        const resVendedor = await oracleConn.execute(
          `SELECT NOME FROM PCUSUARI WHERE CODUSUR = :codRca`,
          [codRca], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (resVendedor.rows.length) nomeVendedor = resVendedor.rows[0].NOME;
      } catch (e) {}

      const sqlOracle = `
        SELECT
          C.CODCLI, C.CLIENTE, C.FANTASIA, C.DTULTCOMP, C.CATEGORIA,
          TRUNC(SYSDATE - NVL(C.DTULTCOMP, SYSDATE - 999)) AS DIAS_SEM_COMPRA
        FROM PCCLIENT C
        WHERE C.CODUSUR1 = :codRca AND C.DTEXCLUSAO IS NULL
        ORDER BY C.DTULTCOMP ASC NULLS FIRST
      `;

      const resOracle = await oracleConn.execute(sqlOracle, [codRca], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const carteiraOracle = resOracle.rows;

      const hoje = new Date();
      const stats = {
        total: carteiraOracle.length, ativos: 0, alerta: 0, risco: 0,
        niveis: { 'DIAMANTE': 0, 'PLATINUM': 0, 'OURO': 0, 'PRATA': 0, 'BRONZE': 0, 'OUTROS': 0 }
      };
      const listaFinal = [];

      for (const cli of carteiraOracle) {
        const dias = cli.DIAS_SEM_COMPRA != null ? Number(cli.DIAS_SEM_COMPRA) : 999;
        let status;
        if (dias >= 60) status = 'RISCO';
        else if (dias >= 30) status = 'ALERTA';
        else status = 'ATIVO';

        const nivelNorm = (cli.CATEGORIA || 'OUTROS').toUpperCase().trim();
        if (status === 'ATIVO') stats.ativos++;
        else if (status === 'ALERTA') stats.alerta++;
        else stats.risco++;
        if (stats.niveis[nivelNorm] !== undefined) stats.niveis[nivelNorm]++;
        else stats.niveis['OUTROS']++;

        listaFinal.push({
          codcli: cli.CODCLI,
          nome: cli.CLIENTE || cli.FANTASIA,
          nivel: nivelNorm, dias, status
        });
      }

      const pesoNivel = { 'DIAMANTE': 6, 'PLATINUM': 5, 'OURO': 4, 'PRATA': 3, 'BRONZE': 2, 'OUTROS': 1 };
      listaFinal.sort((a, b) => {
        const pA = pesoNivel[a.nivel] || 0;
        const pB = pesoNivel[b.nivel] || 0;
        if (pA !== pB) return pB - pA;
        return b.dias - a.dias;
      });

      this.logger.log(`[Relatorio] PDF WinThor: ${listaFinal.length} clientes para RCA ${codRca}`);
      const pdfBuffer = await this._gerarPdfEmBuffer(nomeVendedor, codRca, stats, listaFinal);
      return { pdfBuffer, nomeVendedor, totalClientes: listaFinal.length };
    } catch (err) {
      this.logger.error(`[Relatorio] Erro ao gerar PDF WinThor RCA ${codRca}:`, err.message);
      throw err;
    } finally {
      if (oracleConn) await oracleConn.close();
    }
  }

  // --- GERAÇÃO DO PDF ---
  _gerarPdfEmBuffer(nomeVendedor, codRca, stats, listaClientes) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // CABEÇALHO
      doc.rect(0, 0, 595, 70).fill('#003366'); 
      doc.fillColor('white').fontSize(18).font('Helvetica-Bold').text('RELATÓRIO DE CARTEIRA COMPLETA', 50, 25);
      doc.fontSize(10).font('Helvetica').text(`Vendedor: ${nomeVendedor} (RCA ${codRca})`, 50, 50);
      doc.text(`Data Base: ${new Date().toLocaleDateString('pt-BR')}`, 400, 50, { align: 'right' });

      // RESUMO
      const startY = 100;
      this._drawBox(doc, 40, startY, 120, 'Total Carteira', stats.total, '#ecf0f1');
      this._drawBox(doc, 170, startY, 120, 'Ativos (<30d)', stats.ativos, '#d4edda');
      this._drawBox(doc, 300, startY, 120, 'Alerta (30-60d)', stats.alerta, '#fff3cd');
      this._drawBox(doc, 430, startY, 120, 'Risco (>60d)', stats.risco, '#f8d7da');

      // DISTRIBUIÇÃO
      doc.y = startY + 60;
      doc.fillColor('black').fontSize(11).font('Helvetica-Bold').text('DISTRIBUIÇÃO DA CARTEIRA:', 40, doc.y);
      doc.font('Helvetica').fontSize(9);
      doc.moveDown(0.4);
      const resumoNiveis = `Diamante: ${stats.niveis.DIAMANTE}   |   Platinum: ${stats.niveis.PLATINUM}   |   Ouro: ${stats.niveis.OURO}   |   Prata: ${stats.niveis.PRATA}   |   Bronze: ${stats.niveis.BRONZE}`;
      doc.save().rect(40, doc.y - 2, 515, 15).fill('#f4f4f4').restore();
      doc.fillColor('#333333').text(resumoNiveis, 50, doc.y);
      doc.moveDown(2.5);

      // LISTAGEM
      doc.fontSize(13).font('Helvetica-Bold').fillColor('black').text('LISTAGEM COMPLETA DE CLIENTES', 40, doc.y);
      // 🆕 Texto atualizado para refletir a nova ordenação
      doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666').text('(Ordenação: Nível > Dias sem Compra)', 40, doc.y + 3);
      doc.moveDown(1.5);

      const col1 = 50;  const col2 = 420; const col3 = 510; 

      const desenharCabecalho = (y) => {
          doc.save().rect(40, y - 4, 515, 18).fill('#e0e0e0').restore();
          doc.fillColor('black').fontSize(9).font('Helvetica-Bold');
          doc.text('CÓD. - CLIENTE', col1, y);
          doc.text('NÍVEL', col2, y);
          doc.text('DIAS', col3, y);
      };

      desenharCabecalho(doc.y);
      doc.moveDown(1.2); 

      let currentY = doc.y;
      doc.font('Helvetica').fontSize(9);
      
      for (const item of listaClientes) {
          if (currentY > 720) { 
              doc.addPage(); 
              desenharCabecalho(40);
              currentY = 65; 
              doc.font('Helvetica').fontSize(9);
          }
          
          if (item.dias >= 60) doc.fillColor('#c0392b'); 
          else if (item.dias >= 30) doc.fillColor('#d35400'); 
          else doc.fillColor('#27ae60'); 
          
          const nomeExibicao = `${item.codcli} - ${item.nome}`;
          doc.text(nomeExibicao.substring(0, 60), col1, currentY);
          doc.text(item.nivel.substring(0, 10), col2, currentY);
          doc.text(item.dias.toString(), col3, currentY);
          
          doc.save().moveTo(40, currentY + 12).lineTo(555, currentY + 12).strokeColor('#eeeeee').stroke().restore();
          currentY += 16;
      }

      if (currentY > 700) doc.addPage();
      doc.fontSize(8).fillColor('#999999').text(`Total de registros: ${listaClientes.length}`, 40, currentY + 20);
      doc.end();
    });
  }

  _drawBox(doc, x, y, w, l, v, c) {
    doc.save();
    doc.rect(x+2, y+2, w, 45).fill('#cccccc');
    doc.rect(x, y, w, 45).fill(c);
    doc.fillColor('#333333');
    doc.fontSize(8).font('Helvetica').text(l, x, y + 8, { width: w, align: 'center' }); 
    doc.fillColor('black');
    doc.fontSize(14).font('Helvetica-Bold').text(v.toString(), x, y + 22, { width: w, align: 'center' }); 
    doc.restore();
  }
}

module.exports = RelatorioService;
// movimentacao-carteira-service.js
// Sistema de Movimentação de Carteira
// ✅ Etapa 1: Base de Performance e Dados Cadastrais
// ✅ Etapa 3.1: Exceção de Upgrade (60 dias) - FIX: Tratamento de NULL no banco
// ✅ Etapa 3.2: Exceção de Negociação Ativa Bitrix (Incluindo ID UC_L7NUC2 e C4:FINAL_INVOICE)
// ✅ Etapa 3.3: Exceção de Sazonalidade (Bloqueio de Downgrade na Chuva - Out a Mar)
// ✅ Etapa 2: Classificação e Ações (Ignorada se houver bloqueio de fluxo)

const PerformanceClientes = require('./performance-clientes');
const RotativoRepository = require('./rotativo-repository'); 
//const { atualizarRcaClienteTeste, atualizarClassificacaoCliente } = require('./winthor-teste-connection');
const ClienteRepository = require('./cliente-repository'); 
const BitrixService = require('./bitrix-service'); 
const RcaRepository = require('./rca-repository');        
const dbSwitch = require('./db-switch');
const oracledb = require('oracledb');

/**
 * Helpers de datas
 */
// Calcula diferença em dias entre duas datas (d2 - d1)
function diffDias(d1, d2) {
  const msPorDia = 24 * 60 * 60 * 1000;
  const t1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
  const t2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
  return Math.floor((t2 - t1) / msPorDia);
}

// Helper de sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MovimentacaoCarteiraService {
  /**
   * @param {Console|{log:Function,error:Function}} logger
   */
  constructor(logger) {
    this.logger = logger || console;
    this.performance = new PerformanceClientes();

    this.rcaRepo = new RcaRepository(this.logger);
    
    // Dependências para Bitrix/Postgres:
    this.clienteRepo = new ClienteRepository();
    this.bitrixService = new BitrixService(this.logger); 
    //Cache para não consultar o banco a cada milissegundo
    this.cachedParams = null;
    this.lastParamsFetch = 0;

    // Inicializa RotativoRepository
    try {
      this.rotativoRepo = new RotativoRepository(this.logger);
    } catch (err) {
      this.rotativoRepo = null;
      if (this.logger?.error) {
        this.logger.error(
          '[MovCarteira] Erro ao inicializar RotativoRepository:',
          err && err.message ? err.message : err
        );
      }
    }
  }

  // 🆕 Recupera regras do banco ou usa fallback


async _getRegrasParametros() {
    const now = Date.now();
    // Cache de 60 segundos
    if (!this.cachedParams || (now - this.lastParamsFetch > 60000)) {
        if (this.rotativoRepo) {
            const params = await this.rotativoRepo.obterParametrosSistema();
            if (params) {
                this.cachedParams = params;
                this.lastParamsFetch = now;
            }
        }
    }

    // Fallback completo — incluindo o novo campo rca_segmento_map
    return this.cachedParams || {
        dias_rotativa:              60,  // ✅ FIX #10: Era 31, corrigido para 60 (Ouro/Prata/Bronze)
        dias_rotativa_alto:         45,  // ✅ FIX #1: NOVO - Diamante/Platinum
        dias_longo_prazo:           90,  // ✅ FIX #2: Era 60, corrigido para 90
        dias_protecao_upgrade:      60,
        meses_sazonalidade_inicio:  10,
        meses_sazonalidade_fim:     3,
        fases_bitrix_bloqueio: [
            'C1:NEW', 'EM_NEGOCIACAO', 'COBRADO_ORCAMENTO',
            'UC_L7NUC2', 'C4:FINAL_INVOICE'
        ],
        // 🆕 NOVO: Mapa de segmentação RCA x CODATV1
        // Chave  = CODUSUR do vendedor (número)
        // Valor  = array de CODATV1 que esse RCA pode receber
        // Vazio  = RCA aceita qualquer segmento (sem restrição)
        rca_segmento_map: {
            // ✅ FIX: Fallback ativo com mapeamento correto (usado se o banco estiver inacessível)
            10:  [11, 12],   // RCA 10  → SERVIÇOS (11) prioridade + CORPORATIVO (12)
            110: [10],       // RCA 110 → REVENDA (10)
        }
    };
}

  // ===================================================================
  // NOVOS MÉTODOS COM DB-SWITCH
  // ===================================================================
  async _getPool() {
      let pool = dbSwitch.getPool();
      if (!pool) {
          const config = dbSwitch.getConfig();
          pool = await oracledb.createPool(config);
          dbSwitch.setPool(pool);
      }
      return pool;
  }

  async _atualizarRcaCliente(codcli, novoRca) {
      const pool = await this._getPool();
      let conn;
      try {
          conn = await pool.getConnection();
          const result = await conn.execute(
              `UPDATE PCCLIENT SET CODUSUR1 = :novoRca WHERE CODCLI = :codcli`,
              { novoRca, codcli },
              { autoCommit: true }
          );
          this.logger?.log?.(`[Oracle/${dbSwitch.getCurrentEnvName()}] RCA atualizado: Cli ${codcli} -> ${novoRca}`);
          return result.rowsAffected;
      } catch (err) {
          this.logger?.error?.(`Erro ao atualizar RCA no Oracle (${dbSwitch.getCurrentEnvName()}):`, err);
          throw err;
      } finally {
          if (conn) await conn.close();
      }
  }

  async _atualizarClassificacao(codcli, codRede, categoria, codAtv) {
      const pool = await this._getPool();
      let conn;
      try {
          conn = await pool.getConnection();
          // ✅ FIX: Agora atualiza também o CODATV1 para garantir a segmentação correta no WinThor
          const result = await conn.execute(
              `UPDATE PCCLIENT SET CODREDE = :codRede, CATEGORIA = :categoria, CODATV1 = :codAtv WHERE CODCLI = :codcli`,
              { codRede, categoria, codAtv, codcli },
              { autoCommit: true }
          );
          this.logger?.log?.(`[Oracle/${dbSwitch.getCurrentEnvName()}] Classificação atualizada: Cli ${codcli} -> Rede ${codRede}, Cat ${categoria}, Atv ${codAtv}`);
          return result.rowsAffected;
      } catch (err) {
          this.logger?.error?.(`Erro ao atualizar classificação no Oracle (${dbSwitch.getCurrentEnvName()}):`, err);
          throw err;
      } finally {
          if (conn) await conn.close();
      }
  }

  // ===================================================================
  // HELPER DE SAZONALIDADE (EXCEÇÃO 3)
  // ===================================================================
    _isTemporadaAguas(mesInicio, mesFim) {
        const mes = new Date().getMonth() + 1; 
        
        // Lógica para intervalo que vira o ano (ex: Out(10) a Mar(3))
        if (mesInicio > mesFim) {
            return mes >= mesInicio || mes <= mesFim;
        } else {
            // Lógica para intervalo no mesmo ano (ex: Jun(6) a Ago(8))
            return mes >= mesInicio && mes <= mesFim;
        }
      }


      
  // ===================================================================
  // CLASSIFICAÇÃO E HIERARQUIA (INCLUINDO ROBUSTEZ)
  // ===================================================================
  _getFaixaFromScore(score) {
    const s = parseFloat(score) || 0;
    if (s < 6.0) return 'BRONZE';
    if (s >= 6.0 && s < 7.0) return 'PRATA';
    if (s >= 7.0 && s < 8.0) return 'OURO';
    if (s >= 8.0 && s < 9.0) return 'PLATINUM';
    return 'DIAMANTE';
  }
  
  /**
   * Retorna o nível numérico da faixa, com tratamento de string (trim/toUpperCase).
   */
  _getNivelFaixa(faixa) {
    const map = { 'BRONZE': 1, 'PRATA': 2, 'OURO': 3, 'PLATINUM': 4, 'DIAMANTE': 5 };
    // 🚨 CORREÇÃO DE ROBUSTEZ: Limpar e capitalizar a string
    const f = (faixa && typeof faixa === 'string') ? faixa.toUpperCase().trim() : faixa; 
    return map[f] || 0;
  }
  
  
  
  /**
   * Mapeia o código da atividade (CODATV1) para o nome (12, 11, 10).
   */
  _mapCodAtvToName(codAtv) {
    const cod = Number(codAtv);
    if (cod === 12) return 'CORPORATIVO\\INDUSTRIAL';
    if (cod === 11) return 'SERVICOS';
    if (cod === 10) return 'REVENDA';
    return null; 
  }

  /**
   * Aplica a fórmula exata para definir o CODREDE.
   */
  _calcularCodRedePelaRegra(ramoNome, faixa) {
    if (!ramoNome || !faixa) return null;
    
    // Garantir que as strings estão limpas e maiúsculas
    const r = ramoNome.toUpperCase().trim(); 
    const f = faixa.toUpperCase().trim();    

    if (r === 'CORPORATIVO\\INDUSTRIAL') {
        if (f === 'BRONZE') return 15;
        if (f === 'PRATA') return 14;
        if (f === 'OURO') return 13;
        if (f === 'PLATINUM') return 12;
        if (f === 'DIAMANTE') return 11;
    }
    
    if (r === 'SERVICOS') {
        if (f === 'BRONZE') return 10;
        if (f === 'PRATA') return 9;
        if (f === 'OURO') return 8;
        if (f === 'PLATINUM') return 7;
        if (f === 'DIAMANTE') return 6;
    }

    if (r === 'REVENDA') {
        if (f === 'BRONZE') return 5;
        if (f === 'PRATA') return 4;
        if (f === 'OURO') return 3;
        if (f === 'PLATINUM') return 2;
        if (f === 'DIAMANTE') return 1;
    }

    return null; 
  }

  /**
   * Consulta o PerformanceClientes com retry, para evitar erro de pool ainda não pronto.
   */
  async _consultarPerformanceComRetry(filtros, contextoLog) {
    let resultados = null;
    const maxTentativas = 3;

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
      try {
        resultados = await this.performance.calcularPerformance(filtros);
        return resultados;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const parecePool =
          msg.includes('getConnection') ||
          msg.includes('connectionPool') ||
          msg.includes('pool');

        if (parecePool && tentativa < maxTentativas) {
          const espera = 500 * tentativa; 
          if (this.logger?.log) {
            this.logger.log(
              `[MovCarteira] (${contextoLog}) Pool ainda não pronto (tentativa ${tentativa}/${maxTentativas}). ` +
                `Esperando ${espera}ms e tentando de novo...`
            );
          }
          await sleep(espera);
          continue;
        }

        if (this.logger?.error) {
          this.logger.error(`[MovCarteira] Erro em ${contextoLog}:`, err);
        }
        throw err;
      }
    }

    return resultados;
  }

  /**
   * Monta a "base" do cliente (dados comuns) a partir de um array de resultados
   */
  _montarBaseAPartirDosResultados(resultados, origem) {
    if (!resultados || resultados.length === 0) {
      return {
        codcli: null, cliente: null, rcaResponsavel: null, dataUltimoPedido: null, diasSemCompra: null, 
        qualificacao: null, notaMediaGeral: null, classificacaoAtual: null, historicoFaturamento: [],
        codRamoAtividade: null, ramoAtividadeNome: null, classeCodigo: null, faixaCalculada: null,
      };
    }
    const primeiro = resultados[0];
    // =================================================================================
    // CORREÇÃO: Garantir que pegamos o nome, independente da caixa (Maiúscula/Minúscula)
    // =================================================================================
    const nomeCliente = primeiro.CLIENTE || primeiro.cliente || primeiro.NOME || primeiro.nome || `Cliente ${primeiro.CODCLI || primeiro.codcli}`;
    const nomeFantasia = primeiro.FANTASIA || primeiro.fantasia || nomeCliente;
    const historicoPorMes = [];
    const vistos = new Set();

    for (const row of resultados) {
      const chave = row.MES_ANO;
      if (!chave || vistos.has(chave)) continue;
      vistos.add(chave);

      historicoPorMes.push({
        mesAno: row.MES_ANO, ano: row.ANO, mes: row.MES, vlLiquido: row.VLLIQUIDO || 0,
      });
    }

    historicoPorMes.sort((a, b) => {
      const aa = Number(a.ano); const ab = Number(b.ano); const ma = Number(a.mes); const mb = Number(b.mes);
      if (aa !== ab) return ab - aa; return mb - ma;
    });

    const historicoUltimos2Meses = historicoPorMes.slice(0, 2);

    // ======================== DATA ÚLTIMO PEDIDO ========================
    let dataUltimoPedido = null;
    let diasSemCompra = null;

    if (primeiro.DT_ULTIMA_VENDA instanceof Date) { dataUltimoPedido = primeiro.DT_ULTIMA_VENDA; } else if (primeiro.DT_ULTIMA_VENDA) { const parsed = new Date(primeiro.DT_ULTIMA_VENDA); if (!isNaN(parsed.getTime())) { dataUltimoPedido = parsed; } }
    if (!dataUltimoPedido && historicoPorMes.length > 0) { const maisRecente = historicoPorMes[0]; dataUltimoPedido = new Date(Number(maisRecente.ano), Number(maisRecente.mes), 0); }

    if (dataUltimoPedido) {
      const hoje = new Date();
      let diff = diffDias(dataUltimoPedido, hoje);
      if (diff < 0) diff = 0;
      diasSemCompra = diff;
    }

    // ===================== CÁLCULO DA NOTA MÉDIA GERAL (FIX 6 MESES FECHADOS) =====================
    let notaMediaGeral = null;
    if (resultados && resultados.length > 0) {
        // CORREÇÃO: Usar apenas meses FECHADOS (ignora mês corrente)
        const hoje = new Date();
        const mesAtual = hoje.getMonth() + 1;
        const anoAtual = hoje.getFullYear();

        // 1. Filtra removendo o mês atual (ou futuro)
        const dadosFechados = resultados.filter(item => {
            const mesItem = parseInt(item.MES);
            const anoItem = parseInt(item.ANO);
            // Aceita se for ano anterior OU (ano atual E mês anterior)
            return anoItem < anoAtual || (anoItem === anoAtual && mesItem < mesAtual);
        });

        // 2. Pega apenas os 6 primeiros registros (últimos 6 meses FECHADOS)
        const baseCalculo = dadosFechados.slice(0, 6);

        // 3. Filtra apenas os meses que possuem nota (onde houve compra)
        const mesesComCompra = baseCalculo.filter(item => parseFloat(item.MEDIA_PONDERADA) > 0);

        // 4. Calcula a média real: soma das notas dividida pela quantidade de meses com compra
        let mediaCalculada = 0;
        if (mesesComCompra.length > 0) {
            const somaNotas = mesesComCompra.reduce((sum, item) => sum + parseFloat(item.MEDIA_PONDERADA), 0);
            mediaCalculada = somaNotas / mesesComCompra.length;
        } else {
            // Se não comprou nada nos últimos 6 meses, a nota é 0 (Bronze)
            mediaCalculada = 0;
        }
        
        notaMediaGeral = Number.isNaN(mediaCalculada) ? null : mediaCalculada;
    }

    const faixaCalculada = this._getFaixaFromScore(notaMediaGeral);
    let qualificacaoFormatada;
    if (faixaCalculada && notaMediaGeral != null) { qualificacaoFormatada = `${faixaCalculada} ${notaMediaGeral.toFixed(2)}`; } else { qualificacaoFormatada = faixaCalculada || null; }

    const classificacaoAtual = primeiro.CATEGORIA || null;
    const rcaResponsavel = primeiro.CODUSUR_ATUAL ?? null;
    
    // CAMPOS DE CLASSIFICAÇÃO E RAMO
    const codAtv1 = primeiro.COD_RAMO_ATIVIDADE ?? null; 
    const ramoAtividadeNome = this._mapCodAtvToName(codAtv1);
    const classeCodigo = primeiro.CLASSE_CODIGO ?? null; 


    const base = {
      codcli: primeiro.CODCLI || primeiro.codcli, 
      cliente: nomeCliente, // AQUI ESTÁ A CORREÇÃO APLICADA
      fantasia: nomeFantasia, // AQUI TAMBÉM
      rcaResponsavel, dataUltimoPedido, diasSemCompra, 
      qualificacao: qualificacaoFormatada, faixaCalculada: faixaCalculada, // NOVO: Faixa limpa (Ex: BRONZE)
      notaMediaGeral, classificacaoAtual, classeCodigo, 
      codRamoAtividade: codAtv1, ramoAtividadeNome: ramoAtividadeNome, historicoFaturamento: historicoUltimos2Meses,
    };

    if (this.logger?.log) {
      this.logger.log(`[MovCarteira] ETAPA 1 (${origem}) → base montada:`, {
        codcli: base.codcli, cliente: base.cliente, rcaResponsavel: base.rcaResponsavel, diasSemCompra: base.diasSemCompra, qualificacao: base.qualificacao, notaMediaGeral: base.notaMediaGeral, classificacaoAtual: base.classificacaoAtual,
        codRamoAtividade: base.codRamoAtividade, ramoAtividadeNome: base.ramoAtividadeNome, classeCodigo: base.classeCodigo,
      });
    }

    return base;
  }

  /**
   * ETAPA 1: Montar Base Cliente
   */
  async etapa1MontarBaseCliente({ CodFilial, ClienteCod, DataIni, DataFim }) {
    if (!ClienteCod) { throw new Error('[MovCarteira] ClienteCod é obrigatório na Etapa 1'); }

    const filiais = Array.isArray(CodFilial) ? CodFilial : [CodFilial];

    if (DataIni && DataFim) {
      const resultadosDatasExplicitas = await this._consultarPerformanceComRetry({ DataIni, DataFim, CodFilial: filiais, ClienteCod }, 'datas-explicitas');
      if (resultadosDatasExplicitas && resultadosDatasExplicitas.length > 0) {
        return this._montarBaseAPartirDosResultados(resultadosDatasExplicitas, 'datas-explicitas');
      }
    }

    // Fallback: Agora expandido para 12 meses para garantir que clientes inativos de longa data sejam processados
    const hoje = new Date();
    const inicio = new Date(hoje.getFullYear(), hoje.getMonth() - 12, 1); // 12 meses atrás
    const format = (d) => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    const periodoFallback = { DataIni: format(inicio), DataFim: format(hoje) };

    const resultadosFallback = await this._consultarPerformanceComRetry({ DataIni: periodoFallback.DataIni, DataFim: periodoFallback.DataFim, CodFilial: filiais, ClienteCod }, 'fallback');

    return this._montarBaseAPartirDosResultados(resultadosFallback || [], 'fallback');
  }

/**
   * ETAPA 2 (regras com parâmetros dinâmicos)
   */
  aplicarEtapa2DecisaoCarteira(baseCliente, params) { // 1. Recebe params
    const dias = baseCliente.diasSemCompra;
    let grupo = null;

    // ✅ FIX #1 + #10: Regras DIFERENCIADAS por nível de classificação
    const faixa = (baseCliente.faixaCalculada || '').toUpperCase().trim();
    const isAltoNivel = (faixa === 'DIAMANTE' || faixa === 'PLATINUM');

    // Parâmetros do banco com fallbacks CORRETOS
    const diasRotativaAlto   = params?.dias_rotativa_alto   || 45;  // Diamante/Platinum: 45 dias
    const diasRotativaBaixo  = params?.dias_rotativa         || 60;  // Ouro/Prata/Bronze: 60 dias (FIX: era 31)
    const diasLongoPrazo     = params?.dias_longo_prazo      || 90;  // ✅ FIX #2: Era 60, corrigido para 90

    const diasRotativa = isAltoNivel ? diasRotativaAlto : diasRotativaBaixo;

    if (dias == null) { 
        grupo = null; 
    } 
    // 2. Usa a variável diasRotativa (que virá do banco, ex: 22)
    else if (dias >= diasRotativa && dias < diasLongoPrazo) { 
        grupo = 'CARTEIRA_ROTATIVA'; 
    } 
    else if (dias >= diasLongoPrazo) { 
        grupo = 'CARTEIRA_LONGO_PRAZO'; 
    } 
    else { 
        grupo = 'NORMAL'; 
    }

    const resultado = { 
        ...baseCliente, 
        grupoCarteira: grupo, 
        emAlertaRotativa: grupo === 'CARTEIRA_ROTATIVA', 
        acoesPlanejadas: {} 
    };

    // Atualiza também as mensagens de log para refletir os dias reais
    if (grupo === 'CARTEIRA_ROTATIVA') {
        resultado.acoesPlanejadas.anotacoesSistema = `Marcar cliente como "Carteira Rotativa" (alerta para o RCA atual). Se > ${diasRotativa} dias, reprocessar na Etapa 5.`;
    } else if (grupo === 'CARTEIRA_LONGO_PRAZO') {
        resultado.acoesPlanejadas.anotacoesSistema = `Movimentar para Carteira de Longo Prazo (RCA 118) e registrar histórico (> ${diasLongoPrazo} dias).`;
        resultado.acoesPlanejadas.bitrix = 'Alterar responsável para Safronildo (ID 77810), preencher RCA Anterior (UF_CRM_1763486078), Data de Remanejamento (UF_CRM_1763485853) e RCA Atual (UF_CRM_1677778590390).';
    }

    if (this.logger?.log) {
      this.logger.log(`[MovCarteira] ETAPA 2 → Cliente ${resultado.codcli} (${faixa}) classificado como: ${resultado.grupoCarteira} (Dias s/ Compra: ${dias} | Regra ${isAltoNivel ? 'ALTO' : 'NORMAL'}: >= ${diasRotativa} | LP: >= ${diasLongoPrazo})`);
    }

    return resultado;
  }

  // ===================================================================
  // ETAPA 3.1 E 3.3: UPGRADE (EXCEÇÃO 1) e SAZONALIDADE (EXCEÇÃO 3)
  // ===================================================================
  async _verificarUpgradeEAtualizar(base, params) {
    const { 
        codcli, cliente, faixaCalculada, classificacaoAtual, classeCodigo, ramoAtividadeNome 
    } = base;

    // Se classificacaoAtual vier nula, tentamos atualizar o cadastro mas não bloqueamos
    if (!faixaCalculada || !ramoAtividadeNome) return { bloqueado: false }; 

    // Define dias de proteção (Default: 60)
    const diasProtecao = params?.dias_protecao_upgrade || 60;

    // 1. Verifica proteção existente no Postgres (Upgrade recente) - Exceção 1
    if (this.rotativoRepo) {
      const protecaoAtiva = await this.rotativoRepo.consultarProtecaoAtiva(codcli, diasProtecao);
      if (protecaoAtiva) {
        const diasRestantes = Math.max(1, Math.ceil(Number(protecaoAtiva.dias_restantes || 0)));
        
        // USA PARÂMETRO DINÂMICO
        const origemProtecao = String(protecaoAtiva.origem_protecao || 'UPGRADE').toUpperCase();
        const motivo = origemProtecao === 'MANUAL'
          ? `PROTECAO_MANUAL_ATIVA (Restam ${diasRestantes} dias)`
          : `PROTECAO_UPGRADE_ATIVA (Restam ${diasRestantes} dias)`;
        this.logger?.log?.(
          `[Etapa 3/Protecao] Cliente ${codcli} com protecao ${origemProtecao} ativa. Restam ${diasRestantes} dias. Bloqueado.`
        );
        return {
          bloqueado: true,
          motivo
        };
      }
    }

    // 2. Lógica de Divergência (Detectar Novo Upgrade/Downgrade/Correção)
    const codRedeCorreto = this._calcularCodRedePelaRegra(ramoAtividadeNome, faixaCalculada);
    
    // Níveis numéricos, agora robustos
    const nivelNovo = this._getNivelFaixa(faixaCalculada);      
    const nivelBanco = this._getNivelFaixa(classificacaoAtual); 

    // Verifica se precisa atualizar: 1) Nível mudou OU 2) O Código da Classe no banco está errado
    const precisaAtualizarBanco = (nivelNovo !== nivelBanco) || (Number(classeCodigo) !== codRedeCorreto);
    
    if (precisaAtualizarBanco) {
        this.logger?.log?.(`[Etapa 3/Divergência] Cli ${codcli}: Banco[${classificacaoAtual}/ID:${classeCodigo}] vs Real[${faixaCalculada}/ID:${codRedeCorreto}]`);

        // EXCEÇÃO 3: Sazonalidade (Águas) - BLOQUEIA DOWNGRADE
        const isDowngrade = nivelNovo < nivelBanco;
        // USA PARÂMETROS DINÂMICOS
        const isAguas = this._isTemporadaAguas(params?.meses_sazonalidade_inicio, params?.meses_sazonalidade_fim);

        if (isDowngrade && isAguas) {
            this.logger?.log?.(`[Etapa 3/Sazonalidade] 🌧️ Temporada de Águas: Downgrade BLOQUEADO (${classificacaoAtual} -> ${faixaCalculada}). Mantendo classificação atual.`);
            // NÃO atualiza Oracle (Banco).
            // Retorna FALSE para permitir que o fluxo de Longo Prazo continue (conforme regra "Remanejamento CONTINUA ATIVO").
            return { bloqueado: false };
        }

        // Se não foi bloqueado pela Sazonalidade, prossegue com Update no Oracle
        try {
             if (this._atualizarClassificacao) {
                 // ✅ FIX: Passando também o codRamoAtividade para atualizar o CODATV1 no WinThor
                 await this._atualizarClassificacao(codcli, codRedeCorreto, faixaCalculada, base.codRamoAtividade); 
                 this.logger?.log?.(`[Etapa 3/Atualização] Oracle ATUALIZADO com sucesso: ${classificacaoAtual} -> ${faixaCalculada} (Rede: ${codRedeCorreto}, Atv: ${base.codRamoAtividade})`);
             } else {
                 this.logger?.warn?.('[Etapa 3] Função atualizarClassificacaoCliente não disponível.');
             }
        } catch (err) {
            this.logger?.error?.(`[Etapa 3] Erro ao atualizar classificação no Oracle: ${err.message}`);
        }

        // EXCEÇÃO 1: Se foi UPGRADE, registra e bloqueia remanejamento
        if (nivelNovo > nivelBanco) {
            // AÇÃO: Registrar o upgrade no Postgres
            if (this.rotativoRepo) {
                // 🚨 CORREÇÃO: Tratando NULL para evitar erro de constraint
                const anteriorValido = classificacaoAtual || 'SEM_CLASSIFICACAO';
                
                await this.rotativoRepo.registrarUpgradeCliente({
                    codcli, 
                    cliente, 
                    classificacaoAnterior: anteriorValido, 
                    classificacaoNova: faixaCalculada,
                });
            }

            this.logger?.log?.(`[Etapa 3/Exceção 1] UPGRADE Detectado (${classificacaoAtual} -> ${faixaCalculada}). **BLOQUEIO ATIVADO**.`);
            
            return { 
                bloqueado: true, 
                motivo: `PROTECAO_UPGRADE_RECENTE (${classificacaoAtual}->${faixaCalculada})` 
            };
        }
        
        // Downgrade ou Correção de código segue liberado
        this.logger?.log?.(`[Etapa 3] Alteração (Correção/Downgrade Seca) realizada. Fluxo segue normal.`);
    }

    return { bloqueado: false };
  }

  // ===================================================================
  // ETAPA 3.2: EXCEÇÃO DE NEGOCIAÇÃO BITRIX
  // ===================================================================
  async _verificarExcecaoBitrix(base, params) {
    // Só verificamos se o cliente estiver indo para Longo Prazo ou Rotativa crítica
    // Para otimizar API calls, não checamos clientes 'NORMAL'
    
    try {
        this.logger?.log?.(`[Etapa 3.2] Verificando Negociações Ativas no Bitrix para Cli ${base.codcli}...`);

        // 1. Buscar dados cadastrais para pegar telefone
        const dadosCadastrais = await this.clienteRepo.buscarDadosCadastrais(base.codcli);
        if (!dadosCadastrais) {
             this.logger?.warn?.(`[Etapa 3.2] Sem dados cadastrais para Cli ${base.codcli}. Pulando verificação Bitrix.`);
             return { bloqueado: false };
        }

        // 2. Buscar Contact ID no Bitrix
        const contactId = await this.bitrixService.buscarContatoPorTelefones(dadosCadastrais);
        if (!contactId) {
            this.logger?.log?.(`[Etapa 3.2] Contato não encontrado no Bitrix. Sem bloqueio.`);
            return { bloqueado: false };
        }

        // 3. Buscar Deals ativos modificados neste mês
        const dealsAtivos = await this.bitrixService.listarNegociosAtivos(contactId);

        this.logger?.log?.(`[Etapa 3.2] Encontrados ${dealsAtivos.length} negócios modificados neste mês para verificação.`);
        // Log detalhado para mostrar quais deals foram encontrados
        this.logger?.log?.(`[Etapa 3.2] Encontrados ${dealsAtivos.length} negócios: ${dealsAtivos.map(d => `${d.ID}(${d.STAGE_ID})`).join(', ')}`);
        
        if (!dealsAtivos || dealsAtivos.length === 0) {
            return { bloqueado: false };
        }

        // 4. Verificar se algum Deal está na fase de bloqueio
        // USA PARÂMETRO DINÂMICO
        const fasesBloqueio = params?.fases_bitrix_bloqueio || ['C1:NEW', 'EM_NEGOCIACAO', 'COBRADO_ORCAMENTO', 'UC_L7NUC2', 'C4:FINAL_INVOICE']; 

        const dealBloqueador = dealsAtivos.find(deal => {
            const stage = deal.STAGE_ID ? deal.STAGE_ID.toUpperCase() : '';
            const title = deal.TITLE ? deal.TITLE.toUpperCase() : '';
            
            // Lógica de match: ID exato OU contém "NEGOCIACAO" / "ORCAMENTO" (Hardcoded por segurança de negócio + lista dinâmica)
            const isFaseBloqueio = fasesBloqueio.includes(stage);
            const isTextoBloqueio = stage.includes('NEGOCIACAO') || title.includes('ORCAMENTO') || title.includes('NEGOCIA');

            return isFaseBloqueio || isTextoBloqueio;
        });

        if (dealBloqueador) {
            // Calcular data de fim do bloqueio (último dia do mês seguinte)
            const hoje = new Date();
            const ultimoDiaMesSeguinte = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 0);
            const dataFmt = ultimoDiaMesSeguinte.toLocaleDateString('pt-BR');

            this.logger?.log?.(`[Etapa 3.2] BLOQUEIO: Negociação Ativa encontrada (Deal ID ${dealBloqueador.ID} - ${dealBloqueador.TITLE}).`);
            
            return {
                bloqueado: true,
                motivo: `NEGOCIACAO_BITRIX_ATIVA (Deal ${dealBloqueador.ID}). Bloqueado até ${dataFmt}.`
            };
        }

    } catch (err) {
        this.logger?.error?.(`[Etapa 3.2] Erro na verificação Bitrix: ${err.message}`);
    }

    return { bloqueado: false };
  }

  // ===================================================================
  // 🚀 ETAPA 5: REDISTRIBUIÇÃO DE CARTEIRAS (ATUALIZADO)
  // ===================================================================
  

  _obterBitrixIdPorRca(codRca, params) {
    // 1. Tenta pegar do mapa configurado no banco (Prioridade)
    if (params && params.mapa_bitrix && params.mapa_bitrix[codRca]) {
        return params.mapa_bitrix[codRca];
    }

    // 2. Fallback Hardcoded (Caso o banco esteja vazio ou falhe)
    const mapaFixo = {
      121: 106114, 122: 106116, 123: 106118, 124: 106122,
      125: 106124, 126: 110994, 127: 110996, 128: 111002,
      10:  256, 110: 164
    };
    
    return mapaFixo[codRca] || null;
  }

  // ===================================================================
  // 🚀 ETAPA 5: REDISTRIBUIÇÃO INTELIGENTE (COTAS + TETO ABSOLUTO)
  // ===================================================================

// ===================================================================
  // 🚀 ETAPA 5: REDISTRIBUIÇÃO INTELIGENTE (COTAS + TETO ABSOLUTO)
  // ===================================================================

  async executarEtapa5Redistribuicao({ skipBitrix = false } = {}) {
    this.logger?.log?.(
      `🚀 [Etapa 5] Iniciando Distribuição (Respeitando Cotas vs Upgrades)... Bitrix: ${
        skipBitrix ? 'DESLIGADO (modo teste)' : 'ATIVO'
      }`
    );

    // 1. Carregar Parâmetros do Banco (Para pegar o Mapeamento Bitrix atualizado)
    const params = await this._getRegrasParametros();

    // --- ⚙️ CONFIGURAÇÃO DE LIMITES ---
    // Limite Físico: Se bater aqui, o vendedor não recebe mais ninguém.
    const LIMITE_TETO_ABSOLUTO = 300; 

    // Cotas para Novos Clientes (Vindos da Fila):
    const COTAS_DISTRIBUICAO = {
        'DIAMANTE': 11, 
        'PLATINUM': 30,  
        'OURO':     50,
        'PRATA':    80,
        'BRONZE':   120, 
        'NORMAL':   120 // Fallback
    };
    // ----------------------------------

    // 2. Buscar Vendedores Detalhados (Raio-X da carteira)
    // O RcaRepository já sabe quais RCAs buscar baseado na configuração do banco
    let vendedores = await this.rcaRepo.buscarVendedoresDetalhados();
    
    if (!vendedores || vendedores.length === 0) {
        this.logger?.log?.('[Etapa 5] Nenhum vendedor elegível encontrado.');
        return;
    }

    // 3. Buscar Clientes na fila do Postgres (Rotativa)
    let clientesRotativa = await this.rotativoRepo.listarTodosRotativos();
    if (!clientesRotativa || clientesRotativa.length === 0) {
        this.logger?.log?.('[Etapa 5] Fila rotativa vazia. Nada a distribuir.');
        return;
    }

  // 4. ORDENAÇÃO: Prioridade total para os melhores clientes
    // ✅ FIX: Critérios: 1º Maior nível (Diamante>Platinum>...) | 2º Maior nota | 3º MENOS dias sem compra
    clientesRotativa.sort((a, b) => {
        // Critério 1: Peso da Categoria (Diamante > Platinum > Ouro > Prata > Bronze)
        const pesoA = this._getNivelFaixa(a.classificacao_atual);
        const pesoB = this._getNivelFaixa(b.classificacao_atual);
        
        if (pesoB !== pesoA) return pesoB - pesoA;

        // Critério 2: Extrai a nota do texto da qualificacao (ex: de "BRONZE 5.95" tira "5.95")
        const extrairNota = (qualificacao) => {
            if (!qualificacao) return 0;
            const partes = qualificacao.trim().split(' ');
            return parseFloat(partes[partes.length - 1]) || 0;
        };

        const notaA = extrairNota(a.qualificacao);
        const notaB = extrairNota(b.qualificacao);

        // Quem tem a MAIOR nota vem primeiro na distribuição
        if (notaB !== notaA) return notaB - notaA;

        // ✅ Critério 3 (NOVO): MENOS dias sem compra primeiro (cliente mais "fresco" = mais fácil de reativar)
        const diasA = a.dias_sem_compra || 9999;
        const diasB = b.dias_sem_compra || 9999;
        return diasA - diasB;  // Menor dias_sem_compra vem primeiro
    });

    this.logger?.log?.(`[Etapa 5] Distribuindo ${clientesRotativa.length} clientes (Começando pelos melhores)...`);

    let distribuidos = 0;

// 5. Loop de Distribuição (Cliente -> Vendedor)
    for (const cliente of clientesRotativa) {
        const codcli = cliente.codcli;
        
        const categoriaCli = cliente.classificacao_atual 
            ? cliente.classificacao_atual.toUpperCase().trim() 
            : 'BRONZE';

        // =================================================================
        // A. BUSCAR O RAMO DE ATIVIDADE DO CLIENTE NO ORACLE
        // =================================================================
        let codAtividadeCli = null;
        let dadosCad = null;
        try {
             dadosCad = await this.clienteRepo.buscarDadosCadastrais(codcli);
             if (dadosCad) {
                 codAtividadeCli = dadosCad.CODATV1; // Pega o código (ex: 10, 11, 12)
             }
        } catch(e) {
             this.logger?.error?.(`Erro ao buscar dados do cli ${codcli}:`, e.message);
        }

        // =================================================================
        // B. TENTA ENCONTRAR UM VENDEDOR COM VAGA E PERMISSÃO
        // =================================================================
        const vendedorEleito = vendedores.find(v => {
            // Regra 1: Teto Máximo
            if (v.TOTAL_ATUAL >= LIMITE_TETO_ABSOLUTO) {
                return false; 
            }

            // Regra 2: NOVA REGRA DE SEGMENTO (RCA x CODATV1)
            const mapaSegmentos = params.rca_segmento_map || {};
            const ramosPermitidos = mapaSegmentos[v.CODUSUR];

            if (ramosPermitidos && Array.isArray(ramosPermitidos) && ramosPermitidos.length > 0) {
                // Se CODATV1 nulo/desconhecido → NÃO bloqueia (não penaliza cliente sem ramo)
                if (codAtividadeCli !== null && codAtividadeCli !== undefined) {
                    const codAtv = Number(codAtividadeCli);
                    if (!ramosPermitidos.includes(codAtv)) {
                        this.logger?.log?.(
                            `[Etapa 5] 🚫 Segmento incompatível: Cli ${codcli} CODATV1=${codAtv} bloqueado no RCA ${v.CODUSUR} (aceita: ${ramosPermitidos.join(',')})`
                        );
                        return false;
                    }
                }
            }

            // Regra 3: Cotas da Categoria
            const cotaAlvo = COTAS_DISTRIBUICAO[categoriaCli] || 999;
            const qtdAtualVendedor = v[`QTD_${categoriaCli}`] || 0;

            if (qtdAtualVendedor >= cotaAlvo) {
                return false;
            }

            return true;
        });

        if (vendedorEleito) {
            const rcaNovo = vendedorEleito.CODUSUR;
            const qtdCat = vendedorEleito[`QTD_${categoriaCli}`] || 0;
            const cotaCat = COTAS_DISTRIBUICAO[categoriaCli];
            
            this.logger?.log?.(
              `[Etapa 5] 🔄 Cli ${codcli} (${categoriaCli}) -> RCA ${rcaNovo}. (Carteira: ${qtdCat}/${cotaCat} ${categoriaCli}s | Total: ${vendedorEleito.TOTAL_ATUAL}/${LIMITE_TETO_ABSOLUTO})`
            );

            try {
                // A. Atualiza WinThor (Oracle)
                await this._atualizarRcaCliente(codcli, rcaNovo);

                // B. Atualiza Bitrix (somente se skipBitrix = false)
                // ✅ FIX #13: Reutiliza dadosCad já buscado acima (evita query Oracle duplicada)
                if (!skipBitrix) {
                  if (dadosCad) {
                      const bId = await this.bitrixService.buscarContatoPorTelefones(dadosCad);
                      if (bId) {
                          // ATENÇÃO: Passamos 'params' aqui para ler o mapa dinâmico do banco
                          const targetBitrixUser = this._obterBitrixIdPorRca(rcaNovo, params);
                          
                          if (targetBitrixUser) {
                              await this.bitrixService.atualizarContato(bId, 118, rcaNovo, targetBitrixUser);
                          } else {
                              this.logger?.warn?.(`[Etapa 5] ID Bitrix não configurado para RCA ${rcaNovo}. Pulando atualização no CRM.`);
                          }
                      }
                  }
                } else {
                  this.logger?.log?.(
                    `[Etapa 5] [TEST] Bitrix NÃO atualizado para Cli ${codcli} (skipBitrix=true).`
                  );
                }

                // C. Postgres (Log e Remoção da Fila)
                if (this.rotativoRepo) {
                    // Remove da lista de espera
                    await this.rotativoRepo.removerClienteRotativo(codcli);
                    
                    // Registra o histórico da mudança
                    await this.rotativoRepo.registrarRemanejamentoGrupo2({
                        codcli,
                        cliente: cliente.cliente_nome || cliente.cliente || 'N/D',  // ✅ FIX: campo do Postgres é 'cliente_nome'
                        rcaAnterior: 118,
                        rcaNovo,
                        origem: 'ETAPA_5_DISTRIBUICAO',
                        dataRemanejamento: new Date(),
                        payload: { categoria: categoriaCli, motivo: 'Encaixe em Cota' }
                    });

                    // ✅ FIX #9: Completando objeto com todos os campos esperados
                    await this.rotativoRepo.salvarDadosRelatorio({
                        codcli,
                        cliente: cliente.cliente_nome || cliente.cliente || 'N/D',  // ✅ FIX: campo do Postgres é 'cliente_nome'
                        fantasia: cliente.cliente_nome || cliente.fantasia || cliente.cliente || 'N/D',
                        rcaResponsavel: rcaNovo,
                        diasSemCompra: cliente.dias_sem_compra || 0,
                        grupoCarteira: 'NORMAL',
                        faixaCalculada: categoriaCli,
                        notaMediaGeral: cliente.nota_media || 0,
                        dataUltimoPedido: cliente.data_ultimo_pedido || null,
                        motivoBloqueio: null,
                        historicoFaturamento: [],
                        origem: 'REDISTRIBUICAO'
                    });
                }

                // D. Atualiza contadores em memória para o próximo loop
                vendedorEleito.TOTAL_ATUAL++;
                
                if (vendedorEleito[`QTD_${categoriaCli}`] === undefined) {
                    vendedorEleito[`QTD_${categoriaCli}`] = 0;
                }
                vendedorEleito[`QTD_${categoriaCli}`]++;

                distribuidos++;

            } catch (err) {
                this.logger?.error?.(`[Etapa 5] Erro ao transferir Cli ${codcli}: ${err.message}`);
            }
        } else {
            this.logger?.log?.(
              `[Etapa 5] ⚠️ Cli ${codcli} (${categoriaCli}) sem vagas na cota. Sobra sendo enviada para RCA 118 (Longo Prazo).`
            );

            try {
                // A. Atualiza WinThor (Oracle) para RCA 118
                await this._atualizarRcaCliente(codcli, 118);

                // B. Atualiza Bitrix para a usuária do RCA 118 (Márcia / Atendimento)
                if (!skipBitrix) {
                  const dadosCad = await this.clienteRepo.buscarDadosCadastrais(codcli);
                  if (dadosCad) {
                      const bId = await this.bitrixService.buscarContatoPorTelefones(dadosCad);
                      if (bId) {
                          // ID da Márcia/Atendimento (Substitua pelo ID correto do Bitrix se necessário)
                          const bitrixId118 = 122; 
                          await this.bitrixService.atualizarContato(bId, 118, 118, bitrixId118);
                      }
                  }
                }

                // C. Remove da fila e registra no Postgres
                if (this.rotativoRepo) {
                    await this.rotativoRepo.removerClienteRotativo(codcli);
                    
                    await this.rotativoRepo.registrarRemanejamentoGrupo2({
                        codcli,
                        cliente: cliente.cliente_nome || cliente.cliente || 'N/D',  // ✅ FIX: campo do Postgres é 'cliente_nome'
                        rcaAnterior: 118, // Ou o RCA original, se vier da fila
                        rcaNovo: 118,
                        origem: 'ETAPA_5_SOBRA_COTA',
                        dataRemanejamento: new Date(),
                        payload: { categoria: categoriaCli, motivo: 'Sobrou na distribuição das cotas' }
                    });
                }
            } catch (err) {
                this.logger?.error?.(`[Etapa 5] Erro ao enviar sobra Cli ${codcli} para 118: ${err.message}`);
            }
        }
    }

    this.logger?.log?.(`✅ [Etapa 5] Redistribuição concluída. ${distribuidos} clientes distribuídos.`);
  }


  // ===================================================================
  // ORQUESTRADOR PRINCIPAL
  // ===================================================================
  async processarCliente({ competencia, CodFilial, ClienteCod, DataIni, DataFim }) {
    // 1. CARREGA PARÂMETROS DINÂMICOS 
    const params = await this._getRegrasParametros();
    // 1. ETAPA 1: Montar Base
    const base = await this.etapa1MontarBaseCliente({
      competencia, CodFilial, ClienteCod, DataIni, DataFim,
    });

    // 2. ETAPA 3 (VERIFICAÇÕES DE EXCEÇÃO)
    
    // 3.1 e 3.3 (Upgrade e Sazonalidade)
    let statusExcecao = await this._verificarUpgradeEAtualizar(base, params);

    // 3.2 Negociação Bitrix (Só verifica se não foi bloqueado pelo Upgrade)
    if (!statusExcecao.bloqueado) {
         // Verificamos Bitrix apenas se o cliente potencialmente for movido (dias sem compra alto)
         // Se diasSemCompra < 30, ele é NORMAL, não gastamos API call desnecessariamente.
         // ✅ FIX #11: Usar threshold dinâmico baseado no nível do cliente
         const faixaCheck = (base.faixaCalculada || '').toUpperCase().trim();
         const isAltoCheck = (faixaCheck === 'DIAMANTE' || faixaCheck === 'PLATINUM');
         const thresholdBitrix = isAltoCheck ? (params?.dias_rotativa_alto || 45) : (params?.dias_rotativa || 60);
         if (base.diasSemCompra >= thresholdBitrix) {
             const excecaoBitrix = await this._verificarExcecaoBitrix(base, params);
             if (excecaoBitrix.bloqueado) {
                 statusExcecao = excecaoBitrix; // Sobrescreve com o bloqueio do Bitrix
             }
         }
    }
    
    // LOG FINAL DA ETAPA 3
    if (statusExcecao.bloqueado) {
        this.logger?.log?.(`[MovCarteira] ETAPA 3: Status Final → BLOQUEADO. Motivo: ${statusExcecao.motivo}.`);
    } else {
        this.logger?.log?.('[MovCarteira] ETAPA 3: Status Final → LIBERADO.');
        
    }
    
    let comGrupo;

    if (statusExcecao.bloqueado) {
        // 🚨 SE BLOQUEADO, NÃO EXECUTAMOS A ETAPA 2
        comGrupo = {
            ...base,
            grupoCarteira: 'BLOQUEADO_POR_EXCECAO',
            motivoBloqueio: statusExcecao.motivo,
            acoesPlanejadas: { anotacoesSistema: 'Bloqueio por exceção (Upgrade ou Negociação Bitrix).' }
        };
    } else {
        // 3. ETAPA 2 (Executa classificação e preenchimento de ações APENAS se liberado)
        comGrupo = this.aplicarEtapa2DecisaoCarteira(base, params);
    }
    
    // 4. AÇÕES (Sync, Update Oracle, Bitrix) - APENAS se liberado
    if (!statusExcecao.bloqueado) {
        
        // 4.1 Sync Rotativo
        if (this.rotativoRepo && comGrupo.codcli) {
            try {
                await this.rotativoRepo.syncRotativo(comGrupo);
            } catch (err) {
                this.logger?.error?.(
                    '[MovCarteira] Erro ao sincronizar tabela clientes_rotativos:',
                    err && err.message ? err.message : err
                );
            }
        }

        // 4.2 Grupo 2: Carteira Longo Prazo (Ações de remanejamento)
        if (comGrupo.grupoCarteira === 'CARTEIRA_LONGO_PRAZO') {
            const rcaAnterior = comGrupo.rcaResponsavel;
            const rcaNovo = 118;

            // (a) Atualização no Oracle TESTE
            try {
                await this._atualizarRcaCliente(comGrupo.codcli, rcaNovo);
                this.logger?.log?.(`[MovCarteira] (Grupo 2) UPDATE TESTE PCCLIENT CODCLI=${comGrupo.codcli} RCA ${rcaAnterior} → ${rcaNovo} (Sucesso)`);
            } catch (err) {
                if (this.logger?.error) {
                    this.logger.error(
                        `[MovCarteira] FALHA ao atualizar Oracle TESTE (Cli: ${comGrupo.codcli}):`,
                        err && err.message ? err.message : err
                    );
                }
            }

            // (b) Registrar o “log” no Postgres
            if (this.rotativoRepo) {
                try {
                    await this.rotativoRepo.registrarRemanejamentoGrupo2({
                        codcli: comGrupo.codcli,
                        cliente: comGrupo.cliente,
                        rcaAnterior,
                        rcaNovo,
                        dataRemanejamento: new Date(),
                        diasSemCompra: comGrupo.diasSemCompra,
                        notaMediaGeral: comGrupo.notaMediaGeral,
                        classificacaoAtual: comGrupo.classificacaoAtual,
                        dataUltimoPedido: comGrupo.dataUltimoPedido,
                        payload: {
                            historicoFaturamento: comGrupo.historicoFaturamento,
                            acoesPlanejadas: comGrupo.acoesPlanejadas,
                        },
                    });
                } catch (err) {
                    this.logger?.error?.(
                        '[MovCarteira] Erro ao registrar remanejamento Grupo 2 no Postgres:',
                        err && err.message ? err.message : err
                    );
                }
            }

            // (c) Atualização Bitrix
            try {
                const dadosCadastrais = await this.clienteRepo.buscarDadosCadastrais(comGrupo.codcli);
                
                if (dadosCadastrais) {
                    const bitrixId = await this.bitrixService.buscarContatoPorTelefones(dadosCadastrais);

                    if (bitrixId) {
                        await this.bitrixService.atualizarContato(bitrixId, rcaAnterior, rcaNovo);
                    } 
                } 

            } catch (err) {
                this.logger?.error?.(`[MovCarteira] Erro na integração Bitrix: ${err.message}`);
            }
        }
    }

    // 🆕 =======================================================
    if (this.rotativoRepo) {
        // Grava o estado atual do cliente para gerar o PDF depois
        await this.rotativoRepo.salvarDadosRelatorio(comGrupo);
    }
    // 🆕 =======================================================
    
    return comGrupo;
  }

    /**
   * Processa automaticamente TODOS os clientes elegíveis em uma base,
   * respeitando o ambiente atual do db-switch (TEST/PROD).
   *
   * - Usa PerformanceClientes para descobrir quem existe no período/filiais.
   * - Para cada CODCLI, reaproveita o fluxo atual do processarCliente (Etapas 1, 2, 3, 4).
   * - Ao final, executa a Etapa 5 (Redistribuição na carteira rotativa).
   */
  /**
   * Processa automaticamente TODOS os clientes elegíveis em uma base,
   * respeitando o ambiente atual do db-switch (TEST/PROD).
   *
   * - Usa PerformanceClientes para descobrir quem existe no período/filiais.
   * - Para cada CODCLI, reaproveita o fluxo atual do processarCliente (Etapas 1, 2, 3, 4).
   * - Ao final, executa a Etapa 5 (Redistribuição na carteira rotativa).
   *
   * @param {Object} params
   * @param {number[]|number} params.CodFilial
   * @param {string} params.DataIni
   * @param {string} params.DataFim
   * @param {string|null} [params.competencia]
   * @param {boolean} [params.skipBitrixEtapa5=false] Se true, Etapa 5 roda sem chamar Bitrix.
   */
  async processarTodosClientesElegiveis({ CodFilial, DataIni, DataFim, competencia, skipBitrixEtapa5 = false }) {
    const filiais = Array.isArray(CodFilial) ? CodFilial : [CodFilial];

    this.logger?.log?.('===================================================');
    this.logger?.log?.('[MovCarteira] Iniciando processamento em massa de clientes elegíveis...');
    this.logger?.log?.(`Filiais: ${filiais.join(', ')} | Período: ${DataIni} a ${DataFim}`);
    this.logger?.log?.(
      `[MovCarteira] Modo Bitrix Etapa 5: ${skipBitrixEtapa5 ? 'DESLIGADO (teste)' : 'ATIVO (produção)'}`
    );
    this.logger?.log?.('===================================================');

    // 1) Monta filtros base para performance (SEM ClienteCod)
    const filtrosBase = {
      CodFilial: filiais,
      DataIni,
      DataFim,
      CodAtividade: [10, 11, 12] // <-- ADICIONAR ESTA LINHA PARA TRAZER SÓ ATACADO
    };

    let listaBase;
    try {
      listaBase = await this._consultarPerformanceComRetry(
        filtrosBase,
        'processarTodosClientesElegiveis'
      );
    } catch (err) {
      this.logger?.error?.(
        '[MovCarteira] Falha ao consultar base de performance para processamento em massa:',
        err && err.message ? err.message : err
      );
      throw err;
    }

    if (!listaBase || listaBase.length === 0) {
      this.logger?.log?.('[MovCarteira] Nenhum cliente encontrado para os filtros informados.');
      return;
    }

    // 2) Extrai CODCLI únicos da base retornada
    const codsUnicos = [];
    const vistos = new Set();

    for (const row of listaBase) {
      const codcli = row.CODCLI || row.codcli;
      if (!codcli || vistos.has(codcli)) continue;
      vistos.add(codcli);
      codsUnicos.push(codcli);
    }

    if (codsUnicos.length === 0) {
      this.logger?.log?.('[MovCarteira] Base de performance retornou dados, mas sem CODCLI válido.');
      return;
    }

    this.logger?.log?.(`[MovCarteira] Clientes elegíveis encontrados: ${codsUnicos.length}`);

    // 3) Processa cliente por cliente reaproveitando o fluxo atual (processarCliente)
    let processados = 0;
    for (const codcli of codsUnicos) {
      processados++;
      try {
        this.logger?.log?.(
          `[MovCarteira] >>> Processando cliente ${codcli} (${processados}/${codsUnicos.length})`
        );

        await this.processarCliente({
          competencia,
          CodFilial: filiais,
          ClienteCod: codcli,
          DataIni,
          DataFim
        });
      } catch (err) {
        this.logger?.error?.(
          `[MovCarteira] Erro ao processar cliente ${codcli}:`,
          err && err.message ? err.message : err
        );
        // Continua pros próximos, não derruba o lote inteiro
      }
    }

    this.logger?.log?.(
      '[MovCarteira] Processamento em massa concluído. Agora executando Etapa 5 (redistribuição)...'
    );

    // 4) Etapa 5 – Redistribuição na carteira rotativa
    try {
      await this.executarEtapa5Redistribuicao({ skipBitrix: skipBitrixEtapa5 });
      this.logger?.log?.(
        `[MovCarteira] Etapa 5 executada com sucesso após processamento em massa. Bitrix ${
          skipBitrixEtapa5 ? 'NÃO foi acionado (modo teste).' : 'foi acionado normalmente.'
        }`
      );
    } catch (err) {
      this.logger?.error?.(
        '[MovCarteira] Erro ao executar Etapa 5 após processamento em massa:',
        err && err.message ? err.message : err
      );
    }
  }

}



MovimentacaoCarteiraService.clearCache = function () {
  try {
    if (typeof PerformanceClientes?.clearCache === 'function') {
      PerformanceClientes.clearCache();
    }
  } catch (err) {
    console.error('[MovCarteira] Erro ao limpar cache de PerformanceClientes:', err);
  }
};

module.exports = MovimentacaoCarteiraService;

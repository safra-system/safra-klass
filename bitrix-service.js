const axios = require('axios');

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim().replace(/\/+$/, '');
  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

class BitrixService {
  constructor(logger) {
    this.logger = logger || console;

    this.baseUrlBase = requiredEnv('BITRIX_WEBHOOK_BASE_URL');
    this.baseUrlGet = requiredEnv('BITRIX_WEBHOOK_GET_URL');
    this.baseUrlUpdate = requiredEnv('BITRIX_WEBHOOK_UPDATE_URL');
    this.baseUrlDeals = requiredEnv('BITRIX_WEBHOOK_DEALS_URL');
  }

  _normalizeBitrixFieldName(fieldName) {
    const normalized = String(fieldName || '').trim().toUpperCase();
    if (!normalized || !/^[A-Z0-9_]+$/.test(normalized)) {
      throw new Error(`Campo Bitrix invalido: ${fieldName}`);
    }
    return normalized;
  }

  limparTelefone(texto) {
    if (!texto) return null;
    return texto.toString().replace(/\D/g, '');
  }

  async buscarContatoPorTelefones(dadosWinthor) {
    const telefonesParaBuscar = new Set();
    const campos = ['TELCOM', 'TELCELENT', 'TELCOB', 'TELENT'];

    campos.forEach((campo) => {
      const tel = this.limparTelefone(dadosWinthor[campo]);
      this._adicionarVariacoesTelefone(telefonesParaBuscar, tel);
    });

    if (dadosWinthor.OBS4) {
      const obs4Limpo = this.limparTelefone(dadosWinthor.OBS4);
      this._adicionarVariacoesTelefone(telefonesParaBuscar, obs4Limpo);
    }

    const listaBusca = Array.from(telefonesParaBuscar);
    if (listaBusca.length > 0) {
      this.logger.log(`[BitrixService] Tentando buscar pelos numeros: ${listaBusca.join(', ')}`);
    } else {
      this.logger.log('[BitrixService] Nenhum telefone valido encontrado no cadastro.');
      return null;
    }

    for (const telefone of telefonesParaBuscar) {
      try {
        const url = `${this.baseUrlGet}/crm.contact.list.json`;
        const response = await axios.get(url, {
          params: {
            FILTER: { PHONE: telefone },
            SELECT: ['ID', 'NAME', 'LAST_NAME']
          }
        });

        if (response.data && Array.isArray(response.data.result) && response.data.result.length > 0) {
          const idEncontrado = response.data.result[0].ID;
          this.logger.log(`[BitrixService] Contato encontrado: ID ${idEncontrado} usando o numero ${telefone}`);
          return idEncontrado;
        }
      } catch (err) {
        // Ignora erro individual e tenta o proximo numero.
      }
    }

    this.logger.log('[BitrixService] Nenhum contato encontrado no Bitrix apos tentar todas as variacoes.');
    return null;
  }

  _adicionarVariacoesTelefone(setDestino, numeroLimpo) {
    if (!numeroLimpo || numeroLimpo.length < 8) return;

    setDestino.add(numeroLimpo);

    let comDDI = numeroLimpo;
    if (numeroLimpo.length === 10 || numeroLimpo.length === 11) {
      if (!numeroLimpo.startsWith('55')) {
        comDDI = `55${numeroLimpo}`;
        setDestino.add(comDDI);
      }
    }

    if (comDDI.length >= 12 && comDDI.startsWith('55')) {
      setDestino.add(`+${comDDI}`);
    }
  }

  async atualizarContato(bitrixId, rcaAnterior, rcaNovo, targetBitrixUserId = null) {
    try {
      const dataRemanejamento = new Date().toISOString();
      const assignedById = targetBitrixUserId || 77810;

      return await this.atualizarContatoCampos(bitrixId, {
        UF_CRM_1763485853: dataRemanejamento,
        UF_CRM_1763486078: rcaAnterior,
        ASSIGNED_BY_ID: assignedById,
        UF_CRM_1677778590390: rcaNovo
      }, {
        contextLabel: `RCA ${rcaNovo} (BitrixUser: ${assignedById})`
      });
    } catch (err) {
      this.logger.error('[BitrixService] Erro ao atualizar contato:', err.message);
      throw err;
    }
  }

  async buscarContatosPorCampo(fieldName, fieldValue, { select = [] } = {}) {
    const normalizedField = this._normalizeBitrixFieldName(fieldName);
    const lookupValue = fieldValue == null ? '' : String(fieldValue).trim();
    if (!lookupValue) return [];

    const selectFields = Array.isArray(select) && select.length > 0
      ? Array.from(new Set(['ID', normalizedField, ...select]))
      : ['ID', normalizedField];

    try {
      const url = `${this.baseUrlGet}/crm.contact.list.json`;
      const response = await axios.get(url, {
        params: {
          FILTER: { [normalizedField]: lookupValue },
          SELECT: selectFields
        }
      });

      const contatos = Array.isArray(response.data?.result) ? response.data.result : [];
      this.logger.log(`[BitrixService] Busca por ${normalizedField}=${lookupValue}: ${contatos.length} contato(s) encontrado(s).`);
      return contatos;
    } catch (err) {
      const msg = err.response?.data?.error_description || err.message;
      this.logger.error(`[BitrixService] Erro ao buscar contato por ${normalizedField}: ${msg}`);
      throw err;
    }
  }

  async atualizarContatoCampos(bitrixId, fields, { contextLabel = null } = {}) {
    try {
      const url = `${this.baseUrlUpdate}/crm.contact.update.json`;
      const response = await axios.post(url, { id: bitrixId, fields });

      if (response.data && response.data.result) {
        const suffix = contextLabel ? ` -> ${contextLabel}` : '';
        this.logger.log(`[BitrixService] Sucesso ao atualizar contato ID ${bitrixId}${suffix}`);
        return true;
      }

      this.logger.error('[BitrixService] Falha na resposta do update:', response.data);
      return false;
    } catch (err) {
      const msg = err.response?.data?.error_description || err.message;
      this.logger.error(`[BitrixService] Erro ao atualizar contato ${bitrixId}: ${msg}`);
      throw err;
    }
  }

  async listarNegociosAtivos(contactId) {
    if (!contactId) return [];
    try {
      const now = new Date();
      const primeiroDiaMes = new Date(now.getFullYear(), now.getMonth(), 1);
      const dataFormatada = primeiroDiaMes.toISOString().split('T')[0];
      const url = `${this.baseUrlDeals}/crm.deal.list.json`;
      const body = {
        filter: { CONTACT_ID: contactId, '>=DATE_MODIFY': dataFormatada, CLOSED: 'N' },
        select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'DATE_MODIFY']
      };
      const response = await axios.post(url, body);
      if (response.data && response.data.result) return response.data.result;
      return [];
    } catch (error) {
      return [];
    }
  }

  async enviarRelatorioPdf(targetBitrixId, pdfBuffer, nomeArquivo) {
    try {
      this.logger.log(`[BitrixService] Fazendo upload do PDF (${nomeArquivo})...`);

      const fileBase64 = pdfBuffer.toString('base64');
      const folderId = await this._obterPastaParaUpload();
      if (!folderId) throw new Error('Pasta de upload nao encontrada no Bitrix.');

      const uploadUrl = `${this.baseUrlBase}/disk.folder.uploadfile.json`;
      const uploadBody = {
        id: folderId,
        data: { NAME: nomeArquivo },
        fileContent: fileBase64,
        generateUniqueName: true
      };

      const resUpload = await axios.post(uploadUrl, uploadBody);
      if (!resUpload.data || !resUpload.data.result || !resUpload.data.result.ID) {
        this.logger.error('[BitrixService] Resposta Upload:', resUpload.data);
        throw new Error('Falha no upload do arquivo para o Bitrix.');
      }

      const fileId = resUpload.data.result.ID;
      const downloadUrl = resUpload.data.result.DOWNLOAD_URL;

      this.logger.log(`[BitrixService] Enviando link do arquivo ID ${fileId} para User ${targetBitrixId}...`);

      const msgUrl = `${this.baseUrlBase}/im.message.add.json`;
      const msgPayload = {
        DIALOG_ID: targetBitrixId,
        MESSAGE:
          `Relatorio de Carteira [${new Date().toLocaleDateString()}]\n` +
          `[url=${downloadUrl}]Clique aqui para abrir o PDF[/url]`
      };

      const resMsg = await axios.post(msgUrl, msgPayload);
      if (resMsg.data && resMsg.data.result) {
        this.logger.log(`[BitrixService] Link enviado com sucesso para ID ${targetBitrixId}`);
        return true;
      }

      throw new Error('Falha ao enviar mensagem no chat.');
    } catch (err) {
      const msgErro = err.response?.data?.error_description || err.message;
      this.logger.error(`[BitrixService] Erro ao enviar PDF para ${targetBitrixId}: ${msgErro}`);
      return false;
    }
  }

  async _obterPastaParaUpload() {
    try {
      const url = `${this.baseUrlBase}/disk.storage.getlist.json`;
      const res = await axios.get(url);

      if (res.data && res.data.result && res.data.result.length > 0) {
        return res.data.result[0].ROOT_OBJECT_ID;
      }
      return null;
    } catch (err) {
      this.logger.error('[BitrixService] Erro ao buscar pasta de upload:', err.message);
      return null;
    }
  }
}

module.exports = BitrixService;

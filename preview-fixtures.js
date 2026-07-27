const previewUser = Object.freeze({
  logged: true,
  name: 'Usuario Preview',
  email: 'preview@local.invalid',
  photo: null,
  isAdmin: true,
  isConfig: true,
  isPainel: true,
  isExcel: true
});

const previewParameters = Object.freeze({
  dias_rotativa: 31,
  dias_longo_prazo: 60,
  dias_protecao_upgrade: 60,
  meses_sazonalidade_inicio: 10,
  meses_sazonalidade_fim: 3,
  fases_bitrix_bloqueio: [
    'C1:NEW',
    'EM_NEGOCIACAO',
    'COBRADO_ORCAMENTO',
    'UC_L7NUC2',
    'C4:FINAL_INVOICE'
  ],
  rcas_rotativa: [],
  filiais_cron: [1, 3, 5, 6],
  mapa_bitrix: {},
  rca_segmento_map: {},
  cron_config: {
    ativo: true,
    modo: 'CLASSIFICACAO',
    datetime: '',
    frequency: 'monthly'
  },
  winthor_fix_config: {
    ativo: false,
    intervalo_minutos: 15,
    sincronizar_bitrix: false
  },
  pdf_config: {
    ativo: false,
    modo_teste: true,
    id_tester: 0
  }
});

const previewUsers = Object.freeze([
  Object.freeze({
    id: 1,
    name: 'Colaborador Preview',
    email: 'colaborador@local.invalid',
    is_config: true,
    is_painel: true,
    is_excel: true
  })
]);

const previewDashboard = Object.freeze({
  visaoGeral: [],
  resumo: {
    movimentacoes_total: 0,
    longo_prazo_total: 0,
    reclassificacoes_total: 0,
    protecoes_total: 0,
    bitrix_total: 0,
    substituicoes_total: 0
  }
});

module.exports = {
  previewUser,
  previewParameters,
  previewUsers,
  previewDashboard
};

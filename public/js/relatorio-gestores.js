// ============================================================================
// relatorio-gestores.js - Safra Klass v3.1
// Toda a logica do Painel Gerencial (Tabs 1-10)
// ============================================================================

// ===========================
// MAPA DE NOMES DE RCAs
// ===========================
const RCA_MAP = {
    121: 'KARLA - ATACADO 1', 122: 'STEFANI - ATACADO 2', 123: 'WANDERLAN - ATACADO 3',
    124: 'HEBRON - ATACADO 4', 125: 'WESLEY - ATACADO 5', 126: 'THIAGO - ATACADO 6',
    127: 'ANGELICA - ATACADO 7', 128: 'GIULIAN - ATACADO 8', 10: 'MARIANA',
    110: 'GLAYCE', 118: 'CARTEIRA LONGO PRAZO'
};

const RCA_MAP_LOCAL = {
    121:'KARLA',122:'STEFANI',123:'WANDERLAN',124:'HEBRON',
    125:'WESLEY',126:'THIAGO',127:'ANGELICA',128:'GIULIAN',
    10:'MARIANA',110:'GLAYCE',118:'LONGO PRAZO'
};

const DASHBOARD_GESTOR_ENDPOINTS = {
    inicial: '/api/dashboard-gestor/inicial',
    paginado: '/api/dashboard-gestor/paginado',
    substituicoes: '/api/dashboard-gestor/substituicoes',
    protecaoManual: '/api/dashboard-gestor/protecoes/manual'
};

const TABS_PAGINADAS = {
    tab2: { apiTab: 'movimentacoes', pageSize: 50, counterId: 'counterTab2', tbodySelector: '#tableMovimentacoes tbody', colspan: 6, badgeId: 'badge-tab2' },
    tab3: { apiTab: 'longo_prazo', pageSize: 40, counterId: 'counterTab3', tbodySelector: '#tableLongoPrazo tbody', colspan: 5, badgeId: 'badge-tab3' },
    tab4: { apiTab: 'reclassificacoes', pageSize: 40, counterId: 'counterTab4', tbodySelector: '#tableReclassificacao tbody', colspan: 5, badgeId: 'badge-tab4' },
    tab5: { apiTab: 'protecoes', pageSize: 40, counterId: 'counterTab5', tbodySelector: '#tableProtecoes tbody', colspan: 5, badgeId: 'badge-tab5' },
    tab6: { apiTab: 'bitrix', pageSize: 40, counterId: 'counterTab6', tbodySelector: '#tableBitrix tbody', colspan: 4, badgeId: 'badge-tab6' }
};

const ESTADO_TABS_PAGINADAS = {};
Object.entries(TABS_PAGINADAS).forEach(([tabName, cfg]) => {
    ESTADO_TABS_PAGINADAS[tabName] = {
        loaded: false,
        loading: false,
        page: 1,
        pageSize: cfg.pageSize,
        total: 0,
        totalPages: 1,
        rows: [],
        reqId: 0,
        filtros: {}
    };
});

const TIMER_FILTROS_TABS = {};
let _dashboardGestorInicial = { visaoGeral: [], resumo: {} };
let _tab8Carregada = false;


// ===========================
// INICIALIZACAO (DOMContentLoaded)
// ===========================
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    initDataAtual();
    initCompCustomSelects();
    syncCompCustomSelects();

    try {
        document.getElementById('loader').style.display = 'block';
        document.getElementById('mainContent').style.display = 'none';

        const response = await fetch(DASHBOARD_GESTOR_ENDPOINTS.inicial);
        if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);

        const data = await response.json();
        _dashboardGestorInicial = data || { visaoGeral: [], resumo: {} };

        renderTabs(data);

        document.getElementById('loader').style.display = 'none';
        document.getElementById('mainContent').style.display = 'block';
    } catch (error) {
        console.error(error);
        document.getElementById('loader').innerHTML =
            `<span style="color:var(--danger)">Erro ao carregar dados: ${error.message}</span>`;
    }

    // Listeners
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    const excelBtn = document.getElementById('btnExportExcel');
    if (excelBtn) excelBtn.addEventListener('click', exportarExcel);

    initProtecaoManualForm();
    inicializarContadores();
    atualizarBadges();
});


// ===========================
// DATA ATUAL NO BANNER
// ===========================
function initDataAtual() {
    const el = document.getElementById('dataAtual');
    if (el) {
        el.innerHTML = `<i class="fas fa-clock"></i> ${new Date().toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        })}`;
    }
}


// ===========================
// LOGICA DE TEMA
// ===========================
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const theme = savedTheme === 'light' ? 'light' : 'default';
    if (savedTheme === 'dark') localStorage.setItem('theme', 'default');
    const resolvedTheme = theme === 'light' ? 'light' : 'dark';
    document.body.classList.remove('dark', 'light');
    document.body.classList.add(resolvedTheme);
    document.body.dataset.theme = resolvedTheme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    updateThemeIcon();
}

function toggleTheme() {
    const isLight = document.body.classList.contains('light');
    const nextTheme = !isLight ? 'light' : 'default';
    const resolvedTheme = nextTheme === 'light' ? 'light' : 'dark';
    document.body.classList.remove('dark', 'light');
    document.body.classList.add(resolvedTheme);
    document.body.dataset.theme = resolvedTheme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    localStorage.setItem('theme', nextTheme);
    updateThemeIcon();
}

function updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.innerHTML = document.body.classList.contains('light')
        ? '<i class="fas fa-moon"></i>'
        : '<i class="fas fa-sun"></i>';
}


// ===========================
// LOGICA DE ABAS
// ===========================
function openTab(tabName) {
    requestAnimationFrame(() => {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

        const content = document.getElementById(tabName);
        if (content) content.classList.add('active');

        document.querySelectorAll('.tab-btn').forEach(btn => {
            if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(tabName)) {
                btn.classList.add('active');
            }
        });
    });

    if (TABS_PAGINADAS[tabName]) {
        garantirCargaTabPaginada(tabName);
    }

    if (tabName === 'tab8') {
        carregarSubstituicoesSobDemanda();
    }

    if (tabName === 'tab10') {
        initCompCustomSelects();
        syncCompCustomSelects();
        carregarLogsCorrecaoCadastro();
    }
}


// ===========================
// RENDER DE TODAS AS TABS
// ===========================
function renderTabs(data) {
    const visaoGeral = Array.isArray(data?.visaoGeral) ? data.visaoGeral : [];
    renderVisaoGeral(visaoGeral);
    renderPerformance(data || {});
    inicializarPaginasTabsPaginadas();

    const resumo = data?.resumo || {};
    atualizarBadgeComValor('badge-tab1', visaoGeral.length);
    atualizarBadgeComValor('badge-tab2', Number(resumo.movimentacoes_total || 0));
    atualizarBadgeComValor('badge-tab3', Number(resumo.longo_prazo_total || 0));
    atualizarBadgeComValor('badge-tab4', Number(resumo.reclassificacoes_total || 0));
    atualizarBadgeComValor('badge-tab5', Number(resumo.protecoes_total || 0));
    atualizarBadgeComValor('badge-tab6', Number(resumo.bitrix_total || 0));
    atualizarBadgeComValor('badge-tab8', Number(resumo.substituicoes_total || 0));
}

function atualizarBadgeComValor(badgeId, valor) {
    const badge = document.getElementById(badgeId);
    if (!badge) return;
    badge.textContent = Number(valor || 0).toLocaleString('pt-BR');
}

function renderMensagemTabelaTab(tabName, mensagem, tipo = 'empty') {
    const cfg = TABS_PAGINADAS[tabName];
    if (!cfg) return;
    const tbody = document.querySelector(cfg.tbodySelector);
    if (!tbody) return;

    const icon = tipo === 'loading' ? 'fa-spinner fa-spin' : 'fa-inbox';
    tbody.innerHTML = `
        <tr>
            <td colspan="${cfg.colspan}" class="comp-empty">
                <i class="fas ${icon}"></i>
                ${mensagem}
            </td>
        </tr>
    `;
}

function inicializarPaginasTabsPaginadas() {
    Object.keys(TABS_PAGINADAS).forEach((tabName) => {
        renderMensagemTabelaTab(tabName, 'Abra a aba para carregar os dados.', 'empty');
        atualizarPaginacaoTabPaginada(tabName);
        const cfg = TABS_PAGINADAS[tabName];
        const counter = document.getElementById(cfg.counterId);
        if (counter) {
            counter.textContent = 'Carregamento sob demanda';
            counter.classList.remove('has-filter');
        }
    });
}

function atualizarContadorTabPaginada(tabName) {
    const cfg = TABS_PAGINADAS[tabName];
    const estado = ESTADO_TABS_PAGINADAS[tabName];
    if (!cfg || !estado) return;

    const counter = document.getElementById(cfg.counterId);
    if (!counter) return;

    const filtroAtivo = !!(
        estado.filtros?.texto ||
        (Array.isArray(estado.filtros?.codigos) && estado.filtros.codigos.length) ||
        estado.filtros?.origem
    );

    if (!estado.loaded) {
        counter.textContent = 'Carregamento sob demanda';
        counter.classList.remove('has-filter');
        return;
    }

    if (!estado.total) {
        counter.textContent = filtroAtivo ? 'Nenhum registro encontrado' : '0 registro(s)';
        counter.classList.toggle('has-filter', filtroAtivo);
        return;
    }

    counter.textContent = filtroAtivo
        ? `${estado.total.toLocaleString('pt-BR')} encontrado(s)`
        : `${estado.total.toLocaleString('pt-BR')} registro(s)`;
    counter.classList.toggle('has-filter', filtroAtivo);
}

function atualizarPaginacaoTabPaginada(tabName) {
    const estado = ESTADO_TABS_PAGINADAS[tabName];
    if (!estado) return;

    const info = document.getElementById(`${tabName}PagInfo`);
    const prev = document.getElementById(`${tabName}BtnAnterior`);
    const next = document.getElementById(`${tabName}BtnProximo`);
    if (!info || !prev || !next) return;

    if (!estado.loaded || estado.total === 0) {
        info.textContent = '0 de 0';
        prev.disabled = true;
        next.disabled = true;
        return;
    }

    const inicio = ((estado.page - 1) * estado.pageSize) + 1;
    const fim = Math.min(inicio + (estado.rows.length || 0) - 1, estado.total);
    info.textContent = `${inicio}-${fim} de ${estado.total.toLocaleString('pt-BR')}`;
    prev.disabled = estado.page <= 1;
    next.disabled = estado.page >= estado.totalPages;
}

function obterFiltrosTabPaginada(tabName) {
    if (tabName === 'tab2') {
        const filtroRaw = document.getElementById('filtroTab2')?.value || '';
        const parsed = parseFiltroCodigos(filtroRaw);
        return {
            texto: parsed.modoCodigos ? '' : parsed.texto,
            codigos: parsed.modoCodigos ? parsed.codigos : [],
            origem: document.getElementById('filtroOrigemTab2')?.value || ''
        };
    }

    const mapaInput = {
        tab3: 'filtroTab3',
        tab4: 'filtroTab4',
        tab5: 'filtroTab5',
        tab6: 'filtroTab6'
    };
    const inputId = mapaInput[tabName];
    const filtroRaw = inputId ? (document.getElementById(inputId)?.value || '') : '';
    const parsed = parseFiltroCodigos(filtroRaw);
    return {
        texto: parsed.modoCodigos ? '' : parsed.texto,
        codigos: parsed.modoCodigos ? parsed.codigos : [],
        origem: ''
    };
}

function agendarCargaTabPaginada(tabName, { resetPage = true, delay = 260 } = {}) {
    if (!TABS_PAGINADAS[tabName]) return;
    clearTimeout(TIMER_FILTROS_TABS[tabName]);
    TIMER_FILTROS_TABS[tabName] = setTimeout(() => {
        carregarTabPaginada(tabName, { resetPage });
    }, delay);
}

function garantirCargaTabPaginada(tabName) {
    const estado = ESTADO_TABS_PAGINADAS[tabName];
    if (!estado || estado.loaded || estado.loading) return;
    carregarTabPaginada(tabName, { resetPage: true });
}

async function carregarTabPaginada(tabName, { resetPage = false } = {}) {
    const cfg = TABS_PAGINADAS[tabName];
    const estado = ESTADO_TABS_PAGINADAS[tabName];
    if (!cfg || !estado) return;

    if (resetPage) estado.page = 1;
    estado.filtros = obterFiltrosTabPaginada(tabName);

    const reqIdAtual = ++estado.reqId;
    estado.loading = true;
    renderMensagemTabelaTab(tabName, 'Carregando dados...', 'loading');
    atualizarPaginacaoTabPaginada(tabName);

    try {
        const params = new URLSearchParams({
            tab: cfg.apiTab,
            page: String(estado.page),
            pageSize: String(estado.pageSize)
        });

        if (estado.filtros.texto) params.set('texto', estado.filtros.texto);
        if (Array.isArray(estado.filtros.codigos) && estado.filtros.codigos.length) {
            params.set('codigos', estado.filtros.codigos.join(','));
        }
        if (estado.filtros.origem) params.set('origem', estado.filtros.origem);

        const resp = await fetch(`${DASHBOARD_GESTOR_ENDPOINTS.paginado}?${params.toString()}`);
        if (!resp.ok) throw new Error(`Erro HTTP: ${resp.status}`);
        const payload = await resp.json();

        if (reqIdAtual !== estado.reqId) return;

        estado.loaded = true;
        estado.page = Number(payload.page || 1);
        estado.pageSize = Number(payload.pageSize || estado.pageSize);
        estado.total = Number(payload.total || 0);
        estado.totalPages = Number(payload.totalPages || 1);
        estado.rows = Array.isArray(payload.rows) ? payload.rows : [];

        if (!estado.rows.length) {
            renderMensagemTabelaTab(tabName, 'Nenhum registro encontrado para os filtros aplicados.');
        } else if (tabName === 'tab2') {
            renderMovimentacoes(estado.rows);
        } else if (tabName === 'tab3') {
            renderLongoPrazo(estado.rows);
        } else if (tabName === 'tab4') {
            renderReclassificacoes(estado.rows);
        } else if (tabName === 'tab5') {
            renderProtecoes(estado.rows);
        } else if (tabName === 'tab6') {
            renderBitrix(estado.rows);
        }

        atualizarBadgeComValor(cfg.badgeId, estado.total);
        atualizarContadorTabPaginada(tabName);
        atualizarPaginacaoTabPaginada(tabName);
    } catch (err) {
        if (reqIdAtual !== estado.reqId) return;
        renderMensagemTabelaTab(tabName, `Erro ao carregar dados: ${err.message}`);
        estado.loaded = false;
    } finally {
        if (reqIdAtual === estado.reqId) {
            estado.loading = false;
        }
    }
}

function mudaPaginaTab(tabName, delta) {
    const estado = ESTADO_TABS_PAGINADAS[tabName];
    if (!estado || !estado.loaded) return;
    const novaPagina = Math.max(1, Math.min(estado.totalPages, estado.page + Number(delta || 0)));
    if (novaPagina === estado.page) return;
    estado.page = novaPagina;
    carregarTabPaginada(tabName, { resetPage: false });
}

async function carregarSubstituicoesSobDemanda() {
    if (_tab8Carregada) return;
    _tab8Carregada = true;

    try {
        const resp = await fetch(`${DASHBOARD_GESTOR_ENDPOINTS.substituicoes}?limit=2000`);
        if (!resp.ok) throw new Error(`Erro HTTP: ${resp.status}`);
        const payload = await resp.json();
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        renderSubstituicoes(rows);
        atualizarBadgeComValor('badge-tab8', Number(payload?.total || rows.length || 0));
    } catch (err) {
        console.error('[Gestores] Erro ao carregar substituicoes:', err);
        _tab8Carregada = false;
        const tbody = document.getElementById('tbodySubstituicoes');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="comp-empty"><i class="fas fa-exclamation-triangle"></i> Erro ao carregar substituições: ${err.message}</td></tr>`;
        }
    }
}


// ===========================
// TAB 1 - VISAO GERAL
// ===========================
function renderVisaoGeral(lista) {
    const tbody = document.querySelector('#tableVisaoGeral tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    lista.forEach(item => {
        const totalClientes = Number(item.total_clientes || 0);
        const ativos = Number(item.ativos || 0);
        const alertas = Number(item.alertas || 0);
        const risco = Number(item.risco || 0);
        const rcaCodigo = Number(item.rca_codigo || 0);
        const nome = item.rca_nome || RCA_MAP[rcaCodigo] || `RCA ${rcaCodigo}`;
        const ocupacao = Math.round((totalClientes / 250) * 100);
        const corBarra = ocupacao > 95 ? '#ef4444' : '#10b981';

        tbody.innerHTML += `
            <tr class="row-clickable"
                onclick="window.location.href='/detalhes-rca?rca=${rcaCodigo}&nome=${encodeURIComponent(nome)}'">
                <td><strong>${rcaCodigo}</strong></td>
                <td>${nome}</td>
                <td>${totalClientes} / 250</td>
                <td>
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill" style="background:${corBarra}; width:${Math.min(ocupacao, 100)}%;"></div>
                    </div>
                    <span style="font-size:0.85rem; font-weight:600">${ocupacao}%</span>
                </td>
                <td><span class="badge bg-green">${ativos}</span></td>
                <td><span class="badge bg-yellow">${alertas}</span></td>
                <td><span class="badge bg-red">${risco}</span></td>
            </tr>
        `;
    });
}


// ===========================
// TAB 2 - MOVIMENTACOES
// ===========================
function renderMovimentacoes(lista) {
    if (!lista) return;
    const tbody = document.querySelector('#tableMovimentacoes tbody');
    const listaRender = lista.length > 2000 ? lista.slice(0, 2000) : lista;

    tbody.innerHTML = listaRender.map(item => {
        const dataFmt = new Date(item.data_remanejamento).toLocaleDateString('pt-BR');
        return `
            <tr data-codcli="${Number(item.codcli) || ''}">
                <td>${dataFmt}</td>
                <td><strong>${item.codcli}</strong> - ${item.cliente}</td>
                <td>${item.rca_anterior}</td>
                <td>${item.rca_novo}</td>
                <td>${item.origem}</td>
                <td>${item.dias_sem_compra || '-'}</td>
            </tr>
        `;
    }).join('');
}


// ===========================
// TAB 3 - LONGO PRAZO
// ===========================
function renderLongoPrazo(lista) {
    if (!lista) return;
    const tbody = document.querySelector('#tableLongoPrazo tbody');
    const lp = lista.filter(i => i.rca_novo == 118);

    tbody.innerHTML = lp.map(item => {
        const dataFmt = new Date(item.data_remanejamento).toLocaleDateString('pt-BR');
        let valor = '-';
        if (item.payload && item.payload.historicoFaturamento && item.payload.historicoFaturamento.length) {
            valor = `R$ ${item.payload.historicoFaturamento[0].vlLiquido.toFixed(2)}`;
        }
        return `
            <tr>
                <td><strong>${item.codcli}</strong> - ${item.cliente}</td>
                <td>${item.rca_anterior}</td>
                <td>${dataFmt}</td>
                <td>${item.dias_sem_compra}</td>
                <td>${valor}</td>
            </tr>
        `;
    }).join('');
}


// ===========================
// TAB 4 - RECLASSIFICACOES
// ===========================
function renderReclassificacoes(lista) {
    if (!lista) return;
    const tbody = document.querySelector('#tableReclassificacao tbody');

    tbody.innerHTML = lista.map(item => {
        const dataFmt = new Date(item.data_upgrade).toLocaleDateString('pt-BR');
        return `
            <tr>
                <td>${dataFmt}</td>
                <td><strong>${item.codcli}</strong> - ${item.cliente}</td>
                <td>${item.classificacao_anterior}</td>
                <td><span class="badge bg-blue">${item.classificacao_nova}</span></td>
                <td>Upgrade</td>
            </tr>
        `;
    }).join('');
}


// ===========================
// TAB 5 - PROTECOES
// ===========================
function renderProtecoes(lista) {
    if (!lista) return;
    const tbody = document.querySelector('#tableProtecoes tbody');
    const protegidos = lista.filter(i => i.dias_restantes > 0);

    tbody.innerHTML = protegidos.map(item => {
        const dataUp = new Date(item.data_upgrade).toLocaleDateString('pt-BR');
        const dataFim = new Date(item.data_fim_protecao).toLocaleDateString('pt-BR');
        const diasRestantes = Math.max(1, Math.ceil(Number(item.dias_restantes || 0)));
        const origem = String(item.origem_protecao || 'UPGRADE').toUpperCase();
        const badgeNivel = origem === 'MANUAL'
            ? '<span class="badge bg-yellow">MANUAL</span>'
            : `<span class="badge bg-green">${item.classificacao_nova}</span>`;
        const badgeOrigem = origem === 'MANUAL'
            ? '<span class="badge bg-yellow protecao-origem-tag">Manual</span>'
            : '<span class="badge bg-green protecao-origem-tag">Upgrade</span>';

        return `
            <tr>
                <td><strong>${item.codcli}</strong> - ${item.cliente} ${badgeOrigem}</td>
                <td>${badgeNivel}</td>
                <td>${dataUp}</td>
                <td>${dataFim}</td>
                <td style="color:var(--primary); font-weight:700">${diasRestantes} dias</td>
            </tr>
        `;
    }).join('');
}

function initProtecaoManualForm() {
    const form = document.getElementById('manualProtecaoForm');
    if (!form || form.dataset.bound === 'true') return;

    form.dataset.bound = 'true';
    form.addEventListener('submit', salvarProtecaoManual);
}

function setProtecaoManualStatus(mensagem, tipo = '') {
    const status = document.getElementById('manualProtecaoStatus');
    if (!status) return;

    status.textContent = mensagem || '';
    status.classList.remove('success', 'error');
    if (tipo) status.classList.add(tipo);
}

async function salvarProtecaoManual(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const inputCodcli = document.getElementById('manualProtecaoCodcli');
    const inputDias = document.getElementById('manualProtecaoDias');
    const button = document.getElementById('btnSalvarProtecaoManual');
    const codcli = Number(inputCodcli?.value);
    const diasProtecao = Number(inputDias?.value);

    if (!Number.isInteger(codcli) || codcli <= 0) {
        setProtecaoManualStatus('Informe um código de cliente válido.', 'error');
        inputCodcli?.focus();
        return;
    }

    if (!Number.isInteger(diasProtecao) || diasProtecao <= 0) {
        setProtecaoManualStatus('Informe a quantidade de dias da proteção.', 'error');
        inputDias?.focus();
        return;
    }

    try {
        if (button) button.disabled = true;
        setProtecaoManualStatus('Gravando proteção manual...');

        const resp = await fetch(DASHBOARD_GESTOR_ENDPOINTS.protecaoManual, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ codcli, diasProtecao })
        });

        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(payload.error || `Erro HTTP: ${resp.status}`);
        }

        setProtecaoManualStatus(payload.message || 'Proteção manual gravada com sucesso.', 'success');
        form.reset();
        await carregarTabPaginada('tab5', { resetPage: true });
    } catch (error) {
        console.error('[Gestores] Erro ao gravar protecao manual:', error);
        setProtecaoManualStatus(error.message || 'Erro ao gravar proteção manual.', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}


// ===========================
// TAB 6 - BITRIX
// ===========================
function renderBitrix(lista) {
    if (!lista) return;
    const tbody = document.querySelector('#tableBitrix tbody');

    tbody.innerHTML = lista.map(item => `
        <tr>
            <td>${item.rca_codigo}</td>
            <td><strong>${item.codcli}</strong> - ${item.cliente}</td>
            <td><span class="badge bg-yellow">${item.motivo_bloqueio}</span></td>
            <td>${item.dias_sem_compra}</td>
        </tr>
    `).join('');
}


// ===========================
// TAB 7 - PERFORMANCE (KPIs)
// ===========================
function renderPerformance(data) {
    if (!data.visaoGeral) return;
    const tbody = document.querySelector('#tablePerformance tbody');
    const resumo = data?.resumo || {};

    const totalVagas = 2500;
    const totalClientes = data.visaoGeral.reduce((acc, i) => acc + parseInt(i.total_clientes || 0), 0);
    const taxaOcupacao = ((totalClientes / totalVagas) * 100).toFixed(1);
    const totalRisco = data.visaoGeral.reduce((acc, i) => acc + parseInt(i.risco || 0), 0);
    const totalUpgrades = Number(resumo.reclassificacoes_total || (data.upgrades ? data.upgrades.length : 0) || 0);

    const kpis = [
        { nome: 'Taxa de Ocupacao Global', valor: `${taxaOcupacao}%`, meta: '95%', status: taxaOcupacao > 95 ? '<span class="badge bg-green">OK</span>' : '<span class="badge bg-yellow">Atencao</span>' },
        { nome: 'Clientes em Risco (>60d)', valor: totalRisco, meta: '< 100', status: totalRisco < 100 ? '<span class="badge bg-green">OK</span>' : '<span class="badge bg-red">Critico</span>' },
        { nome: 'Upgrades no Periodo', valor: totalUpgrades, meta: '-', status: '<span class="badge bg-blue">Info</span>' }
    ];

    tbody.innerHTML = kpis.map(kpi => `
        <tr>
            <td>${kpi.nome}</td>
            <td style="font-size:1.1rem; font-weight:700">${kpi.valor}</td>
            <td>${kpi.meta}</td>
            <td>${kpi.status}</td>
        </tr>
    `).join('');
}


// ===========================
// TAB 8 - SUBSTITUICOES
// ===========================
let _todosSubstituicoes = [];
let _substituicoesFiltrosBound = false;

function renderSubstituicoes(lista) {
    _todosSubstituicoes = lista || [];

    _renderSubstituicoesResumo(_todosSubstituicoes);
    _renderSubstituicoesTabela(_todosSubstituicoes);

    if (!_substituicoesFiltrosBound) {
        document.getElementById('filtroSubstituicao').addEventListener('input', _aplicarFiltrosSub);
        document.getElementById('filtroTipoSub').addEventListener('change', _aplicarFiltrosSub);
        document.getElementById('filtroDataInicioSub').addEventListener('change', _aplicarFiltrosSub);
        document.getElementById('filtroDataFimSub').addEventListener('change', _aplicarFiltrosSub);
        _substituicoesFiltrosBound = true;
    }
}

function _aplicarFiltrosSub() {
    const texto = document.getElementById('filtroSubstituicao').value.toLowerCase().trim();
    const tipo = document.getElementById('filtroTipoSub').value;
    const dataInicioStr = document.getElementById('filtroDataInicioSub').value;
    const dataFimStr = document.getElementById('filtroDataFimSub').value;

    let filtrada = _todosSubstituicoes;

    // 1. Filtro de Intervalo de Data
    if (dataInicioStr || dataFimStr) {
        filtrada = filtrada.filter(r => {
            if (!r.data_remanejamento) return false;
            const dataRegistro = new Date(r.data_remanejamento);
            dataRegistro.setHours(0, 0, 0, 0);

            let passaInicio = true;
            let passaFim = true;

            if (dataInicioStr) {
                const [ano, mes, dia] = dataInicioStr.split('-');
                const dInicio = new Date(ano, mes - 1, dia);
                dInicio.setHours(0, 0, 0, 0);
                passaInicio = dataRegistro >= dInicio;
            }

            if (dataFimStr) {
                const [ano, mes, dia] = dataFimStr.split('-');
                const dFim = new Date(ano, mes - 1, dia);
                dFim.setHours(0, 0, 0, 0);
                passaFim = dataRegistro <= dFim;
            }

            return passaInicio && passaFim;
        });
    }

    // 2. Filtro de Texto
    if (texto) {
        filtrada = filtrada.filter(r =>
            String(r.codcli).includes(texto) ||
            (r.cliente || '').toLowerCase().includes(texto)
        );
    }

    // 3. Filtro de Tipo
    if (tipo === '118') {
        filtrada = filtrada.filter(r => r.rca_novo == 118);
    } else if (tipo === 'SUBSTITUICAO_MANUAL') {
        filtrada = filtrada.filter(r => r.origem === 'SUBSTITUICAO_MANUAL');
    }

    _renderSubstituicoesTabela(filtrada);
    _renderSubstituicoesResumo(filtrada);
}

function _renderSubstituicoesResumo(lista) {
    const total = lista.length;
    const para118 = lista.filter(r => r.rca_novo == 118).length;
    const entradas = lista.filter(r => r.rca_anterior == null || r.rca_anterior == 118).length;
    const saidas = lista.filter(r => r.rca_novo == 118 && r.rca_anterior != 118).length;
    const diasUnicos = new Set(lista.map(r => new Date(r.data_remanejamento).toLocaleDateString('pt-BR'))).size;

    document.getElementById('subResumo').innerHTML = `
        <div class="sub-card">
            <span class="sub-card-label">Total de Operacoes</span>
            <span class="sub-card-value primary">${total}</span>
        </div>
        <div class="sub-card">
            <span class="sub-card-label">Enviados ao RCA 118</span>
            <span class="sub-card-value danger">${para118}</span>
        </div>
        <div class="sub-card">
            <span class="sub-card-label">Adicionados a RCAs</span>
            <span class="sub-card-value success">${entradas}</span>
        </div>
        <div class="sub-card">
            <span class="sub-card-label">Saidas de Carteira</span>
            <span class="sub-card-value warning">${saidas}</span>
        </div>
        <div class="sub-card">
            <span class="sub-card-label">Dias com Atividade</span>
            <span class="sub-card-value">${diasUnicos}</span>
        </div>
    `;
}

function _renderSubstituicoesTabela(lista) {
    const tbody = document.getElementById('tbodySubstituicoes');
    const count = document.getElementById('subCount');

    if (!lista || lista.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="comp-empty">
            <i class="fas fa-inbox"></i>
            Nenhum registro de substituicao encontrado.
        </td></tr>`;
        count.textContent = '';
        return;
    }

    tbody.innerHTML = lista.map(item => {
        const dataFmt = new Date(item.data_remanejamento).toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        const rcaOrigemNome = item.rca_anterior != null
            ? `${item.rca_anterior} <small class="text-muted">${RCA_MAP[item.rca_anterior] || ''}</small>`
            : '<span class="text-muted">-</span>';

        const rcaDestinoNome = `${item.rca_novo} <small class="text-muted">${RCA_MAP[item.rca_novo] || ''}</small>`;

        let badgeClass, badgeTxt;
        if (item.rca_novo == 118) {
            badgeClass = 'badge badge-sub-118';
            badgeTxt = '<i class="fas fa-arrow-right"></i> Para 118';
        } else if (item.rca_anterior == null || item.rca_anterior == 118) {
            badgeClass = 'badge badge-sub-adicao';
            badgeTxt = '<i class="fas fa-plus"></i> Adicao';
        } else {
            badgeClass = 'badge badge-sub-remocao';
            badgeTxt = '<i class="fas fa-exchange-alt"></i> Substituição';
        }

        const dias = item.dias_sem_compra != null ? item.dias_sem_compra : '-';
        let diasClass = '';
        if (item.dias_sem_compra >= 60) diasClass = 'danger-text';
        else if (item.dias_sem_compra >= 30) diasClass = 'warning-text';

        return `
            <tr>
                <td class="text-nowrap text-muted text-sm">${dataFmt}</td>
                <td><strong>${item.codcli}</strong></td>
                <td>${item.cliente || '-'}</td>
                <td>${rcaOrigemNome}</td>
                <td>${rcaDestinoNome}</td>
                <td><span class="${badgeClass}">${badgeTxt}</span></td>
                <td class="${diasClass}">${dias}</td>
            </tr>
        `;
    }).join('');

    count.textContent = `Exibindo ${lista.length} registro(s)`;
}


// ============================================================================
// TAB 9 - COMPARACAO SISTEMA vs WINTHOR
// ============================================================================

let _compDados = [];
let _compFiltrados = [];
let _compPagAtual = 1;
const COMP_PAG_TAM = 100;
let _compCarregado = false;
let _compResumoRca = [];
let _compResumoRcaVisivel = [];
let _compRcaBuscaTexto = '';
let _compRcaSomenteDivergencia = false;
let _compCustomSelectsBound = false;
let _compFixPayload = null;
let _compFixLogsBase = [];

function nomeRca(cod) {
    if (!cod) return '-';
    if (typeof RCA_MAP !== 'undefined' && RCA_MAP[cod]) return `${cod} - ${RCA_MAP[cod]}`;
    if (RCA_MAP_LOCAL[cod]) return `${cod} - ${RCA_MAP_LOCAL[cod]}`;
    return `RCA ${cod}`;
}

function abrirComparacao() {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const btn = [...document.querySelectorAll('.tab-btn')].find(
        b => b.getAttribute('onclick') === 'abrirComparacao()'
    );
    if (btn) btn.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById('tab9').classList.add('active');

    if (!_compCarregado) carregarComparacao();
}

async function recarregarComparacao() {
    _compCarregado = false;
    document.getElementById('compConteudo').style.display = 'none';
    document.getElementById('compErro').style.display = 'none';
    document.getElementById('compLoader').style.display = 'block';
    carregarComparacao();
}

function escHtmlCompFix(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtDataHoraCompFix(valor) {
    if (!valor) return '-';
    const dt = new Date(valor);
    if (Number.isNaN(dt.getTime())) return String(valor);
    return dt.toLocaleString('pt-BR');
}

function normalizarCompFixTexto(valor) {
    const texto = String(valor ?? '');
    const semAcento = typeof texto.normalize === 'function'
        ? texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        : texto;
    return semAcento.toLowerCase().trim();
}

function tsCompFix(valor) {
    const ms = new Date(valor || 0).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function limiteDataCompFix(dataIso, fimDoDia = false) {
    const txt = String(dataIso || '').trim();
    if (!txt) return null;
    const sufixo = fimDoDia ? 'T23:59:59.999' : 'T00:00:00.000';
    const ms = new Date(`${txt}${sufixo}`).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function obterCamposAlteradosCompFix(row) {
    const mudouCategoria = String(row?.categoria_ant ?? '') !== String(row?.categoria_nova ?? '');
    const mudouAtv = String(row?.codatv1_ant ?? '') !== String(row?.codatv1_novo ?? '');
    const mudouRede = String(row?.codrede_ant ?? '') !== String(row?.codrede_novo ?? '');

    const campos = [];
    if (mudouCategoria) {
        campos.push({ key: 'categoria', label: 'CATEGORIA', de: row?.categoria_ant, para: row?.categoria_nova });
    }
    if (mudouAtv) {
        campos.push({ key: 'codatv1', label: 'CODATV1', de: row?.codatv1_ant, para: row?.codatv1_novo });
    }
    if (mudouRede) {
        campos.push({ key: 'codrede', label: 'CODREDE', de: row?.codrede_ant, para: row?.codrede_novo });
    }
    return campos;
}

function ambienteCompFixClass(valor) {
    const amb = normalizarCompFixTexto(valor);
    if (!amb) return 'is-default';
    if (amb.includes('test')) return 'is-teste';
    if (amb.includes('prod')) return 'is-producao';
    return 'is-default';
}

function obterBitrixSyncCompFix(row) {
    const info = row?.payload?.bitrix_sync;
    if (!info || typeof info !== 'object') return null;

    return {
        status: String(info.status || '').trim().toUpperCase() || 'SEM_INFO',
        lookup_field: info.lookup_field || null,
        target_field: info.target_field || null,
        valor_destino: info.valor_destino || null,
        encontrados: Number(info.encontrados || 0),
        atualizados: Number(info.atualizados || 0),
        ja_alinhados: Number(info.ja_alinhados || 0),
        erros: Number(info.erros || 0),
        erro: info.erro || null,
        detalhes: Array.isArray(info.detalhes) ? info.detalhes : []
    };
}

function metaBitrixSyncCompFix(row) {
    const info = obterBitrixSyncCompFix(row);
    if (!info) return null;

    const mapaStatus = {
        ATUALIZADO: { label: 'Bitrix atualizado', className: 'tag-bitrix-atualizado' },
        JA_ALINHADO: { label: 'Bitrix já alinhado', className: 'tag-bitrix-alinhado' },
        NAO_ENCONTRADO: { label: 'Bitrix não encontrado', className: 'tag-bitrix-nao-encontrado' },
        ERRO: { label: 'Bitrix com erro', className: 'tag-bitrix-erro' },
        PARCIAL: { label: 'Bitrix parcial', className: 'tag-bitrix-parcial' },
        SEM_ACAO: { label: 'Bitrix sem ação', className: 'tag-bitrix-sem-acao' }
    };

    const statusMeta = mapaStatus[info.status] || { label: `Bitrix ${info.status || 'sem info'}`, className: 'tag-bitrix-sem-acao' };
    const resumo = [
        `${info.atualizados} atualizados`,
        `${info.ja_alinhados} alinhados`,
        `${info.encontrados} encontrados`,
        info.erros ? `${info.erros} erros` : ''
    ].filter(Boolean).join(' | ');

    const detalhes = info.detalhes.slice(0, 6).map((item) => {
        const id = item?.bitrix_id != null ? `ID ${item.bitrix_id}` : 'ID ?';
        const nome = item?.nome ? ` ${item.nome}` : '';
        const status = String(item?.status || '').trim().toUpperCase() || 'SEM_STATUS';
        const diff = (item?.valor_anterior != null || item?.valor_novo != null)
            ? ` (${item?.valor_anterior ?? '-'} -> ${item?.valor_novo ?? '-'})`
            : '';
        const erro = item?.erro ? ` [${item.erro}]` : '';
        return `${id}${nome}: ${status}${diff}${erro}`;
    });

    const titulo = [
        statusMeta.label,
        info.valor_destino ? `Destino: ${info.valor_destino}` : '',
        resumo,
        info.erro ? `Erro: ${info.erro}` : '',
        ...detalhes
    ].filter(Boolean).join(' | ');

    return {
        ...info,
        label: statusMeta.label,
        className: statusMeta.className,
        resumo,
        titulo
    };
}

function atualizarContadorLogsCorrecaoCadastro(exibidos, total) {
    const counter = document.getElementById('compFixCounter');
    if (!counter) return;

    counter.textContent = `${Number(exibidos || 0)} de ${Number(total || 0)} logs`;

    const texto = normalizarCompFixTexto(document.getElementById('compFixFiltroTexto')?.value || '');
    const campo = String(document.getElementById('compFixFiltroCampo')?.value || '').trim();
    const ambiente = String(document.getElementById('compFixFiltroAmbiente')?.value || '').trim();
    const dataIni = String(document.getElementById('compFixFiltroDataIni')?.value || '').trim();
    const dataFim = String(document.getElementById('compFixFiltroDataFim')?.value || '').trim();
    const temFiltro = !!(texto || campo || ambiente || dataIni || dataFim);
    counter.classList.toggle('has-filter', temFiltro);
}

function atualizarOpcoesAmbienteLogsCorrecaoCadastro(logs) {
    const select = document.getElementById('compFixFiltroAmbiente');
    if (!select) return;

    const atual = String(select.value || '');
    const ambientes = [...new Set(
        (Array.isArray(logs) ? logs : [])
            .map((row) => String(row?.ambiente || '').trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

    select.innerHTML = '<option value="">Todos ambientes</option>';
    ambientes.forEach((amb) => {
        const opt = document.createElement('option');
        opt.value = amb;
        opt.textContent = amb;
        select.appendChild(opt);
    });

    if (atual && ambientes.includes(atual)) {
        select.value = atual;
    } else {
        select.value = '';
    }
}

function renderizarTabelaLogsCorrecaoCadastro(logs, { tabelaExiste = true, mensagemVazia = '' } = {}) {
    const body = document.getElementById('compFixLogsBody');
    if (!body) return;

    if (!logs.length) {
        const msg = mensagemVazia || (
            tabelaExiste === false
                ? 'Tabela de log ainda não criada. Execute a correção para iniciar o histórico.'
                : 'Nenhum log de correção encontrado até agora.'
        );
        body.innerHTML = `
            <tr>
                <td colspan="6" class="comp-empty comp-fix-empty">
                    <i class="fas fa-inbox"></i>
                    ${escHtmlCompFix(msg)}
                </td>
            </tr>`;
        return;
    }

    const linhaCampo = (campo) => `
        <span class="comp-fix-campo">
            <span class="comp-fix-campo-label">${escHtmlCompFix(campo.label)}</span>
            <span class="comp-fix-campo-de">${escHtmlCompFix(campo.de ?? '-')}</span>
            <i class="fas fa-arrow-right"></i>
            <span class="comp-fix-campo-para">${escHtmlCompFix(campo.para ?? '-')}</span>
        </span>`;

    body.innerHTML = logs.map((row) => {
        const camposAlt = obterCamposAlteradosCompFix(row);
        const bitrixMeta = metaBitrixSyncCompFix(row);
        const mudouCategoria = camposAlt.some((c) => c.key === 'categoria');
        const mudouRede = camposAlt.some((c) => c.key === 'codrede');
        const codredeRef = row?.codrede_novo ?? row?.codrede_ant ?? null;
        const campos = camposAlt.length
            ? camposAlt.map(linhaCampo)
            : ['<span class="comp-fix-campo">Sem diferença de campo.</span>'];
        const tagsCampos = camposAlt.map((campo) => `
            <span class="comp-fix-tag tag-${campo.key}">${escHtmlCompFix(campo.label)}</span>
        `).join('');
        const tagRegraAtual = (mudouCategoria && !mudouRede && codredeRef != null)
            ? `<span class="comp-fix-tag tag-codrede">Regra atual: CODREDE ${escHtmlCompFix(codredeRef)} -> CATEGORIA</span>`
            : '';
        const tagBitrixStatus = bitrixMeta
            ? `<span class="comp-fix-tag ${bitrixMeta.className}" title="${escHtmlCompFix(bitrixMeta.titulo)}">${escHtmlCompFix(bitrixMeta.label)}</span>`
            : '';
        const tagBitrixResumo = bitrixMeta?.resumo
            ? `<span class="comp-fix-tag tag-bitrix-resumo" title="${escHtmlCompFix(bitrixMeta.titulo)}">${escHtmlCompFix(bitrixMeta.resumo)}</span>`
            : '';
        const tags = `${tagsCampos}${tagRegraAtual}${tagBitrixStatus}${tagBitrixResumo}`;

        const execFull = row.exec_id || '';
        const execShort = execFull ? String(execFull).slice(0, 8) : '-';
        const cliente = row.cliente || '-';
        const ambiente = row.ambiente || '-';

        return `
            <tr>
                <td class="text-nowrap comp-fix-col-when">${escHtmlCompFix(fmtDataHoraCompFix(row.alterado_em))}</td>
                <td class="col-fix-codcli"><span class="comp-fix-cod-pill">${escHtmlCompFix(row.codcli ?? '-')}</span></td>
                <td>
                    <div class="comp-fix-cliente">${escHtmlCompFix(cliente)}</div>
                    ${tags ? `<div class="comp-fix-tags">${tags}</div>` : ''}
                </td>
                <td class="col-fix-campos">${campos.join('')}</td>
                <td class="col-fix-exec">
                    ${execFull
                        ? `<span class="comp-fix-exec-chip" title="${escHtmlCompFix(execFull)}">${escHtmlCompFix(execShort)}</span>`
                        : '-'}
                </td>
                <td><span class="comp-fix-amb-chip ${ambienteCompFixClass(ambiente)}">${escHtmlCompFix(ambiente)}</span></td>
            </tr>`;
    }).join('');
}

function aplicarFiltrosLogsCorrecaoCadastro() {
    const logsBase = Array.isArray(_compFixLogsBase) ? _compFixLogsBase : [];
    const texto = normalizarCompFixTexto(document.getElementById('compFixFiltroTexto')?.value || '');
    const campoFiltro = String(document.getElementById('compFixFiltroCampo')?.value || '').trim().toUpperCase();
    const ambienteFiltro = normalizarCompFixTexto(document.getElementById('compFixFiltroAmbiente')?.value || '');
    const inDataIni = document.getElementById('compFixFiltroDataIni');
    const inDataFim = document.getElementById('compFixFiltroDataFim');
    let dataIniTxt = String(inDataIni?.value || '').trim();
    let dataFimTxt = String(inDataFim?.value || '').trim();

    if (dataIniTxt && dataFimTxt && dataIniTxt > dataFimTxt) {
        const antigoIni = dataIniTxt;
        dataIniTxt = dataFimTxt;
        dataFimTxt = antigoIni;
        if (inDataIni) inDataIni.value = dataIniTxt;
        if (inDataFim) inDataFim.value = dataFimTxt;
    }

    const dataIniMs = limiteDataCompFix(dataIniTxt, false);
    const dataFimMs = limiteDataCompFix(dataFimTxt, true);

    if (!logsBase.length) {
        const msg = _compFixPayload?.tabelaExiste === false
            ? 'Tabela de log ainda não criada. Execute a correção para iniciar o histórico.'
            : 'Nenhum log de correção encontrado até agora.';
        renderizarTabelaLogsCorrecaoCadastro([], {
            tabelaExiste: _compFixPayload?.tabelaExiste !== false,
            mensagemVazia: msg
        });
        atualizarContadorLogsCorrecaoCadastro(0, 0);
        return;
    }

    const filtrados = logsBase.filter((row) => {
        const campos = obterCamposAlteradosCompFix(row);
        const bitrixMeta = metaBitrixSyncCompFix(row);
        const camposSet = new Set(campos.map((c) => c.label));
        const dataEventoMs = tsCompFix(row?.alterado_em);

        if (campoFiltro && !camposSet.has(campoFiltro)) return false;
        if (ambienteFiltro && normalizarCompFixTexto(row?.ambiente) !== ambienteFiltro) return false;
        if (dataIniMs !== null && dataEventoMs < dataIniMs) return false;
        if (dataFimMs !== null && dataEventoMs > dataFimMs) return false;

        if (texto) {
            const pool = [
                row?.codcli,
                row?.cliente,
                row?.exec_id,
                row?.ambiente,
                fmtDataHoraCompFix(row?.alterado_em),
                bitrixMeta?.label,
                bitrixMeta?.resumo,
                bitrixMeta?.valor_destino,
                bitrixMeta?.erro,
                ...campos.map((c) => c.label),
                ...campos.map((c) => c.de),
                ...campos.map((c) => c.para),
                ...(Array.isArray(bitrixMeta?.detalhes) ? bitrixMeta.detalhes.map((item) => {
                    return [
                        item?.bitrix_id,
                        item?.nome,
                        item?.status,
                        item?.valor_anterior,
                        item?.valor_novo,
                        item?.erro
                    ].join(' ');
                }) : [])
            ].map((v) => normalizarCompFixTexto(v)).join(' ');
            if (!pool.includes(texto)) return false;
        }

        return true;
    });

    renderizarTabelaLogsCorrecaoCadastro(filtrados, {
        tabelaExiste: _compFixPayload?.tabelaExiste !== false,
        mensagemVazia: 'Nenhum log encontrado com os filtros selecionados.'
    });
    atualizarContadorLogsCorrecaoCadastro(filtrados.length, logsBase.length);
}

function filtrarLogsCorrecaoCadastro() {
    aplicarFiltrosLogsCorrecaoCadastro();
}

function limparFiltrosLogsCorrecaoCadastro() {
    const inTexto = document.getElementById('compFixFiltroTexto');
    const selCampo = document.getElementById('compFixFiltroCampo');
    const selAmb = document.getElementById('compFixFiltroAmbiente');
    const inDataIni = document.getElementById('compFixFiltroDataIni');
    const inDataFim = document.getElementById('compFixFiltroDataFim');

    if (inTexto) inTexto.value = '';
    if (selCampo) selCampo.value = '';
    if (selAmb) selAmb.value = '';
    if (inDataIni) inDataIni.value = '';
    if (inDataFim) inDataFim.value = '';

    syncCompCustomSelects();
    aplicarFiltrosLogsCorrecaoCadastro();
}

function renderizarLogsCorrecaoCadastro(payload) {
    _compFixPayload = payload || {};

    const elTotal = document.getElementById('compFixTotal');
    const elClientes = document.getElementById('compFixClientes');
    const elExecucoes = document.getElementById('compFixExecucoes');
    const elUltimo = document.getElementById('compFixUltimo');
    if (!elTotal || !elClientes || !elExecucoes || !elUltimo) return;

    const resumo = payload?.resumo || {};
    const logs = Array.isArray(payload?.logs) ? payload.logs : [];
    _compFixLogsBase = [...logs].sort((a, b) => {
        const db = tsCompFix(b?.alterado_em);
        const da = tsCompFix(a?.alterado_em);
        if (db !== da) return db - da;
        return Number(b?.codcli || 0) - Number(a?.codcli || 0);
    });

    const total = Number(resumo.total || _compFixLogsBase.length || 0);
    const clientes = Number(resumo.clientes_afetados || 0);
    const execucoes = Number(resumo.execucoes || 0);
    const ultimoTxt = resumo.ultimo_evento ? fmtDataHoraCompFix(resumo.ultimo_evento) : '-';

    elTotal.innerHTML = `<i class="fas fa-list"></i> ${total} logs`;
    elClientes.innerHTML = `<i class="fas fa-users"></i> ${clientes} clientes`;
    elExecucoes.innerHTML = `<i class="fas fa-play-circle"></i> ${execucoes} execuções`;
    elUltimo.innerHTML = `<i class="fas fa-clock"></i> Último: ${escHtmlCompFix(ultimoTxt)}`;

    const badge10 = document.getElementById('badge-tab10');
    if (badge10) {
        badge10.textContent = String(total);
        badge10.style.background = total > 0 ? 'rgba(16,185,129,.25)' : 'rgba(148,163,184,.22)';
        badge10.style.color = total > 0 ? 'var(--emerald)' : 'var(--text-secondary)';
    }

    atualizarOpcoesAmbienteLogsCorrecaoCadastro(_compFixLogsBase);
    initCompCustomSelects();
    syncCompCustomSelects();
    aplicarFiltrosLogsCorrecaoCadastro();
}

async function carregarLogsCorrecaoCadastro({ silent = false } = {}) {
    const body = document.getElementById('compFixLogsBody');
    if (!body) return;

    if (!silent) {
        body.innerHTML = `
            <tr>
                <td colspan="6" class="comp-empty comp-fix-empty">
                    <i class="fas fa-spinner fa-spin"></i> Carregando logs...
                </td>
            </tr>`;
    }

    try {
        const resp = await fetch('/api/comparar-carteiras/correcao-cadastro-logs?limit=150');
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `Erro HTTP ${resp.status}`);
        }
        const payload = await resp.json();
        renderizarLogsCorrecaoCadastro(payload);
    } catch (err) {
        _compFixPayload = null;
        _compFixLogsBase = [];
        body.innerHTML = `
            <tr>
                <td colspan="6" class="comp-empty comp-fix-empty">
                    <i class="fas fa-exclamation-triangle"></i>
                    Erro ao carregar logs: ${escHtmlCompFix(err.message)}
                </td>
            </tr>`;

        const badge10 = document.getElementById('badge-tab10');
        if (badge10) {
            badge10.textContent = '!';
            badge10.style.background = 'rgba(244,63,94,.22)';
            badge10.style.color = 'var(--rose)';
        }
        atualizarContadorLogsCorrecaoCadastro(0, 0);
    }
}

function recarregarLogsCorrecaoCadastro() {
    carregarLogsCorrecaoCadastro();
}

function closeCompCustomSelects(exceptWrap = null) {
    document.querySelectorAll('.comp-select-wrap.is-open').forEach((wrap) => {
        if (exceptWrap && wrap === exceptWrap) return;
        wrap.classList.remove('is-open');
        const trigger = wrap.querySelector('.comp-select-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
}

function renderCompCustomSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const wrap = select.closest('.comp-select-wrap');
    if (!wrap) return;

    let trigger = wrap.querySelector('.comp-select-trigger');
    let menu = wrap.querySelector('.comp-select-menu');

    if (!trigger) {
        trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'comp-select-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (select.disabled) return;

            const vaiAbrir = !wrap.classList.contains('is-open');
            closeCompCustomSelects(vaiAbrir ? wrap : null);
            wrap.classList.toggle('is-open', vaiAbrir);
            trigger.setAttribute('aria-expanded', vaiAbrir ? 'true' : 'false');
        });
        wrap.appendChild(trigger);
    }

    if (!menu) {
        menu = document.createElement('div');
        menu.className = 'comp-select-menu';
        menu.setAttribute('role', 'listbox');
        wrap.appendChild(menu);
    }

    const options = Array.from(select.options || []);
    const selectedOption = select.selectedOptions?.[0] || options.find(o => o.selected) || options[0] || null;
    const selectedValue = select.value ?? '';
    const selectedText = selectedOption ? selectedOption.textContent : 'Selecionar';

    trigger.innerHTML = `<span class="comp-select-trigger-label">${selectedText || 'Selecionar'}</span>`;
    trigger.title = selectedText || '';
    wrap.classList.toggle('is-placeholder', !String(selectedValue || '').trim());

    menu.innerHTML = options.map((opt, idx) => {
        const isSelected = String(opt.value) === String(selectedValue);
        const disabled = opt.disabled ? 'disabled' : '';
        return `
            <button
                type="button"
                class="comp-select-option${isSelected ? ' selected' : ''}"
                data-value="${String(opt.value ?? '').replace(/"/g, '&quot;')}"
                role="option"
                aria-selected="${isSelected ? 'true' : 'false'}"
                ${disabled}
            >
                <span class="comp-select-option-text">${opt.textContent || ''}</span>
                ${isSelected ? '<i class="fas fa-check"></i>' : ''}
            </button>
        `;
    }).join('');

    menu.querySelectorAll('.comp-select-option').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (btn.disabled) return;

            const novoValor = btn.dataset.value ?? '';
            if (String(select.value) !== String(novoValor)) {
                select.value = novoValor;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                renderCompCustomSelect(selectId);
            }

            closeCompCustomSelects();
        });
    });

    if (!select.dataset.compCustomSyncBound) {
        select.addEventListener('change', () => renderCompCustomSelect(selectId));
        select.dataset.compCustomSyncBound = '1';
    }
}

function initCompCustomSelects() {
    document
        .querySelectorAll('.comp-select-wrap[data-comp-custom-select]')
        .forEach((wrap) => {
            const selectId = wrap.getAttribute('data-comp-custom-select');
            const select = selectId ? document.getElementById(selectId) : null;
            if (!select) return;

            wrap.classList.add('comp-select-ready');
            select.classList.add('comp-select-native');
            renderCompCustomSelect(selectId);
        });

    if (!_compCustomSelectsBound) {
        document.addEventListener('click', (ev) => {
            if (!ev.target.closest('.comp-select-wrap')) closeCompCustomSelects();
        });

        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeCompCustomSelects();
        });

        _compCustomSelectsBound = true;
    }
}

function syncCompCustomSelects() {
    document
        .querySelectorAll('.comp-select-wrap[data-comp-custom-select]')
        .forEach((wrap) => {
            const selectId = wrap.getAttribute('data-comp-custom-select');
            if (selectId) renderCompCustomSelect(selectId);
        });
}

function atualizarCompRcaToolbarMeta(listaVisivel = null) {
    const metaEl = document.getElementById('compRcaToolbarMeta');
    if (!metaEl) return;

    const lista = Array.isArray(listaVisivel)
        ? listaVisivel
        : (Array.isArray(_compResumoRcaVisivel) ? _compResumoRcaVisivel : (_compResumoRca || []));
    const total = (_compResumoRca || []).length;
    const visiveis = lista.length;
    const ativos = lista.filter((r) => (
        Number(r.movido_entrando || 0) +
        Number(r.movido_saindo || 0) +
        Number(r.novo || 0) +
        Number(r.removido || 0)
    ) > 0).length;

    const rcaSel = Number(document.getElementById('compFiltroRca')?.value || 0);
    const chipFiltro = rcaSel
        ? `<span class="comp-rca-toolbar-chip"><i class="fas fa-crosshairs"></i> Filtrando RCA ${rcaSel}</span>`
        : '';

    metaEl.innerHTML = `
        <span>${visiveis} de ${total} vendedores visiveis</span>
        <span>${ativos} com divergencia</span>
        ${chipFiltro}
    `;
}

function atualizarCompRcaToolbarButtons() {
    const btn = document.getElementById('compRcaBtnDivergencia');
    if (!btn) return;

    const total = Array.isArray(_compResumoRca) ? _compResumoRca.length : 0;
    const comDivergencia = (Array.isArray(_compResumoRca) ? _compResumoRca : []).filter((r) => (
        Number(r.movido_entrando || 0) +
        Number(r.movido_saindo || 0) +
        Number(r.novo || 0) +
        Number(r.removido || 0)
    ) > 0).length;

    btn.classList.toggle('active', _compRcaSomenteDivergencia);
    btn.innerHTML = `<i class="fas fa-filter"></i> ${_compRcaSomenteDivergencia ? 'Mostrando divergencia' : 'So divergencia'}`;
    btn.title = _compRcaSomenteDivergencia
        ? 'Mostrando apenas vendedores com divergencia'
        : 'Filtrar vendedores com divergencia';
    btn.dataset.total = String(total);
    btn.dataset.comDivergencia = String(comDivergencia);
}

function filtrarRcaCardsView() {
    _compRcaBuscaTexto = (document.getElementById('compRcaBusca')?.value || '').toLowerCase().trim();
    renderizarRcaCardsFiltrados();
}

function toggleCompRcaSomenteDivergencia() {
    _compRcaSomenteDivergencia = !_compRcaSomenteDivergencia;
    atualizarCompRcaToolbarButtons();
    renderizarRcaCardsFiltrados();
}

function limparRcaCardsView() {
    _compRcaBuscaTexto = '';
    const input = document.getElementById('compRcaBusca');
    if (input) input.value = '';
    _compRcaSomenteDivergencia = false;
    atualizarCompRcaToolbarButtons();

    const selRca = document.getElementById('compFiltroRca');
    if (selRca && selRca.value) {
        selRca.value = '';
        syncCompCustomSelects();
        filtrarTabComp();
        return;
    }

    renderizarRcaCardsFiltrados();
    atualizarSelecaoRcaCards();
}

if (typeof window !== 'undefined') {
    window.filtrarRcaCardsView = filtrarRcaCardsView;
    window.toggleCompRcaSomenteDivergencia = toggleCompRcaSomenteDivergencia;
    window.limparRcaCardsView = limparRcaCardsView;
    window.recarregarLogsCorrecaoCadastro = recarregarLogsCorrecaoCadastro;
}

function atualizarSelecaoRcaCards() {
    const rcaSelecionado = Number(document.getElementById('compFiltroRca')?.value || 0);
    document.querySelectorAll('.comp-rca-card').forEach((card) => {
        const cod = Number(card.dataset.rca || 0);
        card.classList.toggle('active', Boolean(rcaSelecionado) && cod === rcaSelecionado);
    });
    atualizarCompRcaToolbarMeta();
}

function renderizarRcaCardsFiltrados() {
    const grid = document.getElementById('compRcaGrid');
    if (!grid) return;

    const esc = (valor) => String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    let lista = Array.isArray(_compResumoRca) ? [..._compResumoRca] : [];

    if (_compRcaBuscaTexto) {
        lista = lista.filter((r) => {
            const nome = String(r.nome || nomeRca(r.rca) || '').toLowerCase();
            const codigo = String(r.rca || '');
            return nome.includes(_compRcaBuscaTexto) || codigo.includes(_compRcaBuscaTexto);
        });
    }

    if (_compRcaSomenteDivergencia) {
        lista = lista.filter((r) => (
            Number(r.movido_entrando || 0) +
            Number(r.movido_saindo || 0) +
            Number(r.novo || 0) +
            Number(r.removido || 0)
        ) > 0);
    }

    _compResumoRcaVisivel = [...lista];
    atualizarCompRcaToolbarButtons();
    atualizarCompRcaToolbarMeta(lista);

    if (!lista.length) {
        grid.innerHTML = `
            <div class="comp-rca-empty">
                <i class="fas fa-search"></i>
                <span>Nenhum vendedor encontrado com os filtros da visao por vendedor.</span>
            </div>`;
        return;
    }

    const rcaSelecionado = Number(document.getElementById('compFiltroRca')?.value || 0);

    grid.innerHTML = lista.map((r) => {
        const totalRelacionado = Number(r.total_relacionado || r.total || 0);
        const movEntrando = Number(r.movido_entrando ?? r.movido ?? 0) || 0;
        const movSaindo = Number(r.movido_saindo || 0) || 0;
        const permaneceu = Number(r.permaneceu || 0) || 0;
        const novos = Number(r.novo || 0) || 0;
        const removidos = Number(r.removido || 0) || 0;
        const divergencias = movEntrando + movSaindo + novos + removidos;
        const totalWinthorAtual = Number(r.total_winthor || 0) || 0;
        const codRca = Number(r.rca);
        const nomeVend = r.nome || nomeRca(codRca);
        const nomeCurto = String(nomeVend || '').replace(/^RCA\s+\d+\s*[-]?\s*/i, '').trim() || `RCA ${codRca}`;

        const totBase = Math.max(totalRelacionado, 1);
        const pPerm = Math.round((permaneceu / totBase) * 100);
        const pMov = Math.round(((movEntrando + movSaindo) / totBase) * 100);
        const pNovo = Math.round((novos / totBase) * 100);
        const pRem = Math.round((removidos / totBase) * 100);

        const segPerm = Math.max(6, pPerm);
        const segMov = (movEntrando + movSaindo) > 0 ? Math.max(6, pMov) : 0;
        const segNovo = novos > 0 ? Math.max(5, pNovo) : 0;
        const segRem = removidos > 0 ? Math.max(5, pRem) : 0;

        return `
            <div
                class="comp-rca-card${rcaSelecionado === codRca ? ' active' : ''}${divergencias > 0 ? ' has-diff' : ''}"
                data-rca="${codRca}"
                role="button"
                tabindex="0"
                title="Clique para filtrar pelo RCA ${codRca}"
                onclick="filtrarPorRca(${codRca})"
                onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();filtrarPorRca(${codRca})}"
            >
                <div class="crca-head">
                    <div class="crca-ident">
                        <span class="crca-name">${esc(nomeCurto)}</span>
                        <span class="crca-code">RCA ${codRca}</span>
                    </div>
                    <div class="crca-head-actions">
                        <span class="crca-state ${divergencias > 0 ? 'warn' : 'ok'}" title="${divergencias > 0 ? 'Com divergencias' : 'Sem divergencias'}">
                            <i class="fas ${divergencias > 0 ? 'fa-exclamation-triangle' : 'fa-check-circle'}"></i>
                        </span>
                        <button
                            type="button"
                            class="crca-pdf-btn"
                            onclick="event.stopPropagation(); baixarPdfCarteiraWinthor(${codRca}, '${String(nomeVend || '').replace(/'/g, "\\'")}', event)"
                            title="Baixar PDF da carteira real do WinThor"
                        >
                            <i class="fas fa-file-pdf"></i>
                        </button>
                    </div>
                </div>
                <div class="crca-metrics">
                    <span class="crca-chip winthor"><i class="fas fa-database"></i> Atuais no WinThor: ${totalWinthorAtual}</span>
                    <span class="crca-chip perm"><i class="fas fa-check"></i> ${permaneceu}</span>
                    <span class="crca-chip mov"><i class="fas fa-arrows-alt-h"></i> ${movEntrando + movSaindo}</span>
                    ${novos ? `<span class="crca-chip novo"><i class="fas fa-plus"></i> ${novos}</span>` : ''}
                    ${removidos ? `<span class="crca-chip rem"><i class="fas fa-minus"></i> ${removidos}</span>` : ''}
                </div>
                <div class="crca-stack" aria-hidden="true">
                    <span class="seg perm" style="width:${segPerm}%"></span>
                    ${segMov ? `<span class="seg mov" style="width:${segMov}%"></span>` : ''}
                    ${segNovo ? `<span class="seg novo" style="width:${segNovo}%"></span>` : ''}
                    ${segRem ? `<span class="seg rem" style="width:${segRem}%"></span>` : ''}
                </div>
                <div class="crca-foot">
                    <span class="crca-foot-item"><i class="fas fa-sign-in-alt"></i> Entrou ${movEntrando}</span>
                    <span class="crca-foot-item"><i class="fas fa-sign-out-alt"></i> Saiu ${movSaindo}</span>
                </div>
            </div>`;
    }).join('');
}

function compLinhaDataReferenciaMs(row) {
    if (!row || typeof row !== 'object') return 0;

    const candidatos = [
        row.alteracao_rca_sistema_data,
        row.alteracao_rca_data,
        row.data_snapshot
    ];

    let maxMs = 0;
    for (const valor of candidatos) {
        if (!valor) continue;
        const ms = new Date(valor).getTime();
        if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
    }
    return maxMs;
}

function ordenarComparacaoMaisRecentesPrimeiro(lista) {
    const pesoSituacao = { MOVIDO: 4, REMOVIDO: 3, NOVO: 2, PERMANECEU: 1 };

    return [...(Array.isArray(lista) ? lista : [])].sort((a, b) => {
        const da = compLinhaDataReferenciaMs(a);
        const db = compLinhaDataReferenciaMs(b);
        if (db !== da) return db - da;

        const pa = pesoSituacao[String(a?.situacao || '').toUpperCase()] || 0;
        const pb = pesoSituacao[String(b?.situacao || '').toUpperCase()] || 0;
        if (pb !== pa) return pb - pa;

        const ca = Number(a?.codcli || 0);
        const cb = Number(b?.codcli || 0);
        return cb - ca;
    });
}

async function carregarComparacao() {
    try {
        const resp = await fetch('/api/comparar-carteiras');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const dados = await resp.json();
        if (dados.error) throw new Error(dados.error);

        _compCarregado = true;
        _compDados = ordenarComparacaoMaisRecentesPrimeiro(dados.comparacao || []);

        // Metadados
        document.getElementById('compTotalSistema').textContent = (dados.totalSistema || 0).toLocaleString('pt-BR');
        document.getElementById('compTotalWinthor').textContent = (dados.totalWinthor || 0).toLocaleString('pt-BR');
        document.getElementById('compDataSnapshot').textContent = dados.ultimoProcessamento
            ? new Date(dados.ultimoProcessamento).toLocaleString('pt-BR')
            : 'Sem dados';

        // Totalizadores
        const contar = sit => _compDados.filter(r => r.situacao === sit).length;
        document.getElementById('cTotal').textContent = _compDados.length.toLocaleString('pt-BR');
        document.getElementById('cPerm').textContent = contar('PERMANECEU').toLocaleString('pt-BR');
        document.getElementById('cMovido').textContent = contar('MOVIDO').toLocaleString('pt-BR');
        document.getElementById('cNovo').textContent = contar('NOVO').toLocaleString('pt-BR');
        document.getElementById('cRemovido').textContent = contar('REMOVIDO').toLocaleString('pt-BR');

        // Badge da aba
        const bMovidos = contar('MOVIDO') + contar('REMOVIDO');
        const badge9 = document.getElementById('badge-tab9');
        if (badge9) {
            badge9.textContent = bMovidos > 0 ? `${bMovidos} !` : 'OK';
            badge9.style.background = bMovidos > 0 ? 'rgba(245,158,11,.25)' : 'rgba(16,185,129,.25)';
            badge9.style.color = bMovidos > 0 ? 'var(--amber)' : 'var(--emerald)';
        }

        // Painel por RCA (visao compacta + filtros locais)
        renderizarRcaCards(dados.resumoPorRca || []);

        // Popula select de RCAs
        // Inclui RCAs de ORIGEM e DESTINO para nao esconder movimentos
        // em que o cliente saiu de um RCA especifico e foi para outro.
        const selRca = document.getElementById('compFiltroRca');
        const rcasUnicos = [...new Set(
            _compDados
                .flatMap(r => [r.rca_sistema, r.rca_winthor])
                .map(v => Number(v))
                .filter(v => Number.isFinite(v) && v > 0)
        )].sort((a, b) => a - b);

        selRca.innerHTML = '<option value="">Todos os RCAs</option>';
        rcasUnicos.forEach(rca => {
            const opt = document.createElement('option');
            opt.value = rca;
            opt.textContent = nomeRca(rca);
            selRca.appendChild(opt);
        });

        initCompCustomSelects();
        syncCompCustomSelects();

        // Renderiza tabela
        _compFiltrados = ordenarComparacaoMaisRecentesPrimeiro(_compDados);
        _compPagAtual = 1;
        renderizarTabComp();
        await carregarLogsCorrecaoCadastro({ silent: true });

        document.getElementById('compLoader').style.display = 'none';
        document.getElementById('compConteudo').style.display = 'block';

    } catch (err) {
        console.error('[Comparacao]', err);
        document.getElementById('compLoader').style.display = 'none';
        document.getElementById('compErroMsg').textContent = 'Erro ao carregar: ' + err.message;
        document.getElementById('compErro').style.display = 'block';
    }
}

function renderizarRcaCards(resumo) {
    _compResumoRca = Array.isArray(resumo) ? [...resumo] : [];
    _compResumoRcaVisivel = [..._compResumoRca];
    atualizarCompRcaToolbarButtons();
    renderizarRcaCardsFiltrados();
}

function filtrarPorRca(codRca) {
    document.getElementById('compFiltroRca').value = String(codRca);
    syncCompCustomSelects();
    filtrarTabComp();
}

// ===========================
// DOWNLOAD PDF CARTEIRA WINTHOR
// ===========================
async function baixarPdfCarteiraWinthor(codRca, nomeVendedor, evArg) {
    const ev = evArg || (typeof event !== 'undefined' ? event : null);
    const btn = ev?.target?.closest?.('.crca-pdf-btn, .btn-pdf-carteira') || null;
    const originalHtml = btn ? btn.innerHTML : '';

    try {
        if (btn) {
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            btn.disabled = true;
        }

        const response = await fetch(`/api/gerar-pdf-carteira-winthor/${codRca}`);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Erro HTTP ${response.status}`);
        }

        // Download do PDF
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Carteira_WinThor_RCA${codRca}_${new Date().toISOString().split('T')[0]}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        // Feedback visual temporario
        if (btn) {
            btn.innerHTML = '<i class="fas fa-check"></i>';
            btn.style.background = 'var(--emerald)';
            btn.style.color = '#fff';
            setTimeout(() => {
                btn.innerHTML = originalHtml;
                btn.style.background = '';
                btn.style.color = '';
                btn.disabled = false;
            }, 2500);
        }

    } catch (error) {
        console.error('[PDF]', error);
        alert('Erro ao gerar PDF: ' + error.message);
        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }
}

// ===========================
// DOWNLOAD TODOS OS PDFs (sequencial)
// ===========================
async function baixarTodosPdfsWinthor() {
    const btn = document.getElementById('btnPdfTodos');
    const originalHtml = btn.innerHTML;

    // Pega todos os RCAs dos cards renderizados
    const cards = document.querySelectorAll('.comp-rca-card[data-rca]');
    const rcas = [];
    cards.forEach(card => {
        const cod = Number(card.dataset.rca || 0);
        if (Number.isFinite(cod) && cod > 0) rcas.push(cod);
    });

    if (rcas.length === 0) {
        alert('Nenhum vendedor encontrado para gerar PDFs.');
        return;
    }

    if (!confirm(`Deseja gerar e baixar o PDF de ${rcas.length} vendedores?\nCada PDF sera baixado sequencialmente.`)) {
        return;
    }

    btn.disabled = true;
    let gerados = 0;
    let erros = 0;

    for (const rca of rcas) {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${gerados + 1}/${rcas.length} - RCA ${rca}...`;

        try {
            const response = await fetch(`/api/gerar-pdf-carteira-winthor/${rca}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Carteira_WinThor_RCA${rca}_${new Date().toISOString().split('T')[0]}.pdf`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            gerados++;
        } catch (err) {
            console.error(`[PDF] Erro RCA ${rca}:`, err);
            erros++;
        }

        // Pausa entre downloads para nao sobrecarregar
        await new Promise(r => setTimeout(r, 1500));
    }

    btn.innerHTML = `<i class="fas fa-check"></i> ${gerados} gerados${erros > 0 ? `, ${erros} erros` : ''}`;
    btn.style.background = erros > 0 ? 'var(--amber)' : 'var(--emerald)';

    setTimeout(() => {
        btn.innerHTML = originalHtml;
        btn.style.background = '';
        btn.disabled = false;
    }, 4000);
}

function filtrarTabComp() {
    const texto = (document.getElementById('compFiltroTexto').value || '').toLowerCase().trim();
    const situacao = document.getElementById('compFiltroSituacao').value || '';
    const rcaFiltro = document.getElementById('compFiltroRca').value || '';
    const nivel = (document.getElementById('compFiltroNivel').value || '').toUpperCase();

    _compFiltrados = ordenarComparacaoMaisRecentesPrimeiro(_compDados.filter(r => {
        if (situacao && r.situacao !== situacao) return false;
        if (nivel && (r.nivel || '').toUpperCase().trim() !== nivel) return false;
        if (rcaFiltro) {
            const rcaNum = Number(rcaFiltro);
            const rcaSistema = Number(r.rca_sistema);
            const rcaWinthor = Number(r.rca_winthor);
            const relacionadoAoRca =
                (Number.isFinite(rcaSistema) && rcaSistema === rcaNum) ||
                (Number.isFinite(rcaWinthor) && rcaWinthor === rcaNum);
            if (!relacionadoAoRca) return false;
        }
        if (texto) {
            const matchCod = String(r.codcli).includes(texto);
            const matchNome = (r.cliente || '').toLowerCase().includes(texto);
            if (!matchCod && !matchNome) return false;
        }
        return true;
    }));

    _compPagAtual = 1;
    renderizarTabComp();
    syncCompCustomSelects();
    atualizarSelecaoRcaCards();
}

function limparFiltrosComp() {
    document.getElementById('compFiltroTexto').value = '';
    document.getElementById('compFiltroSituacao').value = '';
    document.getElementById('compFiltroRca').value = '';
    document.getElementById('compFiltroNivel').value = '';
    syncCompCustomSelects();
    filtrarTabComp();
}

function mudaPagComp(delta) {
    const maxPag = Math.ceil(_compFiltrados.length / COMP_PAG_TAM);
    _compPagAtual = Math.max(1, Math.min(maxPag, _compPagAtual + delta));
    renderizarTabComp();
}

function renderizarTabComp() {
    const tbody = document.getElementById('tbodyComparacao');
    const total = _compFiltrados.length;
    const maxPag = Math.max(1, Math.ceil(total / COMP_PAG_TAM));

    const ini = (_compPagAtual - 1) * COMP_PAG_TAM;
    const fim = Math.min(ini + COMP_PAG_TAM, total);
    const pagina = _compFiltrados.slice(ini, fim);

    // Paginacao
    document.getElementById('compPagInfo').textContent = `${ini + 1}-${fim} de ${total.toLocaleString('pt-BR')}`;
    document.getElementById('compBtnAnterior').disabled = _compPagAtual <= 1;
    document.getElementById('compBtnProximo').disabled = _compPagAtual >= maxPag;

    if (!pagina.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="comp-empty">
            <i class="fas fa-search"></i>
            Nenhum cliente encontrado com os filtros aplicados.</td></tr>`;
        return;
    }

    const sitMeta = {
        PERMANECEU: { icon: 'fa-check-circle', label: 'Permaneceu' },
        MOVIDO:     { icon: 'fa-arrows-alt-h', label: 'Movido' },
        NOVO:       { icon: 'fa-plus-circle',  label: 'Novo' },
        REMOVIDO:   { icon: 'fa-minus-circle', label: 'Removido' },
    };

    const corDias = d => {
        if (d == null) return '';
        if (d >= 60) return 'style="color:var(--rose);font-weight:700"';
        if (d >= 30) return 'style="color:var(--amber);font-weight:700"';
        return '';
    };

    const celulaRca = (rca, nome) => {
        if (!rca) return '<span class="text-muted">-</span>';
        return `<span style="font-weight:600">${rca}</span> <small class="text-muted">${nome || ''}</small>`;
    };

    const celulaRcaMov = (rca, nome, tipo, rotulo) => {
        if (!rca) return '<span class="text-muted">&mdash;</span>';
        return `
            <div class="rca-pill ${tipo}">
                <span class="rca-pill-top">${rotulo}</span>
                <span class="rca-pill-code">RCA ${rca}</span>
                ${nome ? `<small class="rca-pill-name">${escHtml(nome)}</small>` : ''}
            </div>`;
    };

    const escHtml = (valor) => String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const formatarDataHoraBr = (valor) => {
        if (!valor) return null;
        const dt = new Date(valor);
        if (Number.isNaN(dt.getTime())) return String(valor);
        return dt.toLocaleString('pt-BR');
    };

    const metaOrigemSistemaMov = (origemRaw) => {
        const origem = String(origemRaw || '').trim();
        const origemUp = origem.toUpperCase();

        if (origemUp.includes('SUBSTITUICAO')) {
            return {
                tipoClasse: 'type-substituicao',
                icon: 'fa-hand-pointer',
                titulo: 'Substituição Manual',
                descricao: 'Mudança feita pela tela de substituição do sistema'
            };
        }

        if (
            origemUp.includes('ETAPA_5') ||
            origemUp.includes('REDISTRIBUICAO') ||
            origemUp.includes('MOV_CART')
        ) {
            return {
                tipoClasse: 'type-cron',
                icon: 'fa-robot',
                titulo: 'Cron / Automação',
                descricao: 'Mudança registrada por rotina automática do sistema'
            };
        }

        return {
            tipoClasse: 'type-sistema',
            icon: 'fa-cogs',
            titulo: 'Sistema Interno',
            descricao: 'Mudança registrada pelo sistema (origem não classificada)'
        };
    };

    const blocoAuditoriaMov = (r) => {
        const fonteAlteracao = (r.alteracao_rca_fonte || '').toUpperCase();
        const origemSistema = r.alteracao_rca_sistema_origem || null;
        const dataSistema = formatarDataHoraBr(r.alteracao_rca_sistema_data);
        const dataSnapshot = formatarDataHoraBr(r.data_snapshot);

        if (fonteAlteracao === 'SISTEMA') {
            const metaSistema = metaOrigemSistemaMov(origemSistema);
            return `
                <div class="rca-mov-audit is-system ${metaSistema.tipoClasse}">
                    <div class="rca-mov-source-line">
                        <span class="rca-mov-source-pill ${metaSistema.tipoClasse}">
                            <i class="fas ${metaSistema.icon}"></i>
                            ${metaSistema.titulo}
                        </span>
                        <span class="rca-mov-source-text">Quem moveu esta situação: Sistema</span>
                    </div>
                    <div class="rca-mov-audit-row">
                        <i class="fas ${metaSistema.icon}"></i>
                        <span class="rca-mov-audit-label">Quem moveu a situação</span>
                        <span class="rca-mov-audit-value">Sistema (${metaSistema.titulo})</span>
                        ${origemSistema ? `<span class="rca-mov-audit-chip is-soft">${escHtml(origemSistema)}</span>` : ''}
                    </div>
                    ${dataSnapshot ? `
                    <div class="rca-mov-audit-row compact">
                        <i class="fas fa-camera"></i>
                        <span class="rca-mov-audit-label">Snapshot do cron</span>
                        <span class="rca-mov-audit-value">${escHtml(dataSnapshot)}</span>
                    </div>` : ''}
                    ${dataSistema ? `
                    <div class="rca-mov-audit-row compact">
                        <i class="fas fa-clock"></i>
                        <span class="rca-mov-audit-label">Registro do sistema</span>
                        <span class="rca-mov-audit-value">${escHtml(dataSistema)}</span>
                    </div>` : ''}
                </div>`;
        }

        const nomeUsuario = r.alteracao_rca_usuario_nome_guerra || r.alteracao_rca_usuario_nome || null;
        const matricula = r.alteracao_rca_matricula;
        const dataHora = formatarDataHoraBr(r.alteracao_rca_data);
        const rotina = r.alteracao_rca_rotina || null;
        const campoLog = r.alteracao_rca_campo || null;

        if (fonteAlteracao === 'CRON') {
            return `
                <div class="rca-mov-audit is-cron-inferido">
                    <div class="rca-mov-source-line">
                        <span class="rca-mov-source-pill type-cron">
                            <i class="fas fa-robot"></i>
                            Cron (inferido)
                        </span>
                        <span class="rca-mov-source-text">Quem moveu esta situação: Cron/Sistema (não há log CODUSUR1 recente no WinThor após o snapshot)</span>
                    </div>
                    <div class="rca-mov-audit-row">
                        <i class="fas fa-robot"></i>
                        <span class="rca-mov-audit-label">Quem moveu a situação</span>
                        <span class="rca-mov-audit-value">Cron / Sistema (inferido)</span>
                    </div>
                    ${dataSnapshot ? `
                    <div class="rca-mov-audit-row compact">
                        <i class="fas fa-camera"></i>
                        <span class="rca-mov-audit-label">Snapshot do cron</span>
                        <span class="rca-mov-audit-value">${escHtml(dataSnapshot)}</span>
                    </div>` : ''}
                    ${dataHora ? `
                    <div class="rca-mov-audit-row compact">
                        <i class="fas fa-history"></i>
                        <span class="rca-mov-audit-label">Último log WinThor (histórico)</span>
                        <span class="rca-mov-audit-value">${escHtml(dataHora)}</span>
                        ${rotina ? `<span class="rca-mov-audit-chip is-soft">${escHtml(rotina)}</span>` : ''}
                    </div>` : ''}
                </div>`;
        }

        if (fonteAlteracao === 'INDETERMINADO') {
            return `
                <div class="rca-mov-audit is-unknown">
                    <div class="rca-mov-source-line">
                        <span class="rca-mov-source-pill type-indeterminado">
                            <i class="fas fa-question-circle"></i>
                            Origem indefinida
                        </span>
                        <span class="rca-mov-source-text">Não foi possível afirmar se a situação foi causada por Sistema ou WinThor</span>
                    </div>
                    <div class="rca-mov-audit-row">
                        <i class="fas fa-question-circle"></i>
                        <span class="rca-mov-audit-label">Quem moveu a situação</span>
                        <span class="rca-mov-audit-value">Não identificado</span>
                    </div>
                    ${dataSnapshot ? `
                    <div class="rca-mov-audit-row compact">
                        <i class="fas fa-camera"></i>
                        <span class="rca-mov-audit-label">Snapshot do cron</span>
                        <span class="rca-mov-audit-value">${escHtml(dataSnapshot)}</span>
                    </div>` : ''}
                    ${dataHora ? `
                    <div class="rca-mov-audit-row compact">
                        <i class="fas fa-history"></i>
                        <span class="rca-mov-audit-label">Último log WinThor (histórico)</span>
                        <span class="rca-mov-audit-value">${escHtml(dataHora)}</span>
                        ${rotina ? `<span class="rca-mov-audit-chip is-soft">${escHtml(rotina)}</span>` : ''}
                    </div>` : ''}
                </div>`;
        }

        if (!nomeUsuario && !matricula && !dataHora) {
            return `
                <div class="rca-mov-audit is-empty">
                    <div class="rca-mov-audit-row">
                        <i class="fas fa-info-circle"></i>
                        <span>Sem log recente no WinThor para explicar esta situação.</span>
                    </div>
                </div>`;
        }

        return `
            <div class="rca-mov-audit" title="${escHtml(rotina ? `Rotina: ${rotina}` : 'Auditoria WinThor')}">
                <div class="rca-mov-source-line">
                    <span class="rca-mov-source-pill type-winthor">
                        <i class="fas fa-database"></i>
                        WinThor direto
                    </span>
                    <span class="rca-mov-source-text">Quem moveu esta situação: WinThor</span>
                </div>
                <div class="rca-mov-audit-row">
                    <i class="fas fa-database"></i>
                    <span class="rca-mov-audit-label">Quem moveu a situação</span>
                    <span class="rca-mov-audit-value">WinThor direto</span>
                </div>
                ${dataSnapshot ? `
                <div class="rca-mov-audit-row compact">
                    <i class="fas fa-camera"></i>
                    <span class="rca-mov-audit-label">Snapshot do cron</span>
                    <span class="rca-mov-audit-value">${escHtml(dataSnapshot)}</span>
                </div>` : ''}
                <div class="rca-mov-audit-row">
                    <i class="fas fa-user"></i>
                    <span class="rca-mov-audit-label">Alterado por</span>
                    <span class="rca-mov-audit-value">${escHtml(nomeUsuario || 'Usuário não identificado')}</span>
                    ${matricula ? `<span class="rca-mov-audit-chip">Mat. ${matricula}</span>` : ''}
                </div>
                <div class="rca-mov-audit-row">
                    <i class="fas fa-clock"></i>
                    <span class="rca-mov-audit-label">Quando</span>
                    <span class="rca-mov-audit-value">${escHtml(dataHora || 'Data não encontrada')}</span>
                    ${rotina ? `<span class="rca-mov-audit-chip is-soft">${escHtml(rotina)}</span>` : ''}
                </div>
                ${campoLog ? `
                <div class="rca-mov-audit-row compact">
                    <i class="fas fa-database"></i>
                    <span class="rca-mov-audit-label">Log</span>
                    <span class="rca-mov-audit-value">${escHtml(campoLog)}</span>
                </div>` : ''}
            </div>`;
    };

    tbody.innerHTML = pagina.map(r => {
        const meta = sitMeta[r.situacao] || { icon: 'fa-question', label: r.situacao };
        const nivel = (r.nivel || '-').toUpperCase().trim();

        let celulaRcas = '';
        let celulaOrigemAlteracao = '<td class="comp-col-origem-cell"><span class="text-muted">&mdash;</span></td>';
        if (r.situacao === 'MOVIDO') {
            celulaRcas = `
                <td>${celulaRcaMov(r.rca_sistema, r.nome_rca_sistema, 'is-origem', 'Cron')}</td>
                <td>
                    <div class="rca-mov-wrap">
                        ${celulaRcaMov(r.rca_winthor, r.nome_rca_winthor, 'is-destino', 'WinThor atual')}
                    </div>
                </td>`;
            celulaOrigemAlteracao = `<td class="comp-col-origem-cell">${blocoAuditoriaMov(r)}</td>`;
        } else {
            celulaRcas = `
                <td>${celulaRca(r.rca_sistema, r.nome_rca_sistema)}</td>
                <td>${celulaRca(r.rca_winthor, r.nome_rca_winthor)}</td>`;
        }

        const trClass = r.situacao === 'MOVIDO' ? ' class="comp-row-movido"' : '';
        const clienteNomeEsc = escHtml(r.cliente || '');
        const btnHistorico = `<button class="comp-hist-btn" type="button" onclick="event.stopPropagation(); abrirHistoricoComparacao(${Number(r.codcli)})" title="Ver histórico de alterações"><i class="fas fa-history"></i> Histórico</button>`;
        return `<tr${trClass}>
            <td><strong>${r.codcli}</strong></td>
            <td><div class="comp-cli-cell"><span class="comp-cli-name">${clienteNomeEsc}</span>${btnHistorico}</div></td>
            <td>${nivel !== '-' ? `<span class="badge bg-${nivelBadgeClass(nivel)}">${nivel}</span>` : '-'}</td>
            ${celulaRcas}
            ${celulaOrigemAlteracao}
            <td ${corDias(r.dias_sem_compra)}>${r.dias_sem_compra ?? '-'}</td>
            <td>${r.status_sistema
                ? `<span class="badge ${statusBadgeClass(r.status_sistema)}">${r.status_sistema}</span>`
                : '<span class="text-muted">-</span>'}</td>
            <td><span class="sit-badge sit-${r.situacao}"><i class="fas ${meta.icon}"></i> ${meta.label}</span></td>
        </tr>`;
    }).join('');
}

let _compHistKeydownBound = false;
let _compHistState = {
    codcli: null,
    linhaAtual: null,
    winthorPage: 1,
    winthorLimit: 30
};
let _compHistRequestSeq = 0;

function normalizarTextoCompHist(valor) {
    if (typeof valor !== 'string') return valor;

    let txt = valor;
    const contarMarcadoresRuins = (str) => (String(str || '').match(/[ÃÂ¿�]/g) || []).length;

    if (/[ÃÂ]/.test(txt) && typeof TextDecoder !== 'undefined') {
        try {
            const bytes = Uint8Array.from(txt, (ch) => ch.charCodeAt(0) & 0xff);
            const corrigido = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            if (contarMarcadoresRuins(corrigido) < contarMarcadoresRuins(txt)) {
                txt = corrigido;
            }
        } catch (_) {}
    }

    txt = txt
        .replace(/N¿o/g, 'Não')
        .replace(/n¿o/g, 'não')
        .replace(/NA¿O/g, 'NÃO')
        .replace(/¿¿/g, 'çã')
        .replace(/¿/g, 'ã');

    return txt;
}

function escHtmlCompHist(valor) {
    return String(normalizarTextoCompHist(valor) ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtDataHoraCompHist(valor) {
    if (!valor) return 'Data indisponível';
    const dt = new Date(valor);
    if (Number.isNaN(dt.getTime())) return String(valor);
    return dt.toLocaleString('pt-BR');
}

function fmtValorRcaCompHist(valor) {
    if (valor == null || valor === '') return '-';
    if (typeof valor === 'number') return String(valor);
    if (typeof valor === 'string') {
        // Proteção extra caso algum CLOB do Oracle escape sem conversão no backend.
        if (
            valor.length > 120 &&
            (valor.includes('"_readableState"') || valor.includes('"_autoCloseLob"'))
        ) {
            return '[CLOB Oracle]';
        }
        return normalizarTextoCompHist(valor);
    }
    if (typeof valor === 'object') {
        // Objetos LOB/CLOB do driver Oracle podem vazar como stream e quebrar o layout.
        if (
            valor &&
            (Object.prototype.hasOwnProperty.call(valor, '_autoCloseLob') ||
             Object.prototype.hasOwnProperty.call(valor, '_impl') ||
             Object.prototype.hasOwnProperty.call(valor, '_readableState'))
        ) {
            return '[CLOB Oracle]';
        }
        try {
            if (typeof valor.toString === 'function') {
                const txt = normalizarTextoCompHist(valor.toString());
                if (txt && txt !== '[object Object]') return txt;
            }
            const json = JSON.stringify(valor);
            if (json && json !== '{}') return json;
        } catch (_) {}
        return '[objeto]';
    }
    return String(valor);
}

function fmtCampoCompHist(campo) {
    const txt = String(campo || '').trim();
    if (!txt) return 'CAMPO';
    return txt.toUpperCase().replace(/_/g, ' ');
}

function renderPaginacaoWinthorCompHist(paginacao) {
    const total = Number(paginacao?.total || 0);
    if (total <= 0) return '';

    const page = Math.max(1, Number(paginacao?.page || 1) || 1);
    const totalPages = Math.max(1, Number(paginacao?.total_pages || 1) || 1);
    const from = Number(paginacao?.from || 0) || 0;
    const to = Number(paginacao?.to || 0) || 0;
    const hasPrev = Boolean(paginacao?.has_prev);
    const hasNext = Boolean(paginacao?.has_next);

    return `
        <div class="comp-hist-pager">
            <div class="comp-hist-pager-info">
                <span class="comp-hist-inline-chip"><i class="fas fa-database"></i> Histórico WinThor paginado</span>
                <span>Mostrando ${escHtmlCompHist(from)}-${escHtmlCompHist(to)} de ${escHtmlCompHist(total)} registros</span>
                <span>Página ${escHtmlCompHist(page)} de ${escHtmlCompHist(totalPages)}</span>
            </div>
            <div class="comp-hist-pager-actions">
                <button type="button" class="comp-hist-pager-btn" onclick="irPaginaHistoricoComparacao(${page - 1})" ${hasPrev ? '' : 'disabled'}>
                    <i class="fas fa-chevron-left"></i> Anterior
                </button>
                <button type="button" class="comp-hist-pager-btn" onclick="irPaginaHistoricoComparacao(${page + 1})" ${hasNext ? '' : 'disabled'}>
                    Próxima <i class="fas fa-chevron-right"></i>
                </button>
            </div>
        </div>`;
}

function renderDecisaoAtualHistorico(linhaAtual) {
    if (!linhaAtual) return '';

    const fonte = String(linhaAtual.alteracao_rca_fonte || '').toUpperCase();
    const sit = linhaAtual.situacao || '-';
    const snapshot = fmtDataHoraCompHist(linhaAtual.data_snapshot);
    const rcaSistema = linhaAtual.rca_sistema ?? '-';
    const rcaWinthor = linhaAtual.rca_winthor ?? '-';

    let badgeClass = 'unknown';
    let badgeIcon = 'fa-question-circle';
    let badgeLabel = 'Origem indefinida';
    let desc = 'Não foi possível identificar com segurança quem causou a divergência atual.';

    if (fonte === 'WINTHOR') {
        badgeClass = 'winthor';
        badgeIcon = 'fa-database';
        badgeLabel = 'WinThor direto';
        desc = 'A situação atual foi atribuída à alteração manual no WinThor após o snapshot do cron.';
    } else if (fonte === 'SISTEMA') {
        badgeClass = 'sistema';
        badgeIcon = 'fa-cogs';
        badgeLabel = 'Sistema';
        desc = 'A situação atual foi atribuída à movimentação registrada pelo sistema (cron/substituição/automação).';
    } else if (fonte === 'CRON') {
        badgeClass = 'cron';
        badgeIcon = 'fa-robot';
        badgeLabel = 'Cron (inferido)';
        desc = 'Não há log CODUSUR1 recente no WinThor após o snapshot; a divergência foi tratada como cron/sistema.';
    }

    const origemSistema = linhaAtual.alteracao_rca_sistema_origem || null;

    return `
        <div class="comp-hist-decisao ${badgeClass}">
            <div class="comp-hist-decisao-head">
                <span class="comp-hist-decisao-pill ${badgeClass}">
                    <i class="fas ${badgeIcon}"></i>
                    Decisão da comparação atual
                </span>
                <span class="comp-hist-decisao-date">Situação: ${escHtmlCompHist(sit)}</span>
            </div>
            <div class="comp-hist-decisao-grid">
                <div class="comp-hist-decisao-item">
                    <label>Quem moveu a situação</label>
                    <div class="value">${escHtmlCompHist(badgeLabel)}</div>
                </div>
                <div class="comp-hist-decisao-item">
                    <label>RCA comparado</label>
                    <div class="value">${escHtmlCompHist(rcaSistema)} <i class="fas fa-arrow-right"></i> ${escHtmlCompHist(rcaWinthor)}</div>
                </div>
                <div class="comp-hist-decisao-item">
                    <label>Snapshot do cron</label>
                    <div class="value">${escHtmlCompHist(snapshot)}</div>
                </div>
                ${origemSistema ? `
                <div class="comp-hist-decisao-item">
                    <label>Origem do sistema</label>
                    <div class="value">${escHtmlCompHist(origemSistema)}</div>
                </div>` : ''}
            </div>
            <div class="comp-hist-decisao-note">${escHtmlCompHist(desc)}</div>
        </div>`;
}

function abrirHistoricoComparacao(codcli) {
    const cod = Number(codcli);
    if (!Number.isFinite(cod) || cod <= 0) return;

    const modal = document.getElementById('compHistModal');
    const body = document.getElementById('compHistBody');
    const titulo = document.getElementById('compHistTitulo');
    const subtitulo = document.getElementById('compHistSubtitulo');
    const meta = document.getElementById('compHistMeta');
    if (!modal || !body || !titulo || !subtitulo || !meta) return;

    const linhaAtual = (_compDados || []).find(r => Number(r.codcli) === cod);
    const nomeCliente = linhaAtual?.cliente || 'Cliente';
    _compHistState = {
        codcli: cod,
        linhaAtual,
        winthorPage: 1,
        winthorLimit: 30
    };

    titulo.textContent = `Histórico do Cliente ${cod}`;
    subtitulo.textContent = nomeCliente;
    meta.innerHTML = '';

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('comp-hist-open');

    if (!_compHistKeydownBound) {
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') fecharHistoricoComparacao();
        });
        _compHistKeydownBound = true;
    }

    carregarHistoricoComparacao();
}

function fecharHistoricoComparacao(ev) {
    if (ev && ev.target && ev.currentTarget && ev.target !== ev.currentTarget) return;
    const modal = document.getElementById('compHistModal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('comp-hist-open');
}

function carregarHistoricoComparacao() {
    const modal = document.getElementById('compHistModal');
    const body = document.getElementById('compHistBody');
    const titulo = document.getElementById('compHistTitulo');
    const subtitulo = document.getElementById('compHistSubtitulo');
    const meta = document.getElementById('compHistMeta');
    const cod = Number(_compHistState?.codcli || 0);
    const linhaAtual = _compHistState?.linhaAtual || null;
    if (!modal || !body || !titulo || !subtitulo || !meta) return;
    if (!Number.isFinite(cod) || cod <= 0) return;

    const requestId = ++_compHistRequestSeq;
    body.innerHTML = `
        <div class="comp-hist-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Carregando histórico...</span>
        </div>`;

    const params = new URLSearchParams({
        winthor_page: String(_compHistState?.winthorPage || 1),
        winthor_limit: String(_compHistState?.winthorLimit || 30)
    });

    fetch(`/api/comparar-carteiras/historico/${cod}?${params.toString()}`)
        .then(async (resp) => {
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || `Erro HTTP ${resp.status}`);
            }
            return resp.json();
        })
        .then((dados) => {
            if (requestId !== _compHistRequestSeq) return;
            if (dados?.paginacao_winthor) {
                _compHistState.winthorPage = Number(dados.paginacao_winthor.page || 1) || 1;
                _compHistState.winthorLimit = Number(dados.paginacao_winthor.limit || 30) || 30;
            }
            renderizarHistoricoComparacaoModal(dados, linhaAtual);
            body.scrollTop = 0;
        })
        .catch((err) => {
            if (requestId !== _compHistRequestSeq) return;
            body.innerHTML = `
                <div class="comp-hist-empty">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>Erro ao carregar histórico: ${escHtmlCompHist(err.message)}</p>
                </div>`;
        });
}

function irPaginaHistoricoComparacao(page) {
    const pagina = Math.trunc(Number(page));
    if (!Number.isFinite(pagina) || pagina <= 0) return;
    if (pagina === Number(_compHistState?.winthorPage || 1)) return;
    _compHistState.winthorPage = pagina;
    carregarHistoricoComparacao();
}

function renderizarHistoricoComparacaoModal(dados, linhaAtual) {
    const body = document.getElementById('compHistBody');
    const titulo = document.getElementById('compHistTitulo');
    const subtitulo = document.getElementById('compHistSubtitulo');
    const meta = document.getElementById('compHistMeta');
    if (!body || !titulo || !subtitulo || !meta) return;

    const eventos = Array.isArray(dados?.eventos) ? dados.eventos : [];
    const eventosCorrecaoCadastro = eventos.filter(
        (ev) => String(ev?.tipo || '').toUpperCase() === 'CORRECAO_CADASTRO_WINTHOR'
    );
    const eventosCamposWinthor = eventos.filter(
        (ev) => String(ev?.tipo || '').toUpperCase() === 'WINTHOR_CAMPO_CLIENTE'
    );
    const eventosGerais = eventos.filter(
        (ev) => {
            const tipo = String(ev?.tipo || '').toUpperCase();
            return tipo !== 'CORRECAO_CADASTRO_WINTHOR' && tipo !== 'WINTHOR_CAMPO_CLIENTE';
        }
    );

    const codcli = Number(dados?.codcli || linhaAtual?.codcli || 0);
    const cliente = dados?.cliente || linhaAtual?.cliente || 'Cliente';
    const resumo = dados?.resumo || {};
    const paginacaoWinthor = dados?.paginacao_winthor || null;

    titulo.textContent = `Histórico do Cliente ${codcli || ''}`.trim();
    subtitulo.textContent = cliente;

    const chips = [
        `<span class="comp-hist-meta-chip"><i class="fas fa-list"></i> ${Number(resumo.total || eventos.length)} eventos</span>`,
        `<span class="comp-hist-meta-chip winthor"><i class="fas fa-database"></i> WinThor: ${Number(resumo.winthor || 0)}</span>`,
        `<span class="comp-hist-meta-chip winthor"><i class="fas fa-clipboard-list"></i> Campos WinThor: ${Number(resumo.winthor_campos || eventosCamposWinthor.length || 0)}</span>`,
        `<span class="comp-hist-meta-chip sistema"><i class="fas fa-robot"></i> Sistema: ${Number(resumo.sistema || 0)}</span>`,
        `<span class="comp-hist-meta-chip snap"><i class="fas fa-camera"></i> Snapshots: ${Number(resumo.snapshots || 0)}</span>`,
        `<span class="comp-hist-meta-chip fix"><i class="fas fa-tools"></i> Correção cadastro: ${eventosCorrecaoCadastro.length}</span>`
    ];
    if (linhaAtual?.situacao) {
        chips.push(`<span class="comp-hist-meta-chip sit"><i class="fas fa-exchange-alt"></i> Situação atual: ${escHtmlCompHist(linhaAtual.situacao)}</span>`);
    }
    meta.innerHTML = chips.join('');

    const blocoDecisaoAtual = renderDecisaoAtualHistorico(linhaAtual);

    const renderSecao = (tituloSecao, descricaoSecao, listaEventos, classeExtra = '') => {
        const headerHtml = `
            <div class="comp-hist-secao-head">
                <h4>${escHtmlCompHist(tituloSecao)}</h4>
                <span>${escHtmlCompHist(descricaoSecao)} (${listaEventos.length})</span>
            </div>`;
        if (!listaEventos.length) {
            return `
                <section class="comp-hist-secao ${classeExtra}">
                    ${headerHtml}
                    <div class="comp-hist-empty comp-hist-empty-inline">
                        <i class="fas fa-inbox"></i>
                        <p>Nenhum registro nesta seção.</p>
                    </div>
                </section>`;
        }
        return `
            <section class="comp-hist-secao ${classeExtra}">
                ${headerHtml}
                <div class="comp-hist-timeline">
                    ${listaEventos.map(renderEventoHistoricoComparacao).join('')}
                </div>
            </section>`;
    };

    if (!eventos.length) {
        body.innerHTML = `
            ${blocoDecisaoAtual}
            <div class="comp-hist-empty">
                <i class="fas fa-history"></i>
                <p>Nenhum evento encontrado para este cliente.</p>
            </div>`;
        return;
    }

    body.innerHTML = `
        ${blocoDecisaoAtual}
        ${renderPaginacaoWinthorCompHist(paginacaoWinthor)}
        ${renderSecao('Movimentações RCA', 'Eventos de comparação sistema x WinThor', eventosGerais)}
        ${renderSecao('Outras Alterações de Cadastro no WinThor', 'Histórico adicional de campos do cliente auditados no PCLOGALTCLI', eventosCamposWinthor)}
        ${renderSecao('Logs de Correção de Cadastro', 'Ajustes da procedure: CODREDE base -> CATEGORIA', eventosCorrecaoCadastro, 'is-fix')}
    `;
}

function renderEventoHistoricoComparacao(ev) {
    const fonte = String(ev?.fonte || '').toUpperCase();
    const tipo = String(ev?.tipo || '').toUpperCase();
    const dt = fmtDataHoraCompHist(ev?.data);

    if (fonte === 'WINTHOR') {
        if (tipo === 'WINTHOR_CAMPO_CLIENTE') {
            const nome = ev.usuario_nome_guerra || ev.usuario_nome || 'Usuário não identificado';
            const campo = fmtCampoCompHist(ev.campo);
            const deTxt = fmtValorRcaCompHist(ev.valor_ant_raw);
            const paraTxt = fmtValorRcaCompHist(ev.valor_atu_raw);
            return `
                <div class="comp-hist-item winthor">
                    <div class="comp-hist-item-head">
                        <span class="comp-hist-item-pill winthor"><i class="fas fa-database"></i> WinThor</span>
                        <span class="comp-hist-item-date">${escHtmlCompHist(dt)}</span>
                    </div>
                    <div class="comp-hist-item-title">Alteração de Cadastro (${escHtmlCompHist(campo)})</div>
                    <div class="comp-hist-item-line"><strong>Campo:</strong> ${escHtmlCompHist(campo)}</div>
                    <div class="comp-hist-item-line"><strong>Valor:</strong> ${escHtmlCompHist(deTxt)} <i class="fas fa-arrow-right"></i> ${escHtmlCompHist(paraTxt)}</div>
                    <div class="comp-hist-item-line"><strong>Usuário:</strong> ${escHtmlCompHist(nome)}${ev.matricula ? ` <span class="comp-hist-inline-chip">Mat. ${ev.matricula}</span>` : ''}</div>
                    ${ev.rotina ? `<div class="comp-hist-item-line muted"><strong>Rotina:</strong> ${escHtmlCompHist(ev.rotina)}</div>` : ''}
                    ${ev.obs ? `<div class="comp-hist-item-line muted"><strong>Obs:</strong> ${escHtmlCompHist(fmtValorRcaCompHist(ev.obs))}</div>` : ''}
                </div>`;
        }

        const nome = ev.usuario_nome_guerra || ev.usuario_nome || 'Usuário não identificado';
        const de = ev.rca_de ?? (ev.valor_ant_raw ?? '-');
        const para = ev.rca_para ?? (ev.valor_atu_raw ?? '-');
        const deTxt = fmtValorRcaCompHist(de);
        const paraTxt = fmtValorRcaCompHist(para);
        return `
            <div class="comp-hist-item winthor">
                <div class="comp-hist-item-head">
                    <span class="comp-hist-item-pill winthor"><i class="fas fa-database"></i> WinThor</span>
                    <span class="comp-hist-item-date">${escHtmlCompHist(dt)}</span>
                </div>
                <div class="comp-hist-item-title">Alteração de RCA (${escHtmlCompHist(ev.campo || 'CODUSUR1')})</div>
                <div class="comp-hist-item-line"><strong>RCA:</strong> ${escHtmlCompHist(deTxt)} <i class="fas fa-arrow-right"></i> ${escHtmlCompHist(paraTxt)}</div>
                <div class="comp-hist-item-line"><strong>Usuário:</strong> ${escHtmlCompHist(nome)}${ev.matricula ? ` <span class="comp-hist-inline-chip">Mat. ${ev.matricula}</span>` : ''}</div>
                ${ev.rotina ? `<div class="comp-hist-item-line muted"><strong>Rotina:</strong> ${escHtmlCompHist(ev.rotina)}</div>` : ''}
            </div>`;
    }

    if (fonte === 'SISTEMA' && tipo === 'CORRECAO_CADASTRO_WINTHOR') {
        const origem = ev.origem_sistema || 'PROC_WINT_CORR_CADASTRO';
        const ambiente = ev.ambiente || 'N/A';
        const execId = ev.exec_id || null;
        const payload = ev.payload || null;
        const bitrixMeta = metaBitrixSyncCompFix(ev);
        const regra = payload?.regra || 'CODREDE_GERA_CATEGORIA';
        const codredeRef = payload?.codrede_referencia ?? ev.codrede_novo ?? ev.codrede_ant ?? null;
        const mudouCategoria = (ev.categoria_ant ?? null) !== (ev.categoria_nova ?? null);
        const mudouAtv = (ev.codatv1_ant ?? null) !== (ev.codatv1_novo ?? null);
        const mudouRede = (ev.codrede_ant ?? null) !== (ev.codrede_novo ?? null);
        return `
            <div class="comp-hist-item sistema">
                <div class="comp-hist-item-head">
                    <span class="comp-hist-item-pill sistema"><i class="fas fa-tools"></i> Sistema (Correção Cadastro)</span>
                    <span class="comp-hist-item-date">${escHtmlCompHist(dt)}</span>
                </div>
                <div class="comp-hist-item-title">Correção automática aplicada no WinThor</div>
                ${mudouCategoria ? `<div class="comp-hist-item-line"><strong>CATEGORIA:</strong> ${escHtmlCompHist(ev.categoria_ant ?? '-')} <i class="fas fa-arrow-right"></i> ${escHtmlCompHist(ev.categoria_nova ?? '-')}</div>` : ''}
                ${mudouAtv ? `<div class="comp-hist-item-line"><strong>CODATV1:</strong> ${escHtmlCompHist(ev.codatv1_ant ?? '-')} <i class="fas fa-arrow-right"></i> ${escHtmlCompHist(ev.codatv1_novo ?? '-')}</div>` : ''}
                ${mudouRede ? `<div class="comp-hist-item-line"><strong>CODREDE:</strong> ${escHtmlCompHist(ev.codrede_ant ?? '-')} <i class="fas fa-arrow-right"></i> ${escHtmlCompHist(ev.codrede_novo ?? '-')}</div>` : ''}
                ${codredeRef != null ? `<div class="comp-hist-item-line"><strong>Base CODREDE:</strong> ${escHtmlCompHist(codredeRef)}</div>` : ''}
                ${bitrixMeta ? `<div class="comp-hist-item-line"><strong>Bitrix:</strong> ${escHtmlCompHist(bitrixMeta.label)}${bitrixMeta.resumo ? ` <span class="comp-hist-inline-chip">${escHtmlCompHist(bitrixMeta.resumo)}</span>` : ''}</div>` : ''}
                ${bitrixMeta?.erro ? `<div class="comp-hist-item-line muted"><strong>Erro Bitrix:</strong> ${escHtmlCompHist(bitrixMeta.erro)}</div>` : ''}
                <div class="comp-hist-item-line muted"><strong>Regra:</strong> ${escHtmlCompHist(regra)}</div>
                <div class="comp-hist-item-line"><strong>Origem:</strong> ${escHtmlCompHist(origem)}</div>
                <div class="comp-hist-item-line muted"><strong>Ambiente:</strong> ${escHtmlCompHist(ambiente)}${execId ? ` <span class="comp-hist-inline-chip">Exec ${escHtmlCompHist(execId)}</span>` : ''}</div>
            </div>`;
    }

    if (fonte === 'SISTEMA') {
        const de = ev.rca_de ?? '-';
        const para = ev.rca_para ?? '-';
        const origem = ev.origem_sistema || 'SISTEMA';
        return `
            <div class="comp-hist-item sistema">
                <div class="comp-hist-item-head">
                    <span class="comp-hist-item-pill sistema"><i class="fas fa-robot"></i> Sistema</span>
                    <span class="comp-hist-item-date">${escHtmlCompHist(dt)}</span>
                </div>
                <div class="comp-hist-item-title">Movimentação registrada no sistema</div>
                <div class="comp-hist-item-line"><strong>RCA:</strong> ${escHtmlCompHist(de)} <i class="fas fa-arrow-right"></i> ${escHtmlCompHist(para)}</div>
                <div class="comp-hist-item-line"><strong>Origem:</strong> ${escHtmlCompHist(origem)}</div>
                ${ev.dias_sem_compra != null ? `<div class="comp-hist-item-line muted"><strong>Dias s/ compra:</strong> ${escHtmlCompHist(ev.dias_sem_compra)}</div>` : ''}
            </div>`;
    }

    if (fonte === 'SNAPSHOT' || tipo === 'SNAPSHOT_CRON') {
        return `
            <div class="comp-hist-item snapshot">
                <div class="comp-hist-item-head">
                    <span class="comp-hist-item-pill snapshot"><i class="fas fa-camera"></i> Snapshot do cron</span>
                    <span class="comp-hist-item-date">${escHtmlCompHist(dt)}</span>
                </div>
                <div class="comp-hist-item-title">Estado salvo em relatorio_carteira</div>
                <div class="comp-hist-item-line"><strong>RCA:</strong> ${escHtmlCompHist(ev.rca_snapshot ?? '-')} ${ev.rca_nome ? `<small class="text-muted">${escHtmlCompHist(ev.rca_nome)}</small>` : ''}</div>
                <div class="comp-hist-item-line muted"><strong>Nivel/Status:</strong> ${escHtmlCompHist(ev.nivel || '-')} / ${escHtmlCompHist(ev.status_situacao || '-')}</div>
            </div>`;
    }

    return `
        <div class="comp-hist-item">
            <div class="comp-hist-item-head">
                <span class="comp-hist-item-pill"><i class="fas fa-history"></i> Evento</span>
                <span class="comp-hist-item-date">${escHtmlCompHist(dt)}</span>
            </div>
            <div class="comp-hist-item-title">${escHtmlCompHist(tipo || fonte || 'Evento')}</div>
        </div>`;
}

function nivelBadgeClass(nivel) {
    const m = { 'DIAMANTE': 'purple', 'PLATINUM': 'blue', 'OURO': 'yellow', 'PRATA': 'green', 'BRONZE': 'yellow' };
    return m[nivel] || 'green';
}

function statusBadgeClass(status) {
    if (status === 'ATIVO')  return 'bg-green';
    if (status === 'ALERTA') return 'bg-yellow';
    if (status === 'RISCO')  return 'bg-red';
    return '';
}


// ===========================
// BADGES DAS ABAS (AUTO-UPDATE)
// ===========================
function atualizarBadges() {
    const resumo = _dashboardGestorInicial?.resumo || {};
    atualizarBadgeComValor('badge-tab1', document.querySelectorAll('#tableVisaoGeral tbody tr').length);

    Object.entries(TABS_PAGINADAS).forEach(([tabName, cfg]) => {
        const estado = ESTADO_TABS_PAGINADAS[tabName];
        const fallbackKey = {
            tab2: 'movimentacoes_total',
            tab3: 'longo_prazo_total',
            tab4: 'reclassificacoes_total',
            tab5: 'protecoes_total',
            tab6: 'bitrix_total'
        }[tabName];
        const valor = estado?.loaded ? estado.total : Number(resumo?.[fallbackKey] || 0);
        atualizarBadgeComValor(cfg.badgeId, valor);
    });

    const badge8Valor = _tab8Carregada
        ? document.querySelectorAll('#tbodySubstituicoes tr').length
        : Number(resumo?.substituicoes_total || 0);
    atualizarBadgeComValor('badge-tab8', badge8Valor);
}

const _obs = new MutationObserver(() => {
    const mc = document.getElementById('mainContent');
    if (mc && mc.style.display !== 'none') {
        setTimeout(atualizarBadges, 300);
        _obs.disconnect();
    }
});

const _mc = document.getElementById('mainContent');
if (_mc) _obs.observe(_mc, { attributes: true, attributeFilter: ['style'] });


// ===========================
// EXPORTAR EXCEL
// ===========================
async function exportarExcel() {
    const btn = document.getElementById('btnExportExcel');
    const originalText = btn.innerHTML;

    try {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando...';
        btn.disabled = true;

        const response = await fetch('/api/exportar-gestores-excel');
        if (!response.ok) throw new Error('Erro na geracao do arquivo');

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Relatorio_Gestor_${new Date().toISOString().split('T')[0]}.xlsx`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

    } catch (error) {
        alert('Erro ao exportar Excel: ' + error.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}


// ===========================
// FAVICON REDONDO AUTOMATICO
// ===========================
(function makeFaviconCircular() {
    const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.type = 'image/png';
    link.rel = 'icon';
    document.head.appendChild(link);

    const img = new Image();
    img.src = 'img/logo.png';

    img.onload = function () {
        const canvas = document.createElement('canvas');
        const size = 64;
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, 2 * Math.PI);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, 0, 0, size, size);

        link.href = canvas.toDataURL();
    };
})();


// ============================================================================
// FILTROS GENERICOS POR ABA (busca no DOM renderizado)
// ============================================================================

/**
 * Filtro generico que esconde/mostra linhas da tabela por texto.
 * Atualiza o contador de resultados.
 */
function filtroGenericoTabela(inputId, tbodySelector, counterId, extraFilter) {
    const texto = (document.getElementById(inputId)?.value || '').toLowerCase().trim();
    const tbody = document.querySelector(tbodySelector);
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    let total = rows.length;
    let visiveis = 0;

    rows.forEach(row => {
        const conteudo = row.textContent.toLowerCase();
        const passaTexto = !texto || conteudo.includes(texto);
        const passaExtra = !extraFilter || extraFilter(row);
        const visivel = passaTexto && passaExtra;
        row.style.display = visivel ? '' : 'none';
        if (visivel) visiveis++;
    });

    const counter = document.getElementById(counterId);
    if (counter) {
        if (texto || (extraFilter && visiveis !== total)) {
            counter.textContent = `Exibindo ${visiveis} de ${total}`;
            counter.classList.add('has-filter');
        } else {
            counter.textContent = `${total} registro(s)`;
            counter.classList.remove('has-filter');
        }
    }
}

function parseFiltroCodigos(rawValue) {
    const bruto = String(rawValue || '').trim();
    if (!bruto) return { modoCodigos: false, codigos: [], texto: '' };

    const partes = bruto
        .split(/[\s,;\r\n\t]+/g)
        .map((p) => p.trim())
        .filter(Boolean);

    const somenteNumeros = partes.length > 0 && partes.every((p) => /^\d+$/.test(p));
    if (!somenteNumeros) {
        return { modoCodigos: false, codigos: [], texto: bruto.toLowerCase() };
    }

    const codigos = [...new Set(
        partes
            .map((p) => Number(p))
            .filter((n) => Number.isFinite(n) && n > 0)
    )];

    return { modoCodigos: true, codigos, texto: '' };
}

function extrairCodcliLinhaMov(row) {
    const codAttr = Number(row?.dataset?.codcli);
    if (Number.isFinite(codAttr) && codAttr > 0) return codAttr;

    const strong = row?.querySelector('td:nth-child(2) strong');
    const fallback = strong?.textContent || row?.querySelectorAll('td')?.[1]?.textContent || '';
    const match = String(fallback).match(/\d+/);
    const cod = match ? Number(match[0]) : NaN;
    return Number.isFinite(cod) && cod > 0 ? cod : null;
}

// -- Tab 1: Visao Geral --
function filtrarTab1() {
    filtroGenericoTabela('filtroTab1', '#tableVisaoGeral tbody', 'counterTab1');
}

// -- Tab 2: Movimentacoes --
function filtrarTab2() {
    agendarCargaTabPaginada('tab2', { resetPage: true, delay: 220 });
}

// -- Tab 3: Longo Prazo --
function filtrarTab3() {
    agendarCargaTabPaginada('tab3', { resetPage: true, delay: 220 });
}

// -- Tab 4: Reclassificacoes --
function filtrarTab4() {
    agendarCargaTabPaginada('tab4', { resetPage: true, delay: 220 });
}

// -- Tab 5: Protecoes --
function filtrarTab5() {
    agendarCargaTabPaginada('tab5', { resetPage: true, delay: 220 });
}

// -- Tab 6: Bitrix --
function filtrarTab6() {
    agendarCargaTabPaginada('tab6', { resetPage: true, delay: 220 });
}

// -- Inicializar contadores apos dados carregarem --
function inicializarContadores() {
    setTimeout(() => {
        const totalTab1 = document.querySelectorAll('#tableVisaoGeral tbody tr').length;
        const counter1 = document.getElementById('counterTab1');
        if (counter1) {
            counter1.textContent = `${totalTab1} vendedor(es)`;
            counter1.classList.remove('has-filter');
        }

        Object.keys(TABS_PAGINADAS).forEach((tabName) => {
            atualizarContadorTabPaginada(tabName);
            atualizarPaginacaoTabPaginada(tabName);
        });
    }, 180);
}

// Atualizar o observer para tambem inicializar contadores
const _obsContadores = new MutationObserver(() => {
    const mc = document.getElementById('mainContent');
    if (mc && mc.style.display !== 'none') {
        setTimeout(() => {
            atualizarBadges();
            inicializarContadores();
        }, 300);
        _obsContadores.disconnect();
    }
});

const _mcContadores = document.getElementById('mainContent');
if (_mcContadores) _obsContadores.observe(_mcContadores, { attributes: true, attributeFilter: ['style'] });



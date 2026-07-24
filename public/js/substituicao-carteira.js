// substituicao-carteira.js — Safra DS v3.1

let carteiraAtual = [];
let clientesSelecionados = [];
let novosClientesSugeridos = [];
let rcaSelecionado = null;
let rcaNomeSelecionado = '';

// Seleção congelada entre passos 2→3
let _selecaoCongelada = null;

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    carregarRCAsDisponiveis();
    initEventListeners();
});

// ==================== INICIALIZAÇÃO ====================
function initEventListeners() {
    // Passo 1
    document.getElementById('btnCarregarCarteira').addEventListener('click', carregarCarteira);

    // Passo 2
    document.getElementById('checkAll').addEventListener('change', toggleSelectAll);
    document.getElementById('btnSelecionarTodos').addEventListener('click', selecionarTodos);
    document.getElementById('btnLimparSelecao').addEventListener('click', limparSelecao);
    document.getElementById('searchCliente').addEventListener('input', filtrarClientes);
    document.getElementById('btnProcessarSubstituicao').addEventListener('click', processarSubstituicao);
    document.getElementById('btnTransferirParaRca118').addEventListener('click', transferirParaRca118);
    document.getElementById('btnVoltarPasso1').addEventListener('click', () => navegarPara(1));

    // Passo 3
    document.getElementById('btnVoltar').addEventListener('click', voltarParaSelecao);
    document.getElementById('btnConfirmarSubstituicao').addEventListener('click', confirmarSubstituicao);

    // Passo 4
    document.getElementById('btnNovaSubstituicao').addEventListener('click', novaSubstituicao);
}

// ==================== NAVEGAÇÃO POR PASSOS ====================
function navegarPara(stepNum) {
    // Esconde todos os painéis
    document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));

    // Mostra o painel alvo
    const alvo = document.getElementById('step' + stepNum);
    if (alvo) alvo.classList.add('active');

    // Atualiza o stepper visual
    atualizarStepper(stepNum);

    // Scroll para o topo
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function atualizarStepper(stepAtual) {
    const steps = document.querySelectorAll('.stepper-step');
    const lines = document.querySelectorAll('.stepper-line');

    steps.forEach((el, i) => {
        const num = i + 1;
        el.classList.remove('active', 'done');
        if (num < stepAtual)        el.classList.add('done');
        else if (num === stepAtual) el.classList.add('active');
    });

    lines.forEach((el, i) => {
        el.classList.remove('done');
        if (i + 1 < stepAtual) el.classList.add('done');
    });
}

// ==================== DROPDOWN CUSTOMIZADO DE RCAs ====================

let _rcasData = [];

function initCustomSelect() {
    const wrapper = document.getElementById('rcaDropdownWrapper');
    const trigger = document.getElementById('rcaDropdownTrigger');
    const search  = document.getElementById('rcaSearch');

    if (!wrapper || !trigger || !search) return;

    trigger.addEventListener('click', () => {
        wrapper.classList.contains('open') ? _fecharDropdown() : _abrirDropdown();
    });

    search.addEventListener('input', () => {
        _renderRcaList(_rcasData, search.value.trim());
    });

    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) _fecharDropdown();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _fecharDropdown();
    });
}

function _abrirDropdown() {
    const wrapper = document.getElementById('rcaDropdownWrapper');
    const search  = document.getElementById('rcaSearch');
    if (!wrapper) return;
    wrapper.classList.add('open');
    setTimeout(() => search && search.focus(), 60);
}

function _fecharDropdown() {
    const wrapper = document.getElementById('rcaDropdownWrapper');
    const search  = document.getElementById('rcaSearch');
    if (!wrapper) return;
    wrapper.classList.remove('open');
    if (search) search.value = '';
    _renderRcaList(_rcasData, '');
}

function _renderRcaList(rcas, filtro) {
    const list = document.getElementById('rcaList');
    if (!list) return;
    const termo = filtro.toLowerCase();

    const filtrados = termo
        ? rcas.filter(r =>
            String(r.codusur).includes(termo) ||
            (r.nome || '').toLowerCase().includes(termo)
          )
        : rcas;

    if (filtrados.length === 0) {
        list.innerHTML = `<li class="cs-empty"><i class="fas fa-search" style="margin-right:6px"></i>Nenhum vendedor encontrado</li>`;
        return;
    }

    list.innerHTML = filtrados.map(rca => {
        const ocupacao   = parseFloat(rca.ocupacao) || 0;
        const barColor   = ocupacao > 100 ? '#ef4444' : ocupacao > 80 ? '#f59e0b' : '#10b981';
        const barWidth   = Math.min(ocupacao, 100);
        const isSelected = rcaSelecionado == rca.codusur;

        return `
            <li class="cs-item ${isSelected ? 'selected' : ''}" data-value="${rca.codusur}" data-nome="${rca.nome}">
                <span class="cs-rca-code">${rca.codusur}</span>
                <div class="cs-item-body">
                    <div class="cs-rca-name">${rca.nome}</div>
                    <div class="cs-item-sub">
                        <span>
                            <span class="cs-ocupacao-bar">
                                <span class="cs-ocupacao-fill" style="width:${barWidth}%; background:${barColor}"></span>
                            </span>
                            ${rca.totalClientes} clientes &mdash; ${ocupacao}%
                        </span>
                    </div>
                </div>
            </li>
        `;
    }).join('');

    list.querySelectorAll('.cs-item').forEach(item => {
        item.addEventListener('click', () => {
            _selecionarRca(item.dataset.value, item.dataset.nome,
                _rcasData.find(r => r.codusur == item.dataset.value));
        });
    });
}

function _selecionarRca(value, nome, rca) {
    rcaSelecionado = value;
    rcaNomeSelecionado = nome;

    const textEl   = document.getElementById('rcaSelectedText');
    const ocupacao = rca ? parseFloat(rca.ocupacao) || 0 : 0;
    const clientes = rca ? rca.totalClientes : 0;

    if (textEl) {
        textEl.classList.remove('placeholder');
        textEl.innerHTML = `
            <span class="cs-rca-code">${value}</span>
            <span class="cs-rca-name">${nome}</span>
            <span class="cs-rca-info">${clientes} clientes &middot; ${ocupacao}%</span>
        `;
    }

    _fecharDropdown();
}

// ==================== CARREGAR RCAs DO BANCO ====================
async function carregarRCAsDisponiveis() {
    const textEl = document.getElementById('rcaSelectedText');

    try {
        showLoading('Carregando vendedores disponíveis...');

        const response = await fetch('/api/listar-rcas-disponiveis');
        const data = await response.json();

        if (!data.success) throw new Error(data.error || 'Erro ao carregar vendedores');

        _rcasData = data.rcas;

        if (textEl) {
            textEl.classList.add('placeholder');
            textEl.innerHTML = `<i class="fas fa-user-tie" style="color:var(--text-muted)"></i> Selecione um vendedor...`;
        }

        _renderRcaList(_rcasData, '');
        initCustomSelect();

        hideLoading();

    } catch (error) {
        console.error('Erro ao carregar RCAs:', error);
        if (textEl) {
            textEl.innerHTML = `<i class="fas fa-exclamation-circle" style="color:var(--danger)"></i> Erro ao carregar`;
        }
        hideLoading();
        showError('Não foi possível carregar a lista de vendedores. Verifique sua conexão e tente novamente.\n\n' + error.message, 'Erro ao carregar vendedores');
    }
}

// ==================== PASSO 1: CARREGAR CARTEIRA ====================
async function carregarCarteira() {
    if (!rcaSelecionado) {
        showError('Por favor, selecione um vendedor (RCA) antes de continuar.', 'Nenhum vendedor selecionado');
        return;
    }

    showLoading('Carregando carteira do vendedor...');

    try {
        const response = await fetch(`/api/substituicao/carteira-atual/${rcaSelecionado}`);
        const data = await response.json();

        if (!data.success) throw new Error(data.error || 'Erro ao carregar carteira');

        carteiraAtual = data.data;
        clientesSelecionados = [];
        _selecaoCongelada = null;

        renderCarteira(carteiraAtual);

        // Atualiza contexto do Passo 2
        const ctxNome = document.getElementById('ctxRcaNome');
        const ctxCodigo = document.getElementById('ctxRcaCodigo');
        if (ctxNome) ctxNome.textContent = rcaNomeSelecionado;
        if (ctxCodigo) ctxCodigo.textContent = rcaSelecionado;

        // Navega para Passo 2
        navegarPara(2);

    } catch (error) {
        showError('Não foi possível carregar a carteira do vendedor selecionado.\n\n' + error.message, 'Erro ao carregar carteira');
    } finally {
        hideLoading();
    }
}

// ==================== RENDER CARTEIRA ====================
function renderCarteira(clientes) {
    const tbody = document.getElementById('clientesBody');
    tbody.innerHTML = '';

    if (clientes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;">Nenhum cliente encontrado</td></tr>';
        return;
    }

    const selecionadosSet = new Set(clientesSelecionados.map(c => c.codcli));

    clientes.forEach(cliente => {
        const tr = document.createElement('tr');
        tr.dataset.codcli = cliente.codcli;

        const classificacao = cliente.classificacao_atual || 'BRONZE';
        const dias = cliente.dias_sem_compra || 0;
        let badgeClass = 'bg-green';
        if (dias > 30) badgeClass = 'bg-yellow';
        if (dias > 60) badgeClass = 'bg-red';

        const dataUltima = cliente.data_ultimo_pedido
            ? new Date(cliente.data_ultimo_pedido).toLocaleDateString('pt-BR')
            : '-';

        const isChecked = selecionadosSet.has(cliente.codcli) ? 'checked' : '';

        tr.innerHTML = `
            <td><input type="checkbox" class="cliente-checkbox" data-codcli="${cliente.codcli}" ${isChecked}></td>
            <td><strong>${cliente.codcli}</strong></td>
            <td>${cliente.cliente}</td>
            <td><span class="badge bg-blue">${classificacao}</span></td>
            <td><span class="badge ${badgeClass}">${dias} dias</span></td>
            <td>${dataUltima}</td>
        `;

        tbody.appendChild(tr);
    });

    document.querySelectorAll('.cliente-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', atualizarSelecao);
    });

    atualizarContadores();
}

// ==================== SELEÇÃO DE CLIENTES ====================
function toggleSelectAll(e) {
    document.querySelectorAll('.cliente-checkbox').forEach(cb => {
        cb.checked = e.target.checked;
    });
    atualizarSelecao();
}

function selecionarTodos() {
    document.getElementById('checkAll').checked = true;
    toggleSelectAll({ target: { checked: true } });
}

function limparSelecao() {
    document.getElementById('checkAll').checked = false;
    toggleSelectAll({ target: { checked: false } });
}

function atualizarSelecao() {
    const checkboxes = document.querySelectorAll('.cliente-checkbox:checked');
    clientesSelecionados = Array.from(checkboxes).map(cb => {
        const codcli = parseInt(cb.dataset.codcli);
        return carteiraAtual.find(c => c.codcli === codcli);
    }).filter(Boolean);

    atualizarContadores();

    document.getElementById('btnProcessarSubstituicao').disabled = clientesSelecionados.length === 0;
    document.getElementById('btnTransferirParaRca118').disabled = clientesSelecionados.length === 0;
}

function atualizarContadores() {
    const total = carteiraAtual.length;
    const selecionados = clientesSelecionados.length;
    document.getElementById('totalCarteira').textContent = total;
    document.getElementById('totalSelecionados').textContent = selecionados;
    document.getElementById('totalPermanece').textContent = total - selecionados;
}

function filtrarClientes() {
    const input = document.getElementById('searchCliente').value;
    const termo = input.toLowerCase().trim();
    const codigosExtraidos = input.match(/\d+/g);

    let clientesFiltrados;

    if (codigosExtraidos && codigosExtraidos.length > 1) {
        const setCodigos = new Set(codigosExtraidos);
        clientesFiltrados = carteiraAtual.filter(c => setCodigos.has(String(c.codcli)));
    } else if (!termo) {
        clientesFiltrados = carteiraAtual;
    } else {
        clientesFiltrados = carteiraAtual.filter(c => {
            const cod = String(c.codcli).toLowerCase();
            const nome = (c.cliente || '').toLowerCase();
            const fantasia = (c.fantasia || '').toLowerCase();
            return cod.includes(termo) || nome.includes(termo) || fantasia.includes(termo);
        });
    }

    renderCarteira(clientesFiltrados);
}

// ==================== PASSO 2: TRANSFERIR DIRETO PARA RCA 118 ====================
async function transferirParaRca118() {
    if (clientesSelecionados.length === 0) {
        showError('Selecione pelo menos um cliente antes de transferir.', 'Nenhum cliente selecionado');
        return;
    }

    const confirmado = await showConfirm({
        titulo: 'Transferir para RCA 118',
        mensagem: `Você está prestes a enviar ${clientesSelecionados.length} cliente(s) diretamente para o RCA 118 (Longo Prazo).`,
        detalhe: '⚠️ Nenhum cliente novo será adicionado à carteira. Esta ação não pode ser desfeita.',
        tipo: 'danger',
        txtConfirmar: 'Sim, transferir',
        txtCancelar: 'Cancelar'
    });

    if (!confirmado) return;

    showLoading(`Transferindo ${clientesSelecionados.length} cliente(s) para o RCA 118...`);

    try {
        const response = await fetch('/api/transferir-para-118', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rcaAtual: rcaSelecionado,
                clientesRemover: clientesSelecionados.map(c => c.codcli)
            })
        });

        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'Erro ao transferir clientes');

        const div = document.getElementById('resultadoSumario');
        div.innerHTML = `
            <div style="background: var(--bg-main); padding: 2rem; border-radius: 8px; margin: 2rem 0;">
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 2rem; text-align: center;">
                    <div>
                        <div style="font-size: 2rem; font-weight: 700; color: var(--danger);">${data.removidos || 0}</div>
                        <div style="color: var(--text-muted); margin-top: 0.5rem;">Transferidos para RCA 118</div>
                    </div>
                    <div>
                        <div style="font-size: 2rem; font-weight: 700; color: var(--primary);">${data.totalAtual || 0}</div>
                        <div style="color: var(--text-muted); margin-top: 0.5rem;">Clientes Restantes</div>
                    </div>
                </div>
            </div>
        `;

        navegarPara(4);

    } catch (error) {
        showError('Ocorreu um erro ao transferir os clientes para o RCA 118.\n\n' + error.message, 'Erro na transferência');
    } finally {
        hideLoading();
    }
}

// ==================== PASSO 2: PROCESSAR SUBSTITUIÇÃO ====================
async function processarSubstituicao() {
    if (clientesSelecionados.length === 0) {
        showError('Selecione pelo menos um cliente para processar a substituição.', 'Nenhum cliente selecionado');
        return;
    }

    showLoading('Buscando clientes compatíveis no RCA 118...');

    try {
        _selecaoCongelada = clientesSelecionados.map(c => ({ ...c }));
        console.log('[Substituição] Seleção congelada:', _selecaoCongelada.map(c => c.codcli));

        const distribuicaoSolicitada = analisarDistribuicao(_selecaoCongelada);

        const response = await fetch('/api/buscar-clientes-compativeis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rcaAtual: rcaSelecionado,
                clientesRemover: _selecaoCongelada.map(c => c.codcli),
                distribuicaoDesejada: distribuicaoSolicitada,
                quantidade: _selecaoCongelada.length
            })
        });

        const data = await response.json();

        if (!data.success) {
            _selecaoCongelada = null;
            throw new Error(data.error || 'Erro ao buscar clientes');
        }

        novosClientesSugeridos = data.novosClientes;

        // Detecção de repescagem
        let houveRepescagem = false;
        ['DIAMANTE', 'PLATINUM', 'OURO', 'PRATA', 'BRONZE'].forEach(nivel => {
            if ((distribuicaoSolicitada[nivel] || 0) > (data.distribuicaoNovos[nivel] || 0)) {
                houveRepescagem = true;
            }
        });

        const avisoEl = document.getElementById('repescagemAviso');
        if (avisoEl) avisoEl.classList.toggle('hidden', !houveRepescagem);

        renderAnalise(distribuicaoSolicitada, data.distribuicaoNovos);
        renderNovosClientes(novosClientesSugeridos);

        // Atualiza contexto do Passo 3
        const ctxRca3 = document.getElementById('ctxRca3');
        const ctxQtd = document.getElementById('ctxQtdRemover');
        if (ctxRca3) ctxRca3.textContent = `${rcaSelecionado} — ${rcaNomeSelecionado}`;
        if (ctxQtd) ctxQtd.textContent = _selecaoCongelada.length;

        navegarPara(3);

    } catch (error) {
        _selecaoCongelada = null;
        showError('Não foi possível buscar clientes compatíveis.\n\n' + error.message, 'Erro ao processar substituição');
    } finally {
        hideLoading();
    }
}

function analisarDistribuicao(clientes) {
    const dist = { DIAMANTE: 0, PLATINUM: 0, OURO: 0, PRATA: 0, BRONZE: 0, OUTROS: 0 };
    clientes.forEach(c => {
        const nivel = (c.classificacao_atual || 'OUTROS').toUpperCase();
        if (dist[nivel] !== undefined) dist[nivel]++;
        else dist.OUTROS++;
    });
    return dist;
}

function renderAnalise(distribuicaoRemover, distribuicaoNovos) {
    const divRemover = document.getElementById('distribuicaoRemover');
    const divNovos = document.getElementById('distribuicaoNovos');

    const listaRemocao = (_selecaoCongelada || clientesSelecionados);
    let htmlRemover = renderDistribuicaoHTML(distribuicaoRemover);
    htmlRemover += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-subtle);font-size:.78rem;color:var(--text-tertiary);max-height:120px;overflow-y:auto;">`;
    htmlRemover += `<strong style="color:var(--text-secondary);">CODCLIs:</strong> `;
    htmlRemover += listaRemocao.map(c => `<span style="font-weight:600;">${c.codcli}</span>`).join(', ');
    htmlRemover += `</div>`;

    divRemover.innerHTML = htmlRemover;
    divNovos.innerHTML = renderDistribuicaoHTML(distribuicaoNovos);
}

function renderDistribuicaoHTML(distribuicao) {
    let html = '<div style="display: flex; flex-direction: column; gap: 0.75rem;">';
    ['DIAMANTE', 'PLATINUM', 'OURO', 'PRATA', 'BRONZE', 'OUTROS'].forEach(nivel => {
        const qtd = distribuicao[nivel] || 0;
        if (qtd > 0) {
            html += `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 600;">${nivel}:</span>
                    <span class="badge bg-blue">${qtd}</span>
                </div>
            `;
        }
    });
    html += '</div>';
    return html;
}

function renderNovosClientes(clientes) {
    const tbody = document.getElementById('novosClientesBody');
    tbody.innerHTML = '';

    if (clientes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;">Nenhum cliente compatível encontrado</td></tr>';
        return;
    }

    clientes.forEach(cliente => {
        const tr = document.createElement('tr');
        const dataUltima = cliente.DTULTCOMP
            ? new Date(cliente.DTULTCOMP).toLocaleDateString('pt-BR')
            : '-';

        tr.innerHTML = `
            <td><strong>${cliente.CODCLI}</strong></td>
            <td>${cliente.CLIENTE}</td>
            <td><span class="badge bg-blue">${cliente.CATEGORIA || 'BRONZE'}</span></td>
            <td>${cliente.CIDADE || '-'}</td>
            <td>${dataUltima}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ==================== PASSO 3: VOLTAR ====================
function voltarParaSelecao() {
    _selecaoCongelada = null;
    navegarPara(2);
}

// ==================== PASSO 3: CONFIRMAR SUBSTITUIÇÃO ====================
async function confirmarSubstituicao() {
    const selecaoFinal = _selecaoCongelada || clientesSelecionados;

    const confirmado = await showConfirm({
        titulo: 'Confirmar Substituição',
        mensagem: `Serão substituídos ${selecaoFinal.length} cliente(s) da carteira do RCA ${rcaSelecionado}.`,
        detalhe: `Clientes que SAIRÃO: [${selecaoFinal.map(c => c.codcli).join(', ')}]\nClientes que ENTRARÃO: [${novosClientesSugeridos.map(c => c.CODCLI).join(', ')}]\n\nOs removidos irão para o RCA 118. Esta ação não pode ser desfeita.`,
        tipo: 'warning',
        txtConfirmar: 'Confirmar',
        txtCancelar: 'Cancelar'
    });
    if (!confirmado) return;

    showLoading('Processando substituição...');

    try {
        const codclisRemover = selecaoFinal.map(c => c.codcli);
        const codclisAdicionar = novosClientesSugeridos.map(c => c.CODCLI);

        console.log('[Substituição] ENVIANDO:', { codclisRemover, codclisAdicionar });

        const response = await fetch('/api/executar-substituicao', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rcaAtual: rcaSelecionado,
                clientesRemover: codclisRemover,
                clientesAdicionar: codclisAdicionar
            })
        });

        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'Erro ao executar substituição');

        renderResultado(data);
        _selecaoCongelada = null;
        navegarPara(4);

    } catch (error) {
        showError('Não foi possível concluir a substituição. Tente novamente.\n\n' + error.message, 'Erro ao confirmar substituição');
    } finally {
        hideLoading();
    }
}

function renderResultado(data) {
    document.getElementById('resultadoSumario').innerHTML = `
        <div style="background: var(--bg-main); padding: 2rem; border-radius: 8px; margin: 2rem 0;">
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 2rem; text-align: center;">
                <div>
                    <div style="font-size: 2rem; font-weight: 700; color: var(--danger);">${data.removidos || 0}</div>
                    <div style="color: var(--text-muted); margin-top: 0.5rem;">Clientes Removidos</div>
                </div>
                <div>
                    <div style="font-size: 2rem; font-weight: 700; color: var(--success);">${data.adicionados || 0}</div>
                    <div style="color: var(--text-muted); margin-top: 0.5rem;">Clientes Adicionados</div>
                </div>
                <div>
                    <div style="font-size: 2rem; font-weight: 700; color: var(--primary);">${data.totalAtual || 0}</div>
                    <div style="color: var(--text-muted); margin-top: 0.5rem;">Total na Carteira</div>
                </div>
            </div>
        </div>
    `;
}

function novaSubstituicao() {
    window.location.reload();
}

// ==================== TEMA ====================
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

    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn && !themeBtn.dataset.themeBound) {
        themeBtn.addEventListener('click', () => {
            const isLight = document.body.classList.contains('light');
            const nextTheme = isLight ? 'default' : 'light';

            const resolvedNextTheme = nextTheme === 'light' ? 'light' : 'dark';
            document.body.classList.remove('dark', 'light');
            document.body.classList.add(resolvedNextTheme);
            document.body.dataset.theme = resolvedNextTheme;
            document.documentElement.dataset.theme = resolvedNextTheme;
            document.documentElement.style.colorScheme = resolvedNextTheme;
            localStorage.setItem('theme', nextTheme);
            updateThemeIcon();
        });
        themeBtn.dataset.themeBound = '1';
    }
}

function updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.innerHTML = document.body.classList.contains('light')
        ? '<i class="fas fa-moon"></i>'
        : '<i class="fas fa-sun"></i>';
}

// ==================== UTILITIES ====================
function showLoading(message = 'Processando...') {
    document.getElementById('loadingMessage').textContent = message;
    document.getElementById('loading').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
}

// ==================== MODAL SYSTEM ====================
function showError(mensagem, titulo = 'Atenção') {
    const overlay  = document.getElementById('modalErro');
    const tituloEl = document.getElementById('modalErroTitulo');
    const msgEl    = document.getElementById('modalErroMensagem');
    const btnOk    = document.getElementById('modalErroBtnOk');

    tituloEl.textContent = titulo;
    msgEl.textContent    = mensagem;
    _abrirModal(overlay);

    return new Promise(resolve => {
        const fechar = () => { _fecharModal(overlay); btnOk.removeEventListener('click', fechar); overlay.removeEventListener('click', fecharFora); resolve(); };
        const fecharFora = (e) => { if (e.target === overlay) fechar(); };
        btnOk.addEventListener('click', fechar);
        overlay.addEventListener('click', fecharFora);
    });
}

function showConfirm({ titulo, mensagem, detalhe = null, tipo = 'warning', txtConfirmar = 'Confirmar', txtCancelar = 'Cancelar' }) {
    const overlay    = document.getElementById('modalConfirm');
    const tituloEl   = document.getElementById('modalConfirmTitulo');
    const msgEl      = document.getElementById('modalConfirmMensagem');
    const detalheEl  = document.getElementById('modalConfirmDetalhe');
    const iconeDiv   = document.getElementById('modalConfirmIcone');
    const iconeI     = document.getElementById('modalConfirmIconeI');
    const btnOk      = document.getElementById('modalConfirmBtnOk');
    const btnCancel  = document.getElementById('modalConfirmBtnCancelar');

    const iconMap = { warning: 'fa-exclamation-triangle', danger: 'fa-trash-alt', info: 'fa-info-circle', success: 'fa-check-circle' };
    iconeDiv.className = `modal-icon-circle ${tipo}`;
    iconeI.className   = `fas ${iconMap[tipo] || iconMap.warning}`;
    btnOk.className    = `btn btn-modal-confirm-${tipo}`;
    tituloEl.textContent = titulo;
    msgEl.textContent    = mensagem;
    btnOk.innerHTML      = `<i class="fas fa-check"></i> ${txtConfirmar}`;
    btnCancel.innerHTML  = `<i class="fas fa-times"></i> ${txtCancelar}`;

    if (detalhe) { detalheEl.textContent = detalhe; detalheEl.classList.remove('hidden'); }
    else { detalheEl.classList.add('hidden'); }

    _abrirModal(overlay);

    return new Promise(resolve => {
        const confirmar  = () => { cleanup(); _fecharModal(overlay); resolve(true); };
        const cancelar   = () => { cleanup(); _fecharModal(overlay); resolve(false); };
        const fecharFora = (e) => { if (e.target === overlay) cancelar(); };
        function cleanup() { btnOk.removeEventListener('click', confirmar); btnCancel.removeEventListener('click', cancelar); overlay.removeEventListener('click', fecharFora); }
        btnOk.addEventListener('click', confirmar);
        btnCancel.addEventListener('click', cancelar);
        overlay.addEventListener('click', fecharFora);
    });
}

function _abrirModal(overlay) {
    overlay.classList.remove('hidden');
    void overlay.offsetWidth;
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function _fecharModal(overlay) {
    overlay.classList.remove('show');
    overlay.addEventListener('transitionend', () => {
        overlay.classList.add('hidden');
        document.body.style.overflow = '';
    }, { once: true });
}

document.addEventListener('DOMContentLoaded', async () => {
    // ============================================================
    // 1. INICIALIZAÇÃO E REFERÊNCIAS
    // ============================================================
    const form = document.getElementById('configForm');
    const saveBtn = document.getElementById('saveBtn');
    const executionModeInputs = [...document.querySelectorAll('input[name="cron_modo"]')];
    const executionModeWarning = document.getElementById('execution-mode-warning');
    let parametrosCarregados = false;
    saveBtn.disabled = true;
    
    // Elementos do Cron
    const elAtivo = document.getElementById('cron_ativo');
    const elDatetime = document.getElementById('cron_datetime');
    const elFreq = document.getElementById('cron_frequency'); // Select oculto
    const elPreview = document.getElementById('cron-preview');
    const elOptions = document.getElementById('cron-options');
    const elWinthorFixAtivo = document.getElementById('winthor_fix_ativo');
    const elWinthorFixSincronizarBitrix = document.getElementById('winthor_fix_sincronizar_bitrix');
    const elWinthorFixStatus = document.getElementById('winthor-fix-status');
    const elWinthorFixIntervalo = document.getElementById('winthor_fix_intervalo');
    const btnExecutarWinthorFixAgora = document.getElementById('btnExecutarWinthorFixAgora');
    const btnRollbackWinthorFixLegado = document.getElementById('btnRollbackWinthorFixLegado');
    const WINTHOR_FIX_INTERVALOS_VALIDOS = [1, 15, 30];
    const systemModal = document.getElementById('configSystemModal');
    const systemModalTitle = document.getElementById('configSystemModalTitle');
    const systemModalMessage = document.getElementById('configSystemModalMessage');
    const systemModalDetail = document.getElementById('configSystemModalDetail');
    const systemModalIconWrap = document.getElementById('configSystemModalIconWrap');
    const systemModalIcon = document.getElementById('configSystemModalIcon');
    const systemModalConfirm = document.getElementById('configSystemModalConfirm');
    const systemModalCancel = document.getElementById('configSystemModalCancel');
    const modalTypeIconMap = {
        info: 'fa-info-circle',
        success: 'fa-circle-check',
        warning: 'fa-triangle-exclamation',
        danger: 'fa-circle-xmark'
    };
    const modalTypeButtonMap = {
        info: 'btn-modal-confirm-info',
        success: 'btn-modal-confirm-success',
        warning: 'btn-modal-confirm-warning',
        danger: 'btn-modal-confirm-danger'
    };
    let cleanupSystemModalListeners = null;
    let resolveSystemModal = null;

    function fecharSystemModal(resultado = false) {
        if (typeof cleanupSystemModalListeners === 'function') {
            cleanupSystemModalListeners();
            cleanupSystemModalListeners = null;
        }

        if (systemModal) {
            systemModal.classList.remove('open');
            systemModal.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('modal-open');

        const resolverAtual = resolveSystemModal;
        resolveSystemModal = null;
        if (typeof resolverAtual === 'function') {
            resolverAtual(resultado);
        }
    }

    function abrirSystemModal({
        title = 'Aviso',
        message = '',
        detail = '',
        type = 'info',
        confirmText = 'OK',
        cancelText = '',
        allowBackdropClose = true
    } = {}) {
        if (!systemModal || !systemModalTitle || !systemModalMessage || !systemModalConfirm || !systemModalCancel || !systemModalIconWrap || !systemModalIcon) {
            console.error('[ConfigModal] Estrutura do modal não encontrada.');
            return Promise.resolve(cancelText ? false : true);
        }

        if (typeof resolveSystemModal === 'function') {
            fecharSystemModal(false);
        }

        const modalType = ['info', 'success', 'warning', 'danger'].includes(type) ? type : 'info';
        const textoMensagem = String(message || '').trim();
        const textoDetalhe = String(detail || '').trim();
        const isConfirm = Boolean(cancelText);

        systemModalTitle.textContent = title || 'Aviso';
        systemModalMessage.textContent = textoMensagem;
        systemModalDetail.textContent = textoDetalhe;
        systemModalDetail.classList.toggle('config-ui-hidden', !textoDetalhe);

        systemModalIconWrap.className = `config-ui-modal-icon ${modalType}`;
        systemModalIcon.className = `fas ${modalTypeIconMap[modalType] || modalTypeIconMap.info}`;

        systemModalConfirm.className = `btn ${modalTypeButtonMap[modalType] || modalTypeButtonMap.info}`;
        systemModalConfirm.innerHTML = `<i class="fas fa-check"></i> ${confirmText || 'OK'}`;

        systemModalCancel.classList.toggle('config-ui-hidden', !isConfirm);
        systemModalCancel.innerHTML = `<i class="fas fa-times"></i> ${cancelText || 'Cancelar'}`;

        systemModal.classList.add('open');
        systemModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');

        return new Promise((resolve) => {
            resolveSystemModal = resolve;

            const confirmar = () => fecharSystemModal(true);
            const cancelar = () => fecharSystemModal(false);
            const onOverlayClick = (event) => {
                if (event.target === systemModal && allowBackdropClose) {
                    if (isConfirm) cancelar();
                    else confirmar();
                }
            };
            const onKeyDown = (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                if (isConfirm) cancelar();
                else confirmar();
            };

            cleanupSystemModalListeners = () => {
                systemModalConfirm.removeEventListener('click', confirmar);
                systemModalCancel.removeEventListener('click', cancelar);
                systemModal.removeEventListener('click', onOverlayClick);
                document.removeEventListener('keydown', onKeyDown);
            };

            systemModalConfirm.addEventListener('click', confirmar);
            systemModalCancel.addEventListener('click', cancelar);
            systemModal.addEventListener('click', onOverlayClick);
            document.addEventListener('keydown', onKeyDown);

            requestAnimationFrame(() => {
                (isConfirm ? systemModalCancel : systemModalConfirm)?.focus();
            });
        });
    }

    async function showSystemAlert(message, options = {}) {
        await abrirSystemModal({
            title: options.title || 'Aviso',
            message,
            detail: options.detail || '',
            type: options.type || 'info',
            confirmText: options.confirmText || 'OK',
            cancelText: ''
        });
    }

    async function showSystemConfirm(message, options = {}) {
        return await abrirSystemModal({
            title: options.title || 'Confirmar ação',
            message,
            detail: options.detail || '',
            type: options.type || 'warning',
            confirmText: options.confirmText || 'Confirmar',
            cancelText: options.cancelText || 'Cancelar'
        });
    }

    // Inicializa Tema
    initTheme();

    function getSelectedExecutionMode() {
        return executionModeInputs.find((input) => input.checked)?.value || 'CLASSIFICACAO';
    }

    function updateExecutionModeUi() {
        const classificationOnly = getSelectedExecutionMode() === 'CLASSIFICACAO';
        document.querySelectorAll('[data-movement-only]').forEach((block) => {
            block.classList.toggle('execution-section-disabled', classificationOnly);
            block.setAttribute('aria-disabled', String(classificationOnly));
            block.inert = classificationOnly;
        });
        document.querySelectorAll('[data-required-in-movement]').forEach((control) => {
            control.required = !classificationOnly;
        });
        executionModeWarning?.classList.toggle('config-ui-hidden', !classificationOnly);
    }

    function setSelectedExecutionMode(mode) {
        const selectedMode = ['CLASSIFICACAO', 'MOVIMENTACAO'].includes(mode)
            ? mode
            : 'CLASSIFICACAO';
        const input = executionModeInputs.find((candidate) => candidate.value === selectedMode);
        if (input) input.checked = true;
        updateExecutionModeUi();
    }

    executionModeInputs.forEach((input) => input.addEventListener('change', updateExecutionModeUi));
    updateExecutionModeUi();
    if (elWinthorFixAtivo) {
        elWinthorFixAtivo.checked = true;
    }

    // ============================================================
    // 2. LÓGICA DE PERMISSÕES DE USUÁRIOS (SALVAMENTO AUTOMÁTICO)
    // ============================================================
    const usersTableBody = document.getElementById('usersTableBody');
    const btnAddUser = document.getElementById('btnAddUser');
    const inputNewUser = document.getElementById('new_user_email');

    // Carregar Lista de Usuários
    async function loadPermissions() {
        try {
            usersTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Carregando...</td></tr>';
            const res = await fetch('/api/users-permissions');
            const json = await res.json();

            if (json.success) {
                renderUsersTable(json.data);
            } else {
                usersTableBody.innerHTML = `<tr><td colspan="5" class="text-center text-red">Erro: ${json.error}</td></tr>`;
            }
        } catch (e) {
            console.error(e);
            usersTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Erro de conexão</td></tr>';
        }
    }

    // Renderizar Tabela
    function renderUsersTable(users) {
        usersTableBody.innerHTML = '';
        
        if (users.length === 0) {
            usersTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Nenhum usuário adicional encontrado.</td></tr>';
            return;
        }

        users.forEach(u => {
            const tr = document.createElement('tr');
            
            // Note que passamos 'this' no togglePermission para controlar o visual
            tr.innerHTML = `
                <td>
                    <div class="user-info">
                        <span class="user-name">${u.name || 'Novo Usuário'}</span>
                        <span class="user-email">${u.email}</span>
                    </div>
                </td>
                <td class="text-center">
                    <label class="switch small">
                        <input type="checkbox" ${u.is_config ? 'checked' : ''} onchange="togglePermission(${u.id}, 'is_config', this)">
                        <span class="slider round"></span>
                    </label>
                </td>
                <td class="text-center">
                    <label class="switch small">
                        <input type="checkbox" ${u.is_painel ? 'checked' : ''} onchange="togglePermission(${u.id}, 'is_painel', this)">
                        <span class="slider round"></span>
                    </label>
                </td>
                <td class="text-center">
                    <label class="switch small">
                        <input type="checkbox" ${u.is_excel ? 'checked' : ''} onchange="togglePermission(${u.id}, 'is_excel', this)">
                        <span class="slider round"></span>
                    </label>
                </td>
                <td class="text-center">
                    <button class="btn-delete" onclick="deleteUser(${u.id})" title="Remover Usuário">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            usersTableBody.appendChild(tr);
        });
    }

    // Adicionar Novo Usuário
    if(btnAddUser) {
        btnAddUser.addEventListener('click', async () => {
            const email = inputNewUser.value.trim();
            if (!email) {
                await showSystemAlert('Digite um e-mail válido.', {
                    title: 'E-mail obrigatório',
                    type: 'warning'
                });
                return;
            }

            const originalText = btnAddUser.innerHTML;
            btnAddUser.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            btnAddUser.disabled = true;

            try {
                const res = await fetch('/api/users-permissions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const json = await res.json();
                
                if (json.success) {
                    inputNewUser.value = '';
                    loadPermissions();
                } else {
                    await showSystemAlert(json.error || 'Erro ao adicionar usuário.', {
                        title: 'Falha ao adicionar usuário',
                        type: 'danger'
                    });
                }
            } catch (e) {
                await showSystemAlert('Erro ao adicionar usuário.', {
                    title: 'Erro de conexão',
                    type: 'danger'
                });
            } finally {
                btnAddUser.innerHTML = originalText;
                btnAddUser.disabled = false;
            }
        });
    }

    // Funções Globais (Window) para acesso via HTML inline
    
    // Toggle Switch (Salva Sozinho + Feedback Visual)
    window.togglePermission = async (id, field, checkbox) => {
        const originalState = !checkbox.checked;
        const row = checkbox.closest('tr');
        
        try {
            checkbox.disabled = true; // Trava para evitar clique duplo
            
            const res = await fetch(`/api/users-permissions/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ field, value: checkbox.checked })
            });

            if (!res.ok) throw new Error('Falha ao salvar');

            // Feedback de Sucesso (Pisca Verde)
            row.style.transition = 'background-color 0.5s';
            const originalBg = row.style.backgroundColor;
            row.style.backgroundColor = 'rgba(16, 185, 129, 0.1)'; 
            setTimeout(() => { row.style.backgroundColor = originalBg; }, 500);

        } catch (e) {
            await showSystemAlert('Erro ao salvar permissão.', {
                title: 'Falha ao atualizar permissão',
                type: 'danger'
            });
            checkbox.checked = originalState; // Reverte visualmente
        } finally {
            checkbox.disabled = false;
        }
    };

    // Deletar Usuário
    window.deleteUser = async (id) => {
        const confirmou = await showSystemConfirm('Tem certeza que deseja remover este usuário e revogar todos os acessos?', {
            title: 'Remover usuário',
            type: 'danger',
            confirmText: 'Remover'
        });
        if (!confirmou) return;
        try {
            const res = await fetch(`/api/users-permissions/${id}`, { method: 'DELETE' });
            if(res.ok) loadPermissions();
            else {
                await showSystemAlert('Erro ao deletar.', {
                    title: 'Falha ao remover usuário',
                    type: 'danger'
                });
            }
        } catch (e) {
            await showSystemAlert('Erro de conexão.', {
                title: 'Falha de rede',
                type: 'danger'
            });
        }
    };

    // Carrega permissões ao iniciar
    await loadPermissions();


    // ============================================================
    // 3. LOGICA VISUAL (Custom Select e Cron)
    // ============================================================
    
    function closeAllCustomSelects() {
        document.querySelectorAll('.custom-select-wrapper.open').forEach((w) => w.classList.remove('open'));
    }

    function syncCustomSelect(wrapperId, value) {
        const wrapper = document.getElementById(wrapperId);
        if (!wrapper) return;
        const trigger = wrapper.querySelector('.custom-select-trigger');
        const triggerContent = trigger?.querySelector('.trigger-content');
        const options = wrapper.querySelectorAll('.custom-option');
        if (!trigger || !triggerContent || !options.length) return;

        const selectedOption =
            Array.from(options).find((opt) => String(opt.getAttribute('data-value')) === String(value))
            || options[0];

        options.forEach((opt) => opt.classList.remove('selected'));
        selectedOption.classList.add('selected');

        const icon = selectedOption.querySelector('i');
        const iconHtml = icon ? icon.outerHTML : '';
        const text = selectedOption.textContent.trim();
        triggerContent.innerHTML = `${iconHtml} ${text}`.trim();
    }

    function setupCustomSelect(wrapperId, selectEl) {
        const wrapper = document.getElementById(wrapperId);
        if (!wrapper || !selectEl) return;

        const trigger = wrapper.querySelector('.custom-select-trigger');
        const options = wrapper.querySelectorAll('.custom-option');
        if (!trigger || !options.length) return;

        if (!window.__configCustomSelectGlobalBound) {
            window.addEventListener('click', closeAllCustomSelects);
            window.__configCustomSelectGlobalBound = true;
        }

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const vaiAbrir = !wrapper.classList.contains('open');
            closeAllCustomSelects();
            if (vaiAbrir) wrapper.classList.add('open');
        });

        options.forEach((option) => {
            option.addEventListener('click', function (e) {
                e.stopPropagation();
                const value = this.getAttribute('data-value');
                syncCustomSelect(wrapperId, value);
                selectEl.value = value;
                selectEl.dispatchEvent(new Event('change'));
                wrapper.classList.remove('open');
            });
        });

        syncCustomSelect(wrapperId, selectEl.value);
    }

    setupCustomSelect('custom_cron_frequency', elFreq);
    setupCustomSelect('custom_winthor_fix_intervalo', elWinthorFixIntervalo);

    function updateCronPreview() {
        const ativo = elAtivo.checked;
        if (!ativo) {
            elPreview.textContent = "Execução automática DESATIVADA.";
            elPreview.style.color = "#888";
            elOptions.style.opacity = "0.5";
            elOptions.style.pointerEvents = "none";
            return;
        }

        elOptions.style.opacity = "1";
        elOptions.style.pointerEvents = "all";

        const dtVal = elDatetime.value;
        if (!dtVal) {
            elPreview.textContent = "Selecione uma data e hora de início.";
            elPreview.style.color = "var(--secondary)"; 
            return;
        }

        const date = new Date(dtVal);
        const dia = date.getDate().toString().padStart(2, '0');
        const mes = (date.getMonth() + 1).toString().padStart(2, '0');
        const ano = date.getFullYear();
        const hora = date.getHours().toString().padStart(2, '0');
        const min = date.getMinutes().toString().padStart(2, '0');
        const freqText = elFreq.options[elFreq.selectedIndex].text;

        elPreview.innerHTML = `
            <i class="fas fa-info-circle"></i> O sistema iniciará em <strong>${dia}/${mes}/${ano} às ${hora}:${min}</strong> 
            e repetirá com frequência <strong>${freqText}</strong>.
        `;
        elPreview.style.color = "var(--primary)";
    }

    function updateWinthorFixStatus() {
        if (!elWinthorFixAtivo || !elWinthorFixStatus) return;
        const intervaloTexto = elWinthorFixIntervalo?.options?.[elWinthorFixIntervalo.selectedIndex]?.text || 'A cada 15 minutos';

        const intervalGroup = elWinthorFixIntervalo?.closest('.form-group');
        if (intervalGroup) {
            intervalGroup.style.opacity = elWinthorFixAtivo.checked ? '1' : '0.5';
            intervalGroup.style.pointerEvents = elWinthorFixAtivo.checked ? 'all' : 'none';
        }

        const bitrixPermitido = elAtivo.checked
            && getSelectedExecutionMode() === 'MOVIMENTACAO'
            && elWinthorFixSincronizarBitrix?.checked === true;
        const statusBitrix = bitrixPermitido
            ? 'Bitrix: PERMITIDO pela política atual.'
            : 'Bitrix: BLOQUEADO (ative o agendamento principal no modo MOVIMENTACAO e esta opção).';

        if (elWinthorFixAtivo.checked) {
            elWinthorFixStatus.textContent = `Status: ATIVADO (${intervaloTexto.toLowerCase()}).\n${statusBitrix}`;
            elWinthorFixStatus.style.color = 'var(--success)';
        } else {
            elWinthorFixStatus.textContent = `Status: DESATIVADO (nenhuma execução automática).\n${statusBitrix}`;
            elWinthorFixStatus.style.color = 'var(--text-tertiary)';
        }
    }

    elAtivo.addEventListener('change', updateCronPreview);
    elDatetime.addEventListener('change', updateCronPreview);
    elFreq.addEventListener('change', updateCronPreview);
    if (elWinthorFixAtivo) {
        elWinthorFixAtivo.addEventListener('change', updateWinthorFixStatus);
    }
    if (elWinthorFixIntervalo) {
        elWinthorFixIntervalo.addEventListener('change', updateWinthorFixStatus);
    }
    if (elWinthorFixSincronizarBitrix) {
        elWinthorFixSincronizarBitrix.addEventListener('change', updateWinthorFixStatus);
    }
    elAtivo.addEventListener('change', updateWinthorFixStatus);
    executionModeInputs.forEach((input) => input.addEventListener('change', updateWinthorFixStatus));
    updateWinthorFixStatus();


    // ============================================================
    // 4. CARREGAR PARÂMETROS GERAIS
    // ============================================================
    async function carregarDados() {
        try {
            const res = await fetch('/api/parametros');
            const json = await res.json();
            
            if (json.success && json.data) {
                const d = json.data;
                
                // Campos Simples
                if(d.dias_rotativa) document.getElementById('dias_rotativa').value = d.dias_rotativa;
                if(d.dias_longo_prazo) document.getElementById('dias_longo_prazo').value = d.dias_longo_prazo;
                if(d.dias_protecao_upgrade) document.getElementById('dias_protecao_upgrade').value = d.dias_protecao_upgrade;
                if(d.meses_sazonalidade_inicio) document.getElementById('meses_sazonalidade_inicio').value = d.meses_sazonalidade_inicio;
                if(d.meses_sazonalidade_fim) document.getElementById('meses_sazonalidade_fim').value = d.meses_sazonalidade_fim;
                
                // Arrays
                if (Array.isArray(d.fases_bitrix_bloqueio)) {
                    document.getElementById('fases_bitrix_bloqueio').value = d.fases_bitrix_bloqueio.join(', ');
                }
                if (Array.isArray(d.rcas_rotativa)) {
                    document.getElementById('rcas_rotativa').value = d.rcas_rotativa.join(', ');
                }
                if (Array.isArray(d.filiais_cron)) {
                    document.getElementById('filiais_cron').value = d.filiais_cron.join(', ');
                }

                // Mapa Bitrix
                if (d.mapa_bitrix) {
                    const textoMapa = Object.entries(d.mapa_bitrix).map(([rca, id]) => `${rca}:${id}`).join(', ');
                    document.getElementById('mapa_bitrix').value = textoMapa;
                }

                // ================= NOVO: Carregar Mapa de Segmentos =================
                if (d.rca_segmento_map) {
                    const textoSegmento = Object.entries(d.rca_segmento_map)
                        .map(([rca, segmentos]) => `${rca}: ${segmentos.join(', ')}`)
                        .join('\n'); // Uma regra por linha
                    document.getElementById('rca_segmento_map').value = textoSegmento;
                }
                // ====================================================================
                
                // Config PDF
                if (d.pdf_config) {
                    document.getElementById('pdf_ativo').checked = d.pdf_config.ativo;
                    document.getElementById('pdf_modo_teste').checked = d.pdf_config.modo_teste;
                    document.getElementById('pdf_id_tester').value = d.pdf_config.id_tester || '';
                }

                // Config CRON
                if (d.cron_config) {
                    elAtivo.checked = d.cron_config.ativo;
                    elDatetime.value = d.cron_config.datetime || '';
                    elFreq.value = d.cron_config.frequency || 'monthly';
                    syncCustomSelect('custom_cron_frequency', elFreq.value);
                    setSelectedExecutionMode(d.cron_config?.modo);
                } else {
                    elAtivo.checked = true;
                    setSelectedExecutionMode('CLASSIFICACAO');
                }

                if (elWinthorFixAtivo) {
                    elWinthorFixAtivo.checked = d.winthor_fix_config
                        ? Boolean(d.winthor_fix_config.ativo)
                        : true;
                }

                if (elWinthorFixIntervalo) {
                    const intervaloRaw = Number(d?.winthor_fix_config?.intervalo_minutos);
                    const intervalo = WINTHOR_FIX_INTERVALOS_VALIDOS.includes(intervaloRaw) ? intervaloRaw : 15;
                    elWinthorFixIntervalo.value = String(intervalo);
                    syncCustomSelect('custom_winthor_fix_intervalo', elWinthorFixIntervalo.value);
                }

                if (elWinthorFixSincronizarBitrix) {
                    elWinthorFixSincronizarBitrix.checked = d?.winthor_fix_config?.sincronizar_bitrix === true;
                }
                
                updateCronPreview();
                updateWinthorFixStatus();
                parametrosCarregados = true;
                saveBtn.disabled = false;
            }
        } catch (err) {
            console.error('Erro ao carregar parâmetros:', err);
        }
    }
    await carregarDados();


    // ============================================================
    // 5. AÇÕES DO FORMULÁRIO GERAL (SALVAR TUDO MENOS PERMISSÕES)
    // ============================================================
    
    // Disparar PDF
    const btnDisparar = document.getElementById('btnDispararPdf');
    if (btnDisparar) {
        btnDisparar.addEventListener('click', async () => {
            const confirmou = await showSystemConfirm('Tem certeza que deseja gerar e enviar os PDFs agora?', {
                title: 'Disparar relatórios PDF',
                type: 'warning',
                confirmText: 'Disparar'
            });
            if (!confirmou) return;
            
            const originalText = btnDisparar.innerHTML;
            btnDisparar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
            btnDisparar.disabled = true;

            try {
                const res = await fetch('/api/disparar-relatorios-pdf', { method: 'POST' });
                const json = await res.json();
                if(json.success) {
                    await showSystemAlert(json.message || 'Processo iniciado com sucesso.', {
                        title: 'Disparo iniciado',
                        type: 'success'
                    });
                } else {
                    await showSystemAlert(json.error || 'Erro desconhecido.', {
                        title: 'Falha ao disparar PDFs',
                        type: 'danger'
                    });
                }
            } catch(e) {
                await showSystemAlert('Erro de conexão.', {
                    title: 'Falha ao disparar PDFs',
                    type: 'danger'
                });
            } finally {
                btnDisparar.innerHTML = originalText;
                btnDisparar.disabled = false;
            }
        });
    }

    if (btnExecutarWinthorFixAgora) {
        btnExecutarWinthorFixAgora.addEventListener('click', async () => {
            const confirmou = await showSystemConfirm('Deseja executar a correção de cadastro no WinThor agora?', {
                title: 'Executar correção WinThor',
                type: 'warning',
                confirmText: 'Executar'
            });
            if (!confirmou) return;

            const originalText = btnExecutarWinthorFixAgora.innerHTML;
            btnExecutarWinthorFixAgora.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executando...';
            btnExecutarWinthorFixAgora.disabled = true;

            try {
                const res = await fetch('/api/winthor/corrigir-cadastro-clientes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const json = await res.json();
                if (!json.success) {
                    throw new Error(json.error || 'Falha ao executar correção.');
                }

                const d = json.data || {};
                if (d.skipped) {
                    await showSystemAlert(`Execução ignorada: ${d.reason || 'motivo não informado'}.`, {
                        title: 'Correção não iniciada',
                        type: 'warning'
                    });
                    return;
                }
                const bitrix = d.bitrixSync || {};
                await showSystemAlert(
                    `Ambiente: ${d.ambiente || '-'}\n` +
                    `Lidos: ${d.totalLidos ?? 0}\n` +
                    `Corrigidos: ${d.totalCorrigidos ?? 0}\n` +
                    `Logs: ${d.totalRegistrosLog ?? 0}\n` +
                    `Bitrix atualizados: ${bitrix.atualizados ?? 0}\n` +
                    `Bitrix nao encontrados: ${bitrix.naoEncontrados ?? 0}\n` +
                    `Bitrix erros: ${bitrix.erros ?? 0}`,
                    {
                        title: 'Correção executada',
                        type: 'success'
                    }
                );
            } catch (e) {
                await showSystemAlert(e.message || 'Erro desconhecido', {
                    title: 'Erro ao executar correção',
                    type: 'danger'
                });
            } finally {
                btnExecutarWinthorFixAgora.innerHTML = originalText;
                btnExecutarWinthorFixAgora.disabled = false;
            }
        });
    }

    if (btnRollbackWinthorFixLegado) {
        btnRollbackWinthorFixLegado.addEventListener('click', async () => {
            const confirmado = await showSystemConfirm(
                'Deseja executar o rollback legado agora?',
                {
                    title: 'Rollback legado',
                    detail: 'Essa acao tenta desfazer ajustes antigos de CODATV1/CODREDE usando os logs e em seguida reaplica a correcao atual de categoria por CODREDE.',
                    type: 'danger',
                    confirmText: 'Executar rollback'
                }
            );
            if (!confirmado) return;

            const originalText = btnRollbackWinthorFixLegado.innerHTML;
            btnRollbackWinthorFixLegado.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executando rollback...';
            btnRollbackWinthorFixLegado.disabled = true;
            if (btnExecutarWinthorFixAgora) btnExecutarWinthorFixAgora.disabled = true;

            try {
                const res = await fetch('/api/winthor/rollback-correcao-legado', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        executarCorrecaoPosRollback: true
                    })
                });
                const json = await res.json();
                if (!json.success) {
                    throw new Error(json.error || 'Falha ao executar rollback legado.');
                }

                const d = json.data || {};
                if (d.skipped) {
                    await showSystemAlert(`Execução ignorada: ${d.reason || 'motivo não informado'}.`, {
                        title: 'Rollback não iniciado',
                        type: 'warning'
                    });
                    return;
                }
                const pos = d.correcaoPosRollback || null;
                const resumoPos = pos
                    ? `\n\nCorrecao pos-rollback:\n- Lidos: ${pos.totalLidos ?? 0}\n- Corrigidos: ${pos.totalCorrigidos ?? 0}\n- Logs: ${pos.totalRegistrosLog ?? 0}`
                    : '';

                await showSystemAlert(
                    `Ambiente: ${d.ambiente || '-'}\n` +
                    `Logs antigos encontrados: ${d.logsLegadosEncontrados ?? 0}\n` +
                    `Linhas processadas: ${d.linhasProcessadas ?? 0}\n` +
                    `CODATV1 revertidos: ${d.codatv1Revertidos ?? 0}\n` +
                    `CODREDE revertidos: ${d.codredeRevertidos ?? 0}\n` +
                    `Clientes afetados: ${d.totalClientesAfetados ?? 0}\n` +
                    `Logs de rollback: ${d.totalLogsRollback ?? 0}` +
                    resumoPos,
                    {
                        title: 'Rollback legado executado',
                        type: 'success'
                    }
                );
            } catch (e) {
                await showSystemAlert(e.message || 'Erro desconhecido', {
                    title: 'Erro ao executar rollback legado',
                    type: 'danger'
                });
            } finally {
                btnRollbackWinthorFixLegado.innerHTML = originalText;
                btnRollbackWinthorFixLegado.disabled = false;
                if (btnExecutarWinthorFixAgora) btnExecutarWinthorFixAgora.disabled = false;
            }
        });
    }

    // Submit do Form Principal
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!parametrosCarregados) return;
        
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';
        saveBtn.disabled = true;

        // Processadores de dados
        const processarArray = (id) => document.getElementById(id).value.split(',').map(s => s.trim()).filter(s => s.length > 0);
        const processarArrayNumeros = (id) => document.getElementById(id).value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        const processarMapa = (id) => {
            const val = document.getElementById(id).value;
            const obj = {};
            if (!val) return obj;
            val.split(',').forEach(item => {
                const [rca, bitrixId] = item.split(':').map(s => s.trim());
                if (rca && bitrixId) obj[rca] = parseInt(bitrixId);
            });
            return obj;
        };

        // ================= NOVO PROCESSADOR =================
        const processarMapaSegmento = (id) => {
            const val = document.getElementById(id).value;
            const obj = {};
            if (!val) return obj;
            
            // Separa o texto por quebras de linha
            val.split(/\r?\n/).forEach(linha => {
                if (!linha.trim()) return;
                const partes = linha.split(':');
                if (partes.length === 2) {
                    const rca = partes[0].trim();
                    // Pega os códigos, separa por vírgula e transforma em número
                    const segmentos = partes[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                    if (rca && segmentos.length > 0) {
                        obj[rca] = segmentos;
                    }
                }
            });
            return obj;
        };
        // ====================================================

        const payload = {
            dias_rotativa: parseInt(document.getElementById('dias_rotativa').value),
            dias_longo_prazo: parseInt(document.getElementById('dias_longo_prazo').value),
            dias_protecao_upgrade: parseInt(document.getElementById('dias_protecao_upgrade').value),
            meses_sazonalidade_inicio: parseInt(document.getElementById('meses_sazonalidade_inicio').value),
            meses_sazonalidade_fim: parseInt(document.getElementById('meses_sazonalidade_fim').value),
            fases_bitrix_bloqueio: processarArray('fases_bitrix_bloqueio'),
            rcas_rotativa: processarArrayNumeros('rcas_rotativa'),
            mapa_bitrix: processarMapa('mapa_bitrix'),
            
            // ================= NOVO CAMPO NO PAYLOAD =================
            rca_segmento_map: processarMapaSegmento('rca_segmento_map'),
            // =========================================================

            filiais_cron: processarArrayNumeros('filiais_cron'),
            
            cron_config: {
                ativo: elAtivo.checked,
                modo: getSelectedExecutionMode(),
                datetime: elDatetime.value,
                frequency: elFreq.value
            },

            winthor_fix_config: {
                ativo: elWinthorFixAtivo ? elWinthorFixAtivo.checked : true,
                sincronizar_bitrix: elWinthorFixSincronizarBitrix
                    ? elWinthorFixSincronizarBitrix.checked
                    : false,
                intervalo_minutos: (() => {
                    const raw = Number(elWinthorFixIntervalo ? elWinthorFixIntervalo.value : 15);
                    return WINTHOR_FIX_INTERVALOS_VALIDOS.includes(raw) ? raw : 15;
                })()
            },

            pdf_config: {
                ativo: document.getElementById('pdf_ativo').checked,
                modo_teste: document.getElementById('pdf_modo_teste').checked,
                id_tester: parseInt(document.getElementById('pdf_id_tester').value) || 0
            }
        };

        try {
            const res = await fetch('/api/parametros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const json = await res.json();
            
            if (json.success) {
                await showSystemAlert('Configurações salvas com sucesso!', {
                    title: 'Parâmetros atualizados',
                    type: 'success'
                });
            } else {
                await showSystemAlert(json.error || 'Erro desconhecido', {
                    title: 'Erro ao salvar configurações',
                    type: 'danger'
                });
            }
        } catch (err) {
            await showSystemAlert('Erro de conexão com o servidor.', {
                title: 'Falha ao salvar configurações',
                type: 'danger'
            });
        } finally {
            saveBtn.innerHTML = originalText;
            saveBtn.disabled = !parametrosCarregados;
        }
    });

    // Theme Toggle Listener
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
});

// ===========================
// FUNÇÕES GLOBAIS DE TEMA
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
    if(btn) btn.innerHTML = document.body.classList.contains('light') ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
}

// ===========================
// FAVICON REDONDO
// ===========================
(function makeFaviconCircular() {
    const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.type = 'image/png';
    link.rel = 'icon';
    document.head.appendChild(link);

    const img = new Image();
    img.src = 'img/logo.png';

    img.onload = function() {
        const canvas = document.createElement('canvas');
        const size = 64;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.arc(size/2, size/2, size/2, 0, 2 * Math.PI);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, 0, 0, size, size);
        link.href = canvas.toDataURL();
    };
})();



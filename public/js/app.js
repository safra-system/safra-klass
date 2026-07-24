class PerformanceApp {
    constructor() {
        this.currentData = null;
        this.expandedClients = new Set();
        this.virtualizedData = [];
        this.allVirtualizedData = []; // guarda todos antes do filtro de classificação
        this.currentBatch = 0;
        this.batchSize = 50;
        this.loadingMore = false;
        this.init();
    }

    init() {
        this.setDefaultDates();
        this.bindEvents();
        this.initTheme(); 
    }

    // ===========================
    // TEMA & DATAS
    // ===========================
    initTheme() {
        const savedTheme = localStorage.getItem('theme');
        const theme = savedTheme === 'light' ? 'light' : 'default';
        if (savedTheme === 'dark') localStorage.setItem('theme', 'default');
        const resolvedTheme = theme === 'light' ? 'light' : 'dark';
        document.body.classList.remove('dark', 'light');
        document.body.classList.add(resolvedTheme);
        document.body.dataset.theme = resolvedTheme;
        document.documentElement.dataset.theme = resolvedTheme;
        document.documentElement.style.colorScheme = resolvedTheme;
        this.updateThemeIcon();
    }

    toggleTheme() {
        const isLight = document.body.classList.contains('light');
        const nextTheme = !isLight ? 'light' : 'default';
        const resolvedTheme = nextTheme === 'light' ? 'light' : 'dark';
        document.body.classList.remove('dark', 'light');
        document.body.classList.add(resolvedTheme);
        document.body.dataset.theme = resolvedTheme;
        document.documentElement.dataset.theme = resolvedTheme;
        document.documentElement.style.colorScheme = resolvedTheme;
        localStorage.setItem('theme', nextTheme);
        this.updateThemeIcon();
    }

    updateThemeIcon() {
        const themeBtn = document.getElementById('theme-toggle');
        if (themeBtn) {
            const isLight = document.body.classList.contains('light');
            themeBtn.innerHTML = isLight
                ? '<i class="fas fa-moon"></i>'
                : '<i class="fas fa-sun"></i>';
        }
    }

    setDefaultDates() {
        const today = new Date();
        const lastYear = new Date();
        
        // Define a data inicial para exatamente 1 ano atrás
        lastYear.setFullYear(today.getFullYear() - 1);

        document.getElementById('DataIni').value = this.formatDate(lastYear);
        document.getElementById('DataFim').value = this.formatDate(today);
    }

    formatDate(date) { return date.toISOString().split('T')[0]; }

    bindEvents() {
        document.getElementById('searchForm').addEventListener('submit', (e) => { e.preventDefault(); this.handleSearch(); });
        document.getElementById('exportBtn').addEventListener('click', () => this.handleExport());
        
        const themeBtn = document.getElementById('theme-toggle');
        if(themeBtn) themeBtn.addEventListener('click', () => this.toggleTheme());

        // Toggle filial pills
        document.querySelectorAll('#filial-pills .filial-pill').forEach(pill => {
            pill.addEventListener('click', () => pill.classList.toggle('selected'));
        });

        // Toggle ramo de atividade pills (seleção múltipla, nenhum = todos)
        document.querySelectorAll('.ramo-pill').forEach(pill => {
            pill.addEventListener('click', () => pill.classList.toggle('selected'));
        });

        // Toggle classificação pills — filtra os resultados já carregados
        document.querySelectorAll('.classificacao-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                pill.classList.toggle('selected');
                this.aplicarFiltroClassificacao();
            });
        });

        // Toggle painel de mais filtros
        const toggleBtn = document.getElementById('toggleFiltrosBtn');
        const painel    = document.getElementById('painelFiltrosExtras');
        const icon      = document.getElementById('toggleFiltrosIcon');
        const label     = document.getElementById('toggleFiltrosLabel');
        let painelAberto = false;

        if (toggleBtn && painel) {
            toggleBtn.addEventListener('click', () => {
                painelAberto = !painelAberto;
                painel.style.display = painelAberto ? 'block' : 'none';
                label.textContent = painelAberto ? 'Menos Filtros' : 'Mais Filtros';
                icon.className = painelAberto ? 'fas fa-times' : 'fas fa-sliders-h';
                toggleBtn.style.background = painelAberto ? 'var(--primary)' : 'none';
                toggleBtn.style.color      = painelAberto ? '#fff' : 'var(--primary)';
                toggleBtn.style.borderStyle = painelAberto ? 'solid' : 'dashed';
            });
        }
        
        this.setupInfiniteScroll();
    }

    // ===========================
    // LÓGICA DE BUSCA
    // ===========================
    async handleSearch() {
        const formData = new FormData(document.getElementById('searchForm'));
        const selectedPills = document.querySelectorAll('#filial-pills .filial-pill.selected');
        const codFilial = Array.from(selectedPills).map(pill => pill.getAttribute('data-value'));

        if (codFilial.length === 0) {
            this.showError('Selecione ao menos uma filial.');
            return; 
        }

        // Ramo de atividade — vazio = sem filtro (todos)
        const selectedRamos = document.querySelectorAll('.ramo-pill.selected');
        const codAtividade = Array.from(selectedRamos).map(pill => parseInt(pill.getAttribute('data-value')));

        const params = {
            DataIni: this.formatDateForAPI(formData.get('DataIni')),
            DataFim: this.formatDateForAPI(formData.get('DataFim')),
            CodFilial: codFilial,
            ClienteCod: formData.get('ClienteCod').trim() || null,
            ClienteNome: formData.get('ClienteNome').trim() || null,
            Cnpj: formData.get('Cnpj')?.trim() || null,
            Municipio: formData.get('Municipio').trim() || null,
            CodAtividade: codAtividade.length > 0 ? codAtividade : null
        };

        this.showLoading(true);
        this.hideError();
        this.hideResults();

        try {
            const response = await fetch('/api/performance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });

            const result = await response.json();

            if (result.success) {
                this.currentData = result.data;
                // Prepara os dados para a tabela simplificada
                this.allVirtualizedData = this.groupDataForTable(result.data);
                this.virtualizedData = [...this.allVirtualizedData];
                this.currentBatch = 0;
                // Aplica filtro de classificação se houver algum selecionado
                this.aplicarFiltroClassificacao();
                document.getElementById('exportBtn').disabled = false;
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            this.showError('Erro: ' + error.message);
        } finally {
            this.showLoading(false);
        }
    }

    // ===========================
    // PROCESSAMENTO DE DADOS
    // ===========================
    
    // Função necessária para transformar os dados brutos na lista da tabela
    groupDataForTable(data) {
        if (!data) return [];
        const grouped = this.groupByClient(data);
        const list = [];
        Object.keys(grouped).forEach(key => {
            if (grouped[key] && grouped[key].length > 0) {
                // Pega o primeiro registro (o mais recente) do cliente
                list.push(grouped[key][0]);
            }
        });
        return list;
    }

    groupByClient(data) {
        const grouped = {};
        data.forEach(item => {
            const codCli = parseInt(item.CODCLI, 10);
            if (!codCli) return;
            if (!grouped[codCli]) grouped[codCli] = [];
            grouped[codCli].push(item);
        });
        return grouped;
    }

    // ===========================
    // EXIBIÇÃO & HTML
    // ===========================
    displayResults() {
        const summary = document.getElementById('summary');
        const resultsBody = document.getElementById('resultsBody');
        const dataIni = document.getElementById('DataIni').value;
        const dataFim = document.getElementById('DataFim').value;
        const totalClientes = this.virtualizedData.length;
        const totalRegistros = this.currentData.length;

        summary.innerHTML = `
            <div class="summary-grid">
                <div class="summary-card blue">
                    <div class="sc-icon"><i class="fas fa-users"></i></div>
                    <div class="sc-content">
                        <span class="sc-label">Total de Clientes</span>
                        <span class="sc-value">${totalClientes}</span>
                    </div>
                </div>
                <div class="summary-card purple">
                    <div class="sc-icon"><i class="far fa-calendar-alt"></i></div>
                    <div class="sc-content">
                        <span class="sc-label">Período</span>
                        <span class="sc-value" style="font-size:0.9rem">${dataIni} a ${dataFim}</span>
                    </div>
                </div>
                <div class="summary-card green">
                    <div class="sc-icon"><i class="far fa-file-alt"></i></div>
                    <div class="sc-content">
                        <span class="sc-label">Total de Registros</span>
                        <span class="sc-value">${totalRegistros}</span>
                    </div>
                </div>
                <div class="summary-card orange">
                    <div class="sc-icon"><i class="far fa-eye"></i></div>
                    <div class="sc-content">
                        <span class="sc-label">Modo</span>
                        <span class="sc-value" style="font-size:0.9rem">Visualização Completa</span>
                    </div>
                </div>
            </div>
        `;

        resultsBody.innerHTML = '';
        this.currentBatch = 0;
        this.loadMoreData();
        this.showResults();
    }

    async loadMoreData() {
        if (this.loadingMore) return;
        
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        
        if (!this.virtualizedData) return;

        const batch = this.virtualizedData.slice(start, end);

        if (batch.length === 0) return;

        const resultsBody = document.getElementById('resultsBody');
        
        batch.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = this.getMainRowHTML(item);
            resultsBody.appendChild(row);
        });

        this.currentBatch++;
    }

    // =========================================================
    // (Cálculo da Faixa)
    // =========================================================
    getClassificacao(media) {
        const n = parseFloat(media) || 0;
        if (n < 6.0) return 'BRONZE';
        if (n < 7.0) return 'PRATA';
        if (n < 8.0) return 'OURO';
        if (n < 9.0) return 'PLATINUM';
        return 'DIAMANTE';
    }

    // =========================================================
    // (Cálculo da Média 6 Meses Fechados)
    // =========================================================
    groupDataForTable(data) {
        if (!data) return [];
        const grouped = this.groupByClient(data);
        const list = [];
        
        // Datas para o cálculo (ignorar mês atual)
        const hoje = new Date();
        const mesAtual = hoje.getMonth() + 1;
        const anoAtual = hoje.getFullYear();

        Object.keys(grouped).forEach(key => {
            const historico = grouped[key];
            
            if (historico && historico.length > 0) {
                // Clona o objeto mais recente para usar como base
                const clienteObj = { ...historico[0] };

                // --- LÓGICA IDÊNTICA AO DETALHES-CLIENTE.JS ---
                
                // 1. Filtra apenas meses fechados (anteriores ao atual)
                const dadosFechados = historico.filter(item => {
                    const mesItem = parseInt(item.MES);
                    const anoItem = parseInt(item.ANO);
                    return anoItem < anoAtual || (anoItem === anoAtual && mesItem < mesAtual);
                });

                // 2. Pega os 6 últimos registros fechados
                const baseCalculo = dadosFechados.slice(0, 6);
                
                // 3. Calcula Média
                let mediaGeral = 0;
                if (baseCalculo.length > 0) {
                    const somaNotas = baseCalculo.reduce((sum, item) => sum + (parseFloat(item.MEDIA_PONDERADA) || 0), 0);
                    mediaGeral = somaNotas / baseCalculo.length;
                } else {
                    // Se não tiver histórico fechado, usa a média do registro atual ou 0
                    mediaGeral = parseFloat(clienteObj.MEDIA_PONDERADA) || 0;
                }

                // 4. Salva os valores calculados no objeto para usar na tabela
                clienteObj.MEDIA_CALCULADA = mediaGeral;
                clienteObj.CLASSIFICACAO_CALCULADA = this.getClassificacao(mediaGeral);

                list.push(clienteObj);
            }
        });
        return list;
    }

    // =========================================================
    // FILTRO DE CLASSIFICAÇÃO (client-side, sem nova requisição)
    // =========================================================
    aplicarFiltroClassificacao() {
        const selecionadas = Array.from(
            document.querySelectorAll('.classificacao-pill.selected')
        ).map(p => p.getAttribute('data-value'));

        // Nenhuma selecionada = mostra todos
        this.virtualizedData = selecionadas.length === 0
            ? [...this.allVirtualizedData]
            : this.allVirtualizedData.filter(item =>
                selecionadas.includes(item.CLASSIFICACAO_CALCULADA)
              );

        this.currentBatch = 0;
        this.displayResults();
    }

    // =========================================================
    // (Exibição na Tabela)
    // =========================================================
    getRamoAtividade(cod) {
        const mapa = {
            1:  { label: 'Comércio',            icon: 'fa-store',          cor: '#16a34a' },
            2:  { label: 'Indústria',            icon: 'fa-industry',       cor: '#9333ea' },
            3:  { label: 'Prest. Serviço',       icon: 'fa-screwdriver-wrench', cor: '#0891b2' },
            4:  { label: 'Produtor Rural',       icon: 'fa-tractor',        cor: '#ca8a04' },
            5:  { label: 'Pessoa Física',        icon: 'fa-user',           cor: '#64748b' },
            6:  { label: 'Outros',               icon: 'fa-circle-question',cor: '#94a3b8' },
            7:  { label: 'Fornecedores',         icon: 'fa-truck',          cor: '#ea580c' },
            8:  { label: 'Filiais',              icon: 'fa-building',       cor: '#475569' },
            9:  { label: 'Atacado',              icon: 'fa-boxes-stacked',  cor: '#1d4ed8' },
            10: { label: 'Revenda',              icon: 'fa-tags',           cor: '#0f766e' },
            11: { label: 'Serviços',             icon: 'fa-briefcase',      cor: '#7c3aed' },
            12: { label: 'Corp./Industrial',     icon: 'fa-building-columns', cor: '#be123c' },
        };
        const r = mapa[parseInt(cod)];
        if (!r) return `<span style="color:var(--text-muted); font-size:0.8rem;">-</span>`;
        return `<span style="display:inline-flex; align-items:center; gap:5px; font-size:0.78rem; font-weight:600; color:${r.cor};">
                    <i class="fas ${r.icon}"></i>${r.label}
                </span>`;
    }

    getMainRowHTML(item) {
        if (!item) return '';

        const dataIniInput = document.getElementById('DataIni');
        const dataFimInput = document.getElementById('DataFim');
        const dataIni = dataIniInput ? dataIniInput.value : '';
        const dataFim = dataFimInput ? dataFimInput.value : '';
        
        const selectedPills = document.querySelectorAll('.filial-pill.selected');
        const codFilialStr = Array.from(selectedPills).map(p => p.getAttribute('data-value')).join(',');

        // USA A MÉDIA CALCULADA (6 Meses) EM VEZ DA DO BANCO
        const media = parseFloat(item.MEDIA_CALCULADA) || 0;
        const classificacao = item.CLASSIFICACAO_CALCULADA || 'BRONZE';

        let scoreClass = 'score-low';
        if(media >= 8) scoreClass = 'score-high';
        else if(media >= 5) scoreClass = 'score-med';

        return `
            <td>
                <a href="/detalhes-cliente?codcli=${item.CODCLI}&dataIni=${dataIni}&dataFim=${dataFim}&codFilial=${codFilialStr}" class="client-link">
                    <strong>${item.CODCLI}</strong> - ${this.truncateText(item.FANTASIA || item.CLIENTE, 35)}
                </a>
            </td>
            <td>${item.MUNICENT || '-'}</td>
            <td>${item.ESTENT || '-'}</td>
            <td>${this.getRamoAtividade(item.COD_RAMO_ATIVIDADE)}</td>
            <td style="text-align:center">
                <div style="display:flex; flex-direction:column; align-items:center;">
                    <span class="badge-score ${scoreClass}">${media.toFixed(2)}</span>
                    <small style="font-size:0.65rem; color:var(--text-muted); margin-top:2px;">(6 Meses Fechados)</small>
                </div>
            </td>
            <td style="text-align:center">
                <span class="badge-class cls-${classificacao.toLowerCase()}">
                    <i class="fas fa-trophy"></i> ${classificacao}
                </span>
            </td>
            <td style="text-align:right">
                <a href="/detalhes-cliente?codcli=${item.CODCLI}&dataIni=${dataIni}&dataFim=${dataFim}&codFilial=${codFilialStr}" class="btn-details">
                    <i class="far fa-eye"></i> Ver Detalhes
                </a>
            </td>
        `;
    }

    // ===========================
    // HELPERS (AQUI ESTAVA O ERRO - ADICIONEI truncateText)
    // ===========================
    
    // Função que estava faltando
    truncateText(text, maxLength) {
        if (!text) return '-';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }

    setupInfiniteScroll() {
        const tableContainer = document.querySelector('.table-responsive'); 
        if (!tableContainer) return;

        const sentinel = document.createElement('div');
        sentinel.id = 'scroll-sentinel';
        sentinel.style.height = '20px';
        tableContainer.parentNode.appendChild(sentinel); 

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && this.virtualizedData.length > 0) {
                    this.loadMoreData();
                }
            });
        });
        observer.observe(sentinel);
    }

    formatDateForAPI(dateString) {
        if(!dateString.includes('-')) return dateString;
        const [year, month, day] = dateString.split('-');
        return `${day}/${month}/${year}`;
    }

async handleExport() {
        if (!this.currentData) return;

        this.showLoading(true);
        
        const btn = document.getElementById('exportBtn');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando Excel...';
        btn.disabled = true;

        try {
            // =================================================================
            // 1. PREPARAR DADOS AGRUPADOS (1 LINHA POR CLIENTE)
            // =================================================================
            const grouped = this.groupByClient(this.currentData);
            const listaExportacao = [];
            
            // Dados para cálculo da média fechada
            const hoje = new Date();
            const mesAtual = hoje.getMonth() + 1;
            const anoAtual = hoje.getFullYear();

            Object.keys(grouped).forEach(key => {
                const historico = grouped[key];
                if (!historico || historico.length === 0) return;

                const base = historico[0]; // Pega dados cadastrais do registro mais recente

                // A. Soma Totais Financeiros do período
                const totalLiquido = historico.reduce((acc, item) => acc + (parseFloat(item.VLLIQUIDO) || 0), 0);
                const totalFaturamento = historico.reduce((acc, item) => acc + (parseFloat(item.NOTA_AL) || 0), 0); // Assumindo que é valor
                
                // B. Calcula Média (Lógica dos 6 meses fechados)
                const dadosFechados = historico.filter(item => {
                    const mesItem = parseInt(item.MES);
                    const anoItem = parseInt(item.ANO);
                    return anoItem < anoAtual || (anoItem === anoAtual && mesItem < mesAtual);
                });

                const baseCalculo = dadosFechados.slice(0, 6);
                let mediaGeral = 0;
                if (baseCalculo.length > 0) {
                    const somaNotas = baseCalculo.reduce((sum, item) => sum + (parseFloat(item.MEDIA_PONDERADA) || 0), 0);
                    mediaGeral = somaNotas / baseCalculo.length;
                } else {
                    mediaGeral = parseFloat(base.MEDIA_PONDERADA) || 0;
                }

                // C. Cria o objeto consolidado para o Excel
                listaExportacao.push({
                    CODCLI: base.CODCLI,
                    CLIENTE: base.FANTASIA || base.CLIENTE,
                    MUNICENT: base.MUNICENT,
                    ESTENT: base.ESTENT,
                    // Removemos MES_ANO pois é um resumo
                    VLLIQUIDO: totalLiquido, // Agora é a soma do período
                    NOTA_AL: base.NOTA_AL,   // Mantém o último ou pode fazer média
                    NOTA_AM: base.NOTA_AM,
                    NOTA_AN: base.NOTA_AN,
                    NOTA_AO: base.NOTA_AO,
                    NOTA_AP: base.NOTA_AP,
                    NOTA_AQ: base.NOTA_AQ,
                    NOTA_AR: base.NOTA_AR,
                    NOTA_AS: base.NOTA_AS,
                    NOTA_AT: base.NOTA_AT,
                    NOTA_AU: base.NOTA_AU,
                    MEDIA_PONDERADA: mediaGeral, // Média calculada
                    CLASSIFICACAO: this.getClassificacao(mediaGeral) // Classificação recalculada
                });
            });

            // =================================================================

            const response = await fetch('/api/export-excel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: listaExportacao }) // Envia a lista agrupada
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = `Performance_Resumida_${new Date().toISOString().split('T')[0]}.xlsx`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                
                this.showNotification('Excel gerado com sucesso!');
            } else {
                const errJson = await response.json();
                throw new Error(errJson.error || 'Erro na geração do arquivo');
            }
        } catch (error) {
            console.error(error);
            this.showError('Erro ao exportar: ' + error.message);
        } finally {
            this.showLoading(false);
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }

    showLoading(show) {
        const loading = document.getElementById('loading');
        const video = document.getElementById('loadingVideo');
        if (show) {
            loading.classList.remove('hidden');
            if (video) video.play().catch(() => {});
        } else {
            loading.classList.add('hidden');
            if (video) video.pause();
        }
    }

    showResults() { document.getElementById('results').classList.remove('hidden'); }
    hideResults() { document.getElementById('results').classList.add('hidden'); }
    
    showError(msg) { 
        const el = document.getElementById('error'); 
        document.getElementById('errorMessage').textContent = msg; 
        el.classList.remove('hidden'); 
        setTimeout(() => this.hideError(), 5000); 
    }
    
    hideError() { document.getElementById('error').classList.add('hidden'); }

    // ===========================
    // NOTIFICAÇÃO DE SUCESSO (TOAST)
    // ===========================
    showNotification(message) {
        // Cria o elemento visual dinamicamente
        const div = document.createElement('div');
        div.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
        
        // Estilo "Inline" para garantir que apareça bonito sem mexer no CSS agora
        div.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background-color: #10b981; /* Verde Sucesso */
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 9999;
            display: flex;
            align-items: center;
            gap: 10px;
            font-family: 'Inter', sans-serif;
            font-weight: 600;
            animation: slideInToast 0.3s ease-out;
        `;
        
        // Adiciona animação simples no CSS da página temporariamente
        if (!document.getElementById('toast-style')) {
            const style = document.createElement('style');
            style.id = 'toast-style';
            style.innerHTML = `@keyframes slideInToast { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
            document.head.appendChild(style);
        }

        document.body.appendChild(div);

        // Remove automaticamente após 3 segundos
        setTimeout(() => {
            div.style.transition = "opacity 0.5s ease";
            div.style.opacity = "0";
            setTimeout(() => div.remove(), 500);
        }, 3000);
    }
}

// ===========================
// FAVICON REDONDO AUTOMÁTICO
// ===========================
(function makeFaviconCircular() {
    const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.type = 'image/png';
    link.rel = 'icon';
    document.head.appendChild(link);

    const img = new Image();
    img.src = 'img/logo.png'; // Caminho da sua logo

    img.onload = function() {
        // Cria um canvas (tela de pintura invisível)
        const canvas = document.createElement('canvas');
        const size = 64; // Tamanho padrão bom para favicon
        canvas.width = size;
        canvas.height = size;
        
        const ctx = canvas.getContext('2d');
        
        // Desenha o círculo (A máscara de corte)
        ctx.beginPath();
        ctx.arc(size/2, size/2, size/2, 0, 2 * Math.PI);
        ctx.closePath();
        ctx.clip(); // Tudo desenhado depois disso será cortado no círculo

        // Desenha a imagem dentro do círculo
        ctx.drawImage(img, 0, 0, size, size);

        // Atualiza o ícone da aba com a nova imagem redonda
        link.href = canvas.toDataURL();
    };
})();

document.addEventListener('DOMContentLoaded', () => new PerformanceApp());

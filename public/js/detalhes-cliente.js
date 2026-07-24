class DetalhesCliente {
    constructor() {
        this.clienteData = null;
        this.clienteCod = null;
        this.originalData = null;
        this.dataIni = null;
        this.dataFim = null;
        this.chart = null; // Referência para o gráfico principal
        this.productsChart = null; // Referência para o gráfico de produtos
        this.ordersChart = null; // Referência para o gráfico de pedidos
        this.produtosInsights = null;
        this.pedidosInsights = null;
        this.chartTooltipData = [];
        this.productsTooltipData = [];
        this.ordersTooltipData = [];
        this.ordersTooltipPinned = false;
        this.ordersTooltipHideTimer = null;
        this.ordersTableData = [];
        this.orderModalEls = null;
        this.aiChat = {
            isOpen: false,
            isSending: false,
            history: [],
            portal: null,
            layoutBound: false,
            handleViewportLayout: null,
            teaserTimer: null,
            teaserSwapTimer: null,
            teaserIndex: 0,
            teaserMinimized: false,
            teaserStorageKey: 'detalhesClienteAiTeaserMinimized',
            teaserPhrases: [
                'Em que posso ajudar agora?',
                'Quer uma sugestão de pedido?',
                'Posso montar um script de abordagem.',
                'Quer ver oportunidades deste cliente?',
                'Posso sugerir produtos com mais chance.',
                'Quer melhorar a nota deste cliente?',
                'Posso indicar um mix mais estratégico.'
            ]
        };
        this.aiMarkdownConfigured = false;
        this.rcaAtualInfo = null;
        this.aiEls = null;
        this.codFilial = [];
        this.currentPeriod = 'all';
        this.produtosInsightsCache = new Map();
        this.pedidosInsightsCache = new Map();
        this._insightsRequestSeq = 0;
        this.basePeriodo = { dataIni: null, dataFim: null };
        const rawTheme = localStorage.getItem("theme");
        this.theme = rawTheme === "light" ? "light" : "default"; // default = dark
        if (rawTheme === "dark") localStorage.setItem("theme", "default");

        this.init();
    }

    init() {
        // Inicializa tema antes de tudo
        this.initTheme();
        
        this.getClientFromURL();
        this.bindEvents();
        this.initOrderModal();
        this.initAiChatWidget();
        this.loadClientDetails();
    }

    // ===========================
    // LÓGICA DE TEMA (Do app.js)
    // ===========================
    initTheme() {
        const resolvedTheme = this.theme === "light" ? "light" : "dark";
        document.body.classList.remove("dark", "light");
        document.body.classList.add(resolvedTheme);
        document.body.dataset.theme = resolvedTheme;
        document.documentElement.dataset.theme = resolvedTheme;
        document.documentElement.style.colorScheme = resolvedTheme;
        this.updateThemeIcon();
    }
    toggleTheme() {
        this.theme = this.theme === "light" ? "default" : "light";
        const resolvedTheme = this.theme === "light" ? "light" : "dark";
        localStorage.setItem("theme", this.theme);
        document.body.classList.remove("dark", "light");
        document.body.classList.add(resolvedTheme);
        document.body.dataset.theme = resolvedTheme;
        document.documentElement.dataset.theme = resolvedTheme;
        document.documentElement.style.colorScheme = resolvedTheme;
        this.updateThemeIcon();

        if (this.clienteData) this.renderChart();
        if (this.productsChart || this.produtosInsights) this.renderTopProductsChart();
        if (this.pedidosInsights) this.renderOrdersTable();
    }

    updateThemeIcon() {
        const themeBtn = document.getElementById("theme-toggle");
        if (themeBtn) {
            themeBtn.innerHTML = this.theme === "light"
                ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>'
                : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
        }
    }

    // ===========================
    // LÓGICA EXISTENTE & NOVAS FUNÇÕES
    // ===========================
    getClientFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        this.clienteCod = urlParams.get('codcli');
        this.dataIni = urlParams.get('dataIni');
        this.dataFim = urlParams.get('dataFim');
        
        // 2. Lógica para pegar as filiais da URL
        const filiaisStr = urlParams.get('codFilial');
        if (filiaisStr) {
            // Converte "1,3,5" em [1, 3, 5]
            this.codFilial = filiaisStr.split(',').map(num => parseInt(num.trim(), 10));
        } else {
            // Fallback (Padrão) caso não venha na URL
            this.codFilial = [1, 3];
        }
        
        if (!this.clienteCod) {
            this.showError('Código do cliente não especificado na URL.');
            return;
        }
    }

    bindEvents() {
        document.getElementById('backBtn').addEventListener('click', () => {
            window.history.back();
        });

        document.getElementById('exportDetailsBtn').addEventListener('click', () => {
            this.exportDetails();
        });

        // Botão de Tema
        const themeBtn = document.getElementById("theme-toggle");
        if(themeBtn) {
            themeBtn.addEventListener("click", () => this.toggleTheme());
        }
         // NOVO: Eventos dos Filtros
        document.querySelectorAll('.btn-filter').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Remove active de todos e adiciona no clicado
                document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                
                // Aplica o filtro
                const period = e.target.getAttribute('data-period');
                this.applyFilter(period);
            });
        });
    }
    async loadClientDetails() {
        if (!this.clienteCod) return;

        this.showLoading(true);
        this.hideError();

        try {
            let dataIni, dataFim;

            if (this.dataIni && this.dataFim) {
                const dateIniParts = this.dataIni.split('-');
                const dateFimParts = this.dataFim.split('-');
                dataIni = this.formatDateForAPI(new Date(dateIniParts[0], dateIniParts[1] - 1, dateIniParts[2]));
                dataFim = this.formatDateForAPI(new Date(dateFimParts[0], dateFimParts[1] - 1, dateFimParts[2]));
            } else {
                const today = new Date();
                const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
                dataIni = this.formatDateForAPI(firstDay);
                dataFim = this.formatDateForAPI(today);
            }
            this.basePeriodo = { dataIni, dataFim };

            const response = await fetch('/api/detalhes-cliente', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ClienteCod: this.clienteCod,
                    DataIni: dataIni,
                    DataFim: dataFim,
                    CodFilial: this.codFilial
                })
            });

            const result = await response.json();

            if (result.success) {
                this.clienteData = result.data;
                this.originalData = result.data;
                this.produtosInsights = result.produtosInsights || { topProdutos: [], sugestoes: [], resumo: {} };
                this.pedidosInsights = result.pedidosInsights || { pedidos: [], resumo: {} };
                this.currentPeriod = 'all';
                this.produtosInsightsCache.clear();
                this.produtosInsightsCache.set('all', this.produtosInsights);
                this.pedidosInsightsCache.clear();
                this.pedidosInsightsCache.set('all', this.pedidosInsights);

                this.displayClientInfo();
                this.refreshUI();
                this.buscarRcaAtual();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            this.showError('Erro ao carregar detalhes do cliente: ' + error.message);
            console.error(error);
        } finally {
            this.showLoading(false);
        }
    }
    // ===========================
    // NOVO: Busca RCA atual via endpoint dedicado
    // ===========================
    async buscarRcaAtual() {
        try {
            const response = await fetch(`/api/rca-atual/${this.clienteCod}`);
            const result = await response.json();

            if (result.success) {
                const nomeExibicao = result.nomeRca && result.nomeRca !== '-'
                    ? `${result.nomeRca} (${result.codRca})`
                    : '-';

                this.rcaAtualInfo = {
                    codRca: Number(result.codRca || 0) || null,
                    nomeRca: this.sanitizeRcaNome((result.nomeRca && result.nomeRca !== '-') ? result.nomeRca : null),
                };

                // Atualiza só o campo RCA dentro do clientInfo já renderizado
                const infoItems = document.querySelectorAll('#clientInfo .info-item');
                infoItems.forEach(item => {
                    const label = item.querySelector('.info-label');
                    if (label && label.textContent.trim() === 'RCA') {
                        item.querySelector('.info-value').textContent = nomeExibicao;
                    }
                });
            }
        } catch (error) {
            console.warn('[DetalhesCliente] Erro ao buscar RCA atual:', error);
        }
    }

    
    async applyFilter(period) {
        if (!this.originalData) return;
        this.currentPeriod = period || 'all';
        const dataOrdenada = this.getDataOrdenadaDesc();

        if (this.currentPeriod === 'all') {
            this.clienteData = [...dataOrdenada];
        } else {
            // Pega os N primeiros registros (considerando que a API retorna ordenado por data DESC)
            const count = parseInt(this.currentPeriod, 10);
            this.clienteData = dataOrdenada.slice(0, count);
        }

        await this.refreshProdutosInsightsPorPeriodo(this.currentPeriod);
        this.refreshUI();
    }

    getDataOrdenadaDesc() {
        if (!Array.isArray(this.originalData)) return [];
        return [...this.originalData].sort((a, b) => {
            const anoDiff = Number(b.ANO) - Number(a.ANO);
            if (anoDiff !== 0) return anoDiff;
            return Number(b.MES) - Number(a.MES);
        });
    }

    getDateRangeForPeriod(period) {
        const fallbackIni = this.basePeriodo?.dataIni || null;
        const fallbackFim = this.basePeriodo?.dataFim || null;
        const dataOrdenada = this.getDataOrdenadaDesc();

        if (!dataOrdenada.length) {
            return { dataIni: fallbackIni, dataFim: fallbackFim };
        }

        const subset = period === 'all'
            ? dataOrdenada
            : dataOrdenada.slice(0, Math.max(1, parseInt(period, 10) || dataOrdenada.length));

        if (!subset.length) {
            return { dataIni: fallbackIni, dataFim: fallbackFim };
        }

        const maisRecente = subset[0];
        const maisAntigo = subset[subset.length - 1];

        const dtIni = new Date(Number(maisAntigo.ANO), Number(maisAntigo.MES) - 1, 1);
        let dtFim = new Date(Number(maisRecente.ANO), Number(maisRecente.MES), 0);
        const hoje = new Date();
        if (dtFim > hoje) dtFim = hoje;

        return {
            dataIni: this.formatDateForAPI(dtIni),
            dataFim: this.formatDateForAPI(dtFim),
        };
    }

    setProdutosInsightsLoading() {
        const summaryEl = document.getElementById('productsInsightsSummary');
        if (summaryEl) summaryEl.textContent = 'Atualizando...';

        const ordersSummaryEl = document.getElementById('ordersTimelineSummary');
        if (ordersSummaryEl) ordersSummaryEl.textContent = 'Atualizando...';

        const sugestoesEl = document.getElementById('productSuggestions');
        if (sugestoesEl) {
            sugestoesEl.innerHTML = '<div class="products-suggestions-empty">Atualizando dados do período...</div>';
        }
    }

    async refreshProdutosInsightsPorPeriodo(period) {
        const cacheKey = String(period || 'all');

        if (this.produtosInsightsCache.has(cacheKey) && this.pedidosInsightsCache.has(cacheKey)) {
            this.produtosInsights = this.produtosInsightsCache.get(cacheKey);
            this.pedidosInsights = this.pedidosInsightsCache.get(cacheKey);
            this.renderProductInsights();
            return;
        }

        const { dataIni, dataFim } = this.getDateRangeForPeriod(cacheKey);
        if (!dataIni || !dataFim || !this.clienteCod) return;

        this.setProdutosInsightsLoading();
        const requestSeq = ++this._insightsRequestSeq;

        try {
            const response = await fetch('/api/detalhes-cliente', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ClienteCod: this.clienteCod,
                    DataIni: dataIni,
                    DataFim: dataFim,
                    CodFilial: this.codFilial
                })
            });

            const result = await response.json();
            if (requestSeq !== this._insightsRequestSeq) return;

            if (!result.success) {
                throw new Error(result.error || 'Falha ao atualizar produtos por período');
            }

            const insights = result.produtosInsights || { topProdutos: [], sugestoes: [], resumo: {} };
            const pedidosInsights = result.pedidosInsights || { pedidos: [], resumo: {} };
            this.produtosInsights = insights;
            this.pedidosInsights = pedidosInsights;
            this.produtosInsightsCache.set(cacheKey, insights);
            this.pedidosInsightsCache.set(cacheKey, pedidosInsights);
            this.renderProductInsights();
        } catch (error) {
            if (requestSeq !== this._insightsRequestSeq) return;
            console.warn('[DetalhesCliente] Erro ao atualizar insights de produtos por período:', error);
            this.renderProductInsights();
        }
    }

    
    refreshUI() {
        this.displayMonthlyStats();
        this.displayPerformanceComparison(); 
        this.displayDetailsTable();
        this.renderChart();
        this.renderProductInsights();
    }

    displayClientInfo() {
        if (!this.clienteData || this.clienteData.length === 0) {
            this.showError('Nenhum dado encontrado para este cliente.');
            return;
        }

        const reg = this.clienteData[0];
        
        document.getElementById('clientTitle').innerHTML = `
            <h2>${reg.CLIENTE}</h2>
            <p>COD: ${reg.CODCLI}</p>
        `;

        // Layout atualizado conforme CSS novo
        document.getElementById('clientInfo').innerHTML = `
            <div class="info-item">
                <span class="info-label">Município</span>
                <span class="info-value">${reg.MUNICENT || '-'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Estado</span>
                <span class="info-value">${reg.ESTENT || '-'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Ramo Atividade</span>
                <span class="info-value">${reg.RAMO_ATIVIDADE || '-'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">RCA</span>
                <span class="info-value">${reg.NOME_ULTIMO_RCA || '-'}</span>
            </div>
        `;

const catEl = document.getElementById('labelCategoria');
        if (catEl) {
            // Pega CATEGORIA ou categoria (converte para maiúsculo para garantir)
            const catRaw = reg.CATEGORIA || reg.categoria || 'N/A';
            const cat = catRaw.toUpperCase().trim();
            
            catEl.textContent = cat;
            
            // Definição de Cores por Classificação
            switch(cat) {
                case 'BRONZE':
                    catEl.style.color = '#D35400'; // Tom terroso/laranja escuro
                    break;
                case 'PRATA':
                    catEl.style.color = '#7F8C8D'; // Cinza metálico (Slate)
                    break;
                case 'OURO':
                    catEl.style.color = '#F39C12'; // Dourado/Laranja forte (para leitura)
                    break;
                case 'PLATINUM':
                    catEl.style.color = '#2C3E50'; // Azul petróleo escuro/Cinza nobre
                    break;
                case 'DIAMANTE':
                    catEl.style.color = '#0984E3'; // Azul Royal Brilhante
                    break;
                case 'VIP':
                    catEl.style.color = '#00B894'; // Verde Água (Teal)
                    break;
                default:
                    catEl.style.color = 'var(--text-dark)'; // Cor padrão do sistema
            }
        }
    }

displayMonthlyStats() {
        // Precisa ter dados para calcular
        if (!this.clienteData || !this.originalData) return;

        // 1. TOTAIS FINANCEIROS:
        // Continuam usando 'this.clienteData' (o filtrado). 
        // Se o usuário filtrou 3 meses, ele quer ver o total vendido nesses 3 meses.
        const totalFrete = this.clienteData.reduce((sum, item) => sum + (parseFloat(item.VL_FRETE_TOTAL_PEDIDOS) || 0), 0);
        const totalLiquido = this.clienteData.reduce((sum, item) => sum + (parseFloat(item.VLLIQUIDO) || 0), 0);
        
        // 2. MÉDIA DE PERFORMANCE (KPI):
        // AQUI ESTÁ A MUDANÇA: Usamos 'this.originalData' (dados completos).
        // Assim, mesmo filtrando a tela, a nota do cliente continua sendo a "real" (últimos 6 meses fechados).
        
        const hoje = new Date();
        const mesAtual = hoje.getMonth() + 1; 
        const anoAtual = hoje.getFullYear();

        // Filtra na lista COMPLETA (originalData)
        const dadosFechados = this.originalData.filter(item => {
            const mesItem = parseInt(item.MES);
            const anoItem = parseInt(item.ANO);
            
            // Ignora mês atual/futuro
            return anoItem < anoAtual || (anoItem === anoAtual && mesItem < mesAtual);
        });

        // Pega os 6 últimos fechados da lista completa
        const baseCalculo = dadosFechados.slice(0, 6);
        
        const somaNotas = baseCalculo.reduce((sum, item) => sum + (parseFloat(item.MEDIA_PONDERADA) || 0), 0);
        // Evita divisão por zero
        const mediaGeral = baseCalculo.length > 0 ? (somaNotas / baseCalculo.length) : 0;
        this.renderProximoNivel(mediaGeral);
        const classificacaoFinal = this.getClassificacao(mediaGeral);

        // Renderiza
        document.getElementById('monthlyStats').innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${this.clienteData.length}</div>
                <div class="stat-label">Meses na Tela</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">R$ ${this.formatMoney(totalLiquido)}</div>
                <div class="stat-label">Total Líquido</div>
            </div>
            <!-- CARD ALTERADO PARA FRETE -->
            <div class="stat-card">
                <div class="stat-value">R$ ${this.formatMoney(totalFrete)}</div>
                <div class="stat-label">Total Frete</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="font-size: 1.25rem;">
                    <span class="classification-badge classification-${classificacaoFinal.toLowerCase()}">
                        ${classificacaoFinal}
                    </span> 
                    ${mediaGeral.toFixed(2)}
                </div>
                <div class="stat-label">Média (Últ. 6 Meses Fechados)</div>
            </div>
        `;
    }

    displayDetailsTable() {
        const detailsBody = document.getElementById('detailsBody');
        detailsBody.innerHTML = '';

        if (!this.clienteData) return;

        let tVenda = 0, tDev = 0, tLiq = 0, tFrete = 0, tMediaSoma = 0;

        this.clienteData.forEach(item => {
            const venda = parseFloat(item.VLVENDA) || 0;
            const devolucao = parseFloat(item.VLDEVOLUCAO) || 0;
            const liquido = parseFloat(item.VLLIQUIDO) || 0;
            const frete = parseFloat(item.VL_FRETE_TOTAL_PEDIDOS) || 0;
            const media = parseFloat(item.MEDIA_PONDERADA) || 0;

            tVenda += venda; tDev += devolucao; tLiq += liquido; tFrete += frete; tMediaSoma += media;

            const isActive = liquido > 0.01;
            const rowClass = isActive ? '' : 'row-inactive';
            
            let classBadge = isActive 
                ? `<span class="classification-badge classification-${this.getClassificacao(media).toLowerCase()}">${this.getClassificacao(media)}</span>`
                : `<span class="classification-badge classification-bronze" style="opacity:0.7">BRONZE</span>`;

            const showScore = (val) => isActive ? this.formatScore(val) : '<span style="color:#cbd5e1">-</span>';
            const showFinal = (val) => isActive ? `<strong>${val.toFixed(2)}</strong>` : '0.00';

            const row = document.createElement('tr');
            row.className = rowClass;
            
            row.innerHTML = `
                <td><strong>${this.getMonthName(item.MES)}/${item.ANO}</strong></td>
                <td>${showScore(item.NOTA_AL)}</td>
                <td>${showScore(item.NOTA_AM)}</td>
                <td>${showScore(item.NOTA_AN)}</td>
                <td>${showScore(item.NOTA_AO)}</td>
                <td>${showScore(item.NOTA_AP)}</td>
                <td>${showScore(item.NOTA_AQ)}</td>
                <td>${showScore(item.NOTA_AR)}</td>
                <td>${showScore(item.NOTA_AS)}</td>
                <td>${showScore(item.NOTA_AT)}</td>
                <td>${showScore(item.NOTA_AU)}</td>
                <td>${showFinal(media)}</td>
                <td>${classBadge}</td>
                <td>${this.formatCurrency(devolucao)}</td>
                <td>${this.formatCurrency(liquido)}</td>
                <td>${this.formatCurrency(frete)}</td>
            `;
            detailsBody.appendChild(row);
        });

        // Totais
        const mediaFinal = this.clienteData.length > 0 ? (tMediaSoma / this.clienteData.length) : 0;
        
        const totalRow = document.createElement('tr');
        totalRow.className = 'total-row';
        totalRow.innerHTML = `
            <td>TOTAL</td>
            <td colspan="10"></td>
            <td>${mediaFinal.toFixed(2)}</td>
            <td>${this.getClassificacao(mediaFinal)}</td>
            <td>${this.formatCurrency(tDev)}</td>
            <td>${this.formatCurrency(tLiq)}</td>
            <td>${this.formatCurrency(tFrete)}</td>
        `;
        detailsBody.appendChild(totalRow);
    }

    // ===========================
    // GRÁFICO COM TOOLTIP CUSTOMIZADO
    // ===========================
    renderChart() {
        const ctx = document.getElementById("performanceChart");
        if (!ctx || !this.clienteData) return;

        const isDark = this.theme !== "light";
        
        // Dados invertidos (Cronológicos)
        const dataCronologica = [...this.clienteData].reverse();
        this.chartTooltipData = dataCronologica;

        const labels = dataCronologica.map(item => `${this.getMonthNameShort(item.MES)}/${item.ANO}`);
        const values = dataCronologica.map(item => parseFloat(item.MEDIA_PONDERADA) || 0);

        // Configuração de Cores
        const colors = {
            grid: isDark ? "rgba(100, 116, 139, 0.2)" : "rgba(0, 0, 0, 0.05)",
            line: isDark ? "#818cf8" : "#8b5cf6", // Roxo suave
            point: isDark ? "#a78bfa" : "#7c3aed",
            bg: isDark ? "rgba(139, 92, 246, 0.1)" : "rgba(139, 92, 246, 0.05)",
        };

        // --- LÓGICA DO TOOLTIP EXTERNO ---
        const getOrCreateTooltip = (chart) => {
            let tooltipEl = document.getElementById('chartjs-tooltip');
            if (!tooltipEl) {
                tooltipEl = document.createElement('div');
                tooltipEl.id = 'chartjs-tooltip';
                document.body.appendChild(tooltipEl);
            }
            return tooltipEl;
        };

        const externalTooltipHandler = (context) => {
            // Tooltip Element
            const {chart, tooltip} = context;
            const tooltipEl = getOrCreateTooltip(chart);

            // Esconder se não houver tooltip ativo
            if (tooltip.opacity === 0) {
                tooltipEl.style.opacity = 0;
                return;
            }

            // LOG PARA DEBUG: Ver se a função está sendo chamada
            // Abra o Console (F12) e passe o mouse. Se não aparecer nada, a função não está rodando.
            // console.log("Tooltip Ativo!", tooltip.body); 

            if (tooltip.body) {
                const dataIndex = tooltip.dataPoints[0].dataIndex;
                const item = this.chartTooltipData[dataIndex];

                if(item) {

                    const media = parseFloat(item.MEDIA_PONDERADA) || 0;
                    const classificacao = this.getClassificacao(media);
                    const getColor = (val) => { const v = parseFloat(val); return v >= 8 ? 'val-green' : (v >= 5 ? 'val-blue' : 'val-orange'); };
                    const fmt = (val) => parseFloat(val).toFixed(1);

                    tooltipEl.innerHTML = `
                        <div class="tooltip-header">
                            <div><strong>${this.getMonthName(item.MES)}/${item.ANO}</strong></div>
                            <div style="margin-top:4px">
                                <span class="classification-badge classification-${classificacao.toLowerCase()}">${classificacao}</span>
                                <span style="margin-left:8px; font-weight:bold; color:#a855f7">Média: ${media.toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="tooltip-body">
                            <div class="tooltip-metric"><span class="t-label">Fat:</span> <span class="t-val ${getColor(item.NOTA_AL)}">${fmt(item.NOTA_AL)}</span></div>
                            <div class="tooltip-metric"><span class="t-label">Dev:</span> <span class="t-val ${getColor(item.NOTA_AM)}">${fmt(item.NOTA_AM)}</span></div>
                            <div class="tooltip-metric"><span class="t-label">Frete:</span> <span class="t-val ${getColor(item.NOTA_AN)}">${fmt(item.NOTA_AN)}</span></div>
                            <div class="tooltip-metric"><span class="t-label">Mix:</span> <span class="t-val ${getColor(item.NOTA_AO)}">${fmt(item.NOTA_AO)}</span></div>
                            <div class="tooltip-metric"><span class="t-label">Vol:</span> <span class="t-val ${getColor(item.NOTA_AP)}">${fmt(item.NOTA_AP)}</span></div>
                            <div class="tooltip-metric"><span class="t-label">Prazo:</span> <span class="t-val ${getColor(item.NOTA_AQ)}">${fmt(item.NOTA_AQ)}</span></div>
                        </div>
                        <div class="tooltip-footer">
                            <div style="display:flex; justify-content:space-between"><span>Venda:</span> <span class="val-blue">${this.formatCurrency(parseFloat(item.VLVENDA))}</span></div>
                            <div style="display:flex; justify-content:space-between"><span>Líquido:</span> <span class="val-blue">${this.formatCurrency(parseFloat(item.VLLIQUIDO))}</span></div>
                        </div>
                    `;
                }
            }

            const position = context.chart.canvas.getBoundingClientRect();
            
            // CORREÇÃO DE POSICIONAMENTO
            // Usamos pageXOffset e pageYOffset para garantir que funcione com scroll
            const left = position.left + window.pageXOffset + tooltip.caretX;
            const top = position.top + window.pageYOffset + tooltip.caretY;

            tooltipEl.style.opacity = 1;
            tooltipEl.style.position = 'absolute';
            tooltipEl.style.left = left + 'px';
            tooltipEl.style.top = top + 'px';
            tooltipEl.style.pointerEvents = 'none'; // Reforçando via JS
        };

        const chartAnimation = {
            duration: 650,
            easing: 'easeOutCubic'
        };

        if (this.chart) {
            this.chart.data.labels = labels;
            this.chart.data.datasets[0].data = values;
            this.chart.data.datasets[0].borderColor = colors.line;
            this.chart.data.datasets[0].backgroundColor = colors.bg;
            this.chart.data.datasets[0].pointBackgroundColor = colors.point;

            this.chart.options.plugins.tooltip.external = externalTooltipHandler;
            this.chart.options.animation = chartAnimation;
            this.chart.options.scales.x.grid.color = colors.grid;
            this.chart.options.scales.x.ticks.color = isDark ? "#cbd5e1" : "#64748b";
            this.chart.options.scales.y.grid.color = colors.grid;
            this.chart.options.scales.y.ticks.color = isDark ? "#cbd5e1" : "#64748b";
            this.chart.update();
            return;
        }

        this.chart = new Chart(ctx, {
            type: "line",
            data: {
                labels: labels,
                datasets: [{
                    label: "Média Mensal",
                    data: values,
                    borderColor: colors.line,
                    backgroundColor: colors.bg,
                    borderWidth: 3,
                    fill: true,
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    pointBackgroundColor: colors.point,
                    pointBorderColor: "#fff",
                    pointBorderWidth: 2,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: chartAnimation,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false, // DESATIVA O TOOLTIP PADRÃO
                        position: 'nearest',
                        external: externalTooltipHandler // USA O NOSSO
                    }
                },
                scales: {
                    x: {
                        grid: { color: colors.grid, drawBorder: false },
                        ticks: { color: isDark ? "#cbd5e1" : "#64748b" }
                    },
                    y: {
                        min: 0,
                        max: 10, // Nota máxima
                        grid: { color: colors.grid, drawBorder: false },
                        ticks: { color: isDark ? "#cbd5e1" : "#64748b" }
                    }
                }
            }
        });
    }

    renderProductInsights() {
        this.renderTopProductsChart();
        this.renderOrdersTable();
        this.renderProductSuggestions();
        this.renderProductsSummary();
    }

    getClienteAtualRegistro() {
        return Array.isArray(this.clienteData) && this.clienteData.length
            ? (this.clienteData[0] || {})
            : {};
    }

    getCategoriaWinthorAtual() {
        const primeiro = this.getClienteAtualRegistro();
        const categoriasValidas = ['BRONZE', 'PRATA', 'OURO', 'PLATINUM', 'DIAMANTE'];
        const categoria = String(primeiro.CATEGORIA || primeiro.categoria || '')
            .trim()
            .toUpperCase();

        if (categoriasValidas.includes(categoria)) {
            return categoria;
        }

        const media = Number(primeiro.MEDIA_PONDERADA || primeiro.media_ponderada || 0) || 0;
        const fallback = this.getClassificacao(media);
        return categoriasValidas.includes(fallback) ? fallback : null;
    }

    getPerfilPrecificacaoAtual() {
        const primeiro = this.getClienteAtualRegistro();
        const codRamo = Number(primeiro.COD_RAMO_ATIVIDADE || primeiro.cod_ramo_atividade || 0) || 0;
        if (codRamo === 10) return 'REVENDA';
        if (codRamo === 11) return 'SERVICOS';
        if (codRamo === 12) return 'CORPORATIVO';

        const ramoTexto = String(primeiro.RAMO_ATIVIDADE || primeiro.ramo_atividade || '')
            .trim()
            .toUpperCase();
        if (ramoTexto.includes('REVENDA')) return 'REVENDA';
        if (ramoTexto.includes('SERVI')) return 'SERVICOS';
        if (ramoTexto.includes('CORPORAT') || ramoTexto.includes('INDUSTR')) return 'CORPORATIVO';

        return null;
    }

    getTabelaPrecificacaoCategoria(perfil) {
        return [
            { categoria: 'BRONZE', ordem: 1, descontoTabela: 0.01, descontoEmbalagem: 0.05, descontoPix: 0.05 },
            { categoria: 'PRATA', ordem: 2, descontoTabela: 0.02, descontoEmbalagem: 0.05, descontoPix: 0.06 },
            { categoria: 'OURO', ordem: 3, descontoTabela: 0.03, descontoEmbalagem: 0.05, descontoPix: 0.07 },
            { categoria: 'PLATINUM', ordem: 4, descontoTabela: 0.04, descontoEmbalagem: 0.05, descontoPix: 0.10 },
            { categoria: 'DIAMANTE', ordem: 5, descontoTabela: 0.05, descontoEmbalagem: 0.05, descontoPix: 0.10 },
        ];
    }

    getFatorPrecoCategoria(regra) {
        if (!regra) return null;
        const descontoTabela = Number(regra.descontoTabela || 0);
        const descontoEmbalagem = Number(regra.descontoEmbalagem || 0);
        const descontoPix = Number(regra.descontoPix || 0);

        const fator = (1 - descontoTabela) * (1 - descontoEmbalagem) * (1 - descontoPix);
        return fator > 0 ? fator : null;
    }

    getPrecoReferenciaProduto(item) {
        const codprod = Number(item?.codprod || 0) || 0;
        const pedidos = Array.isArray(this.pedidosInsights?.pedidos) ? this.pedidosInsights.pedidos : [];
        let melhor = null;

        for (const pedido of pedidos) {
            const itens = Array.isArray(pedido?.itens) ? pedido.itens : [];
            const itemPedido = itens.find((it) => Number(it?.codprod || 0) === codprod);
            if (!itemPedido) continue;

            const qtd = Number(itemPedido.qtd || 0);
            const valorTotal = Number(itemPedido.valorTotal || 0);
            if (!(qtd > 0) || !(valorTotal > 0)) continue;

            const dt = pedido?.dataPedido ? new Date(pedido.dataPedido).getTime() : 0;
            const numped = Number(pedido?.numped || 0) || 0;

            if (!melhor || dt > melhor.dt || (dt === melhor.dt && numped > melhor.numped)) {
                melhor = {
                    unitPrice: valorTotal / qtd,
                    source: 'ULTIMA_COMPRA',
                    dataPedido: pedido?.dataPedido || null,
                    numped,
                    dt,
                };
            }
        }

        if (melhor?.unitPrice > 0) {
            return melhor;
        }

        const qtdTotal = Number(item?.qtdTotal || 0);
        const valorTotal = Number(item?.valorTotal || 0);
        if (qtdTotal > 0 && valorTotal > 0) {
            return {
                unitPrice: valorTotal / qtdTotal,
                source: 'MEDIA_PERIODO',
                dataPedido: item?.ultimaCompra || null,
                numped: null,
                dt: item?.ultimaCompra ? new Date(item.ultimaCompra).getTime() : 0,
            };
        }

        return null;
    }

    montarComparativoCategoriaProduto(item) {
        const perfil = this.getPerfilPrecificacaoAtual();
        const categoriaAtual = this.getCategoriaWinthorAtual();
        const tabela = this.getTabelaPrecificacaoCategoria(perfil);
        const precoRef = this.getPrecoReferenciaProduto(item);

        if (!precoRef?.unitPrice || !(precoRef.unitPrice > 0)) {
            return null;
        }

        if (!tabela) {
            return {
                available: false,
                perfil,
                categoriaAtual,
                precoAtual: precoRef.unitPrice,
                fontePreco: precoRef.source,
                dataPreco: precoRef.dataPedido || null,
                motivo: 'PERFIL_NAO_SUPORTADO',
            };
        }

        const categoriaAtualInfo = tabela.find((regra) => regra.categoria === categoriaAtual) || null;
        const fatorAtual = this.getFatorPrecoCategoria(categoriaAtualInfo);

        if (!categoriaAtualInfo || !fatorAtual) {
            return {
                available: false,
                perfil,
                categoriaAtual,
                precoAtual: precoRef.unitPrice,
                fontePreco: precoRef.source,
                dataPreco: precoRef.dataPedido || null,
                motivo: 'CATEGORIA_NAO_SUPORTADA',
            };
        }

        const precoBaseTabela = precoRef.unitPrice / fatorAtual;
        const ordemAtual = Number(categoriaAtualInfo.ordem || 0);

        const categorias = tabela
            .map((regra) => {
                const fator = this.getFatorPrecoCategoria(regra);
                const precoSimulado = fator ? precoBaseTabela * fator : null;
                const totalDesconto = fator ? (1 - fator) * 100 : 0;

                let posicao = 'atual';
                if (regra.ordem > ordemAtual) posicao = 'acima';
                if (regra.ordem < ordemAtual) posicao = 'abaixo';

                return {
                    ...regra,
                    posicao,
                    fator,
                    precoSimulado,
                    totalDesconto,
                    diferencaValor: precoSimulado != null ? (precoSimulado - precoRef.unitPrice) : null,
                    economiaValor: precoSimulado != null ? (precoRef.unitPrice - precoSimulado) : null,
                };
            })
            .sort((a, b) => b.ordem - a.ordem);

        return {
            available: true,
            perfil,
            categoriaAtual,
            precoAtual: precoRef.unitPrice,
            fontePreco: precoRef.source,
            dataPreco: precoRef.dataPedido || null,
            precoBaseTabela,
            categorias,
        };
    }

    renderComparativoCategoriaTooltip(comparativo, escapeHtml) {
        if (!comparativo) return '';

        const perfilLabel = comparativo?.perfil || 'Perfil';
        const fonteLabel = comparativo?.fontePreco === 'ULTIMA_COMPRA'
            ? `Baseado na última compra${comparativo?.dataPreco ? ` em ${escapeHtml(this.formatDateBR(comparativo.dataPreco))}` : ''}`
            : 'Baseado na média do período selecionado';

        const blocoAtual = `
            <div class="pchart-tooltip-current">
                <div class="pchart-tooltip-current-top">
                    <span>Paga hoje</span>
                    <strong>${this.formatCurrency(Number(comparativo.precoAtual || 0))}</strong>
                </div>
                <div class="pchart-tooltip-current-sub">
                    Categoria atual: ${escapeHtml(comparativo.categoriaAtual || 'N/D')} • ${fonteLabel}
                </div>
            </div>
        `;

        if (!comparativo.available) {
            const aviso = 'Não foi possível identificar a categoria atual do cliente para simular os níveis acima e abaixo.';

            return `
                <div class="pchart-tooltip-pricing">
                    <div class="pchart-tooltip-pricing-head">
                        <span>Comparativo por categoria</span>
                        <span>${escapeHtml(perfilLabel)}</span>
                    </div>
                    ${blocoAtual}
                    <div class="pchart-tooltip-note is-warning">${aviso}</div>
                </div>
            `;
        }

        const linhas = (comparativo.categorias || []).map((regra) => {
            const badge = regra.posicao === 'atual'
                ? 'Atual'
                : (regra.posicao === 'acima' ? 'Acima' : 'Abaixo');
            const diffText = regra.posicao === 'atual'
                ? 'Categoria atual do cliente'
                : (Number(regra.economiaValor || 0) > 0
                    ? `Economia ${this.formatCurrency(Number(regra.economiaValor || 0))}`
                    : `+${this.formatCurrency(Math.abs(Number(regra.diferencaValor || 0)))} vs atual`);

            return `
                <div class="pchart-price-row is-${regra.posicao}">
                    <div class="pchart-price-row-main">
                        <div class="pchart-price-row-title">
                            <span class="pchart-price-row-cat">${escapeHtml(regra.categoria)}</span>
                            <span class="pchart-price-row-badge">${badge}</span>
                        </div>
                        <strong>${this.formatCurrency(Number(regra.precoSimulado || 0))}</strong>
                    </div>
                    <div class="pchart-price-row-meta">
                        <span>Tabela -${(Number(regra.descontoTabela || 0) * 100).toFixed(1)}%</span>
                        <span>CX -${(Number(regra.descontoEmbalagem || 0) * 100).toFixed(1)}%</span>
                        <span>PIX -${(Number(regra.descontoPix || 0) * 100).toFixed(1)}%</span>
                        <span>Total -${Number(regra.totalDesconto || 0).toFixed(1)}%</span>
                    </div>
                    <div class="pchart-price-row-diff">${diffText}</div>
                </div>
            `;
        }).join('');

        return `
            <div class="pchart-tooltip-pricing">
                <div class="pchart-tooltip-pricing-head">
                    <span>Comparativo por categoria</span>
                    <span>${escapeHtml(perfilLabel)}</span>
                </div>
                ${blocoAtual}
                <div class="pchart-price-rows">${linhas}</div>
                <div class="pchart-tooltip-note">
                    Simulação estimada por categoria com tabela + embalagem + PIX.
                </div>
            </div>
        `;
    }

    renderTopProductsChart() {
        const canvas = document.getElementById('topProductsChart');
        const emptyEl = document.getElementById('topProductsEmpty');
        if (!canvas) return;

        const topProdutos = this.produtosInsights?.topProdutos || [];
        this.productsTooltipData = topProdutos;

        if (!topProdutos.length) {
            const tooltipEl = document.getElementById('products-chart-tooltip');
            if (tooltipEl) tooltipEl.style.opacity = 0;

            if (this.productsChart) {
                this.productsChart.data.labels = [];
                this.productsChart.data.datasets[0].data = [];
                this.productsChart.update();
            }
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }

        if (emptyEl) emptyEl.classList.add('hidden');

        const isDark = this.theme !== 'light';
        const labels = topProdutos.map((p) => {
            const nome = p.produto || `PROD ${p.codprod}`;
            return nome.length > 38 ? `${nome.slice(0, 38)}...` : nome;
        });

        const values = topProdutos.map((p) => Number(p.qtdTotal) || 0);
        const productsAnimation = {
            duration: 600,
            easing: 'easeOutCubic'
        };
        const escapeHtml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const getOrCreateProductsTooltip = () => {
            let tooltipEl = document.getElementById('products-chart-tooltip');
            if (!tooltipEl) {
                tooltipEl = document.createElement('div');
                tooltipEl.id = 'products-chart-tooltip';
                document.body.appendChild(tooltipEl);
            }
            return tooltipEl;
        };

        const externalProductsTooltipHandler = (context) => {
            const { chart, tooltip } = context;
            const tooltipEl = getOrCreateProductsTooltip();

            if (tooltip.opacity === 0) {
                tooltipEl.style.opacity = 0;
                return;
            }

            const point = tooltip.dataPoints?.[0];
            if (!point) return;

            const item = this.productsTooltipData[point.dataIndex];
            if (!item) return;

            const qtd = Number(item.qtdTotal || 0);
            const valor = Number(item.valorTotal || 0);
            const pedidos = Number(item.pedidos || 0);
            const participacao = Number(item.participacaoQtd || 0);
            const ticketMedio = pedidos > 0 ? (valor / pedidos) : 0;
            const produtoNome = item.produto || `PROD ${item.codprod || '-'}`;
            const produtoCod = item.codprod || '-';
            const comparativoCategoria = this.montarComparativoCategoriaProduto(item);

            tooltipEl.innerHTML = `
                <div class="pchart-tooltip-head">
                    <div class="pchart-tooltip-title" title="${escapeHtml(produtoNome)}">${escapeHtml(produtoNome)}</div>
                    <div class="pchart-tooltip-sub">Cod. ${escapeHtml(produtoCod)}</div>
                </div>
                <div class="pchart-tooltip-grid">
                    <div class="pchart-tooltip-item">
                        <span>Qtd.</span>
                        <strong>${qtd.toLocaleString('pt-BR')}</strong>
                    </div>
                    <div class="pchart-tooltip-item">
                        <span>Pedidos</span>
                        <strong>${pedidos.toLocaleString('pt-BR')}</strong>
                    </div>
                    <div class="pchart-tooltip-item pchart-tooltip-item--accent">
                        <span>Valor</span>
                        <strong>${this.formatCurrency(valor)}</strong>
                    </div>
                    <div class="pchart-tooltip-item">
                        <span>Part.</span>
                        <strong>${participacao.toFixed(2)}%</strong>
                    </div>
                    <div class="pchart-tooltip-item pchart-tooltip-item--full">
                        <span>Ticket Médio</span>
                        <strong>${this.formatCurrency(ticketMedio)}</strong>
                    </div>
                </div>
                ${this.renderComparativoCategoriaTooltip(comparativoCategoria, escapeHtml)}
            `;

            const position = chart.canvas.getBoundingClientRect();
            const viewportPadding = 12;
            const tooltipGap = 16;
            const anchorX = position.left + tooltip.caretX;
            const anchorY = position.top + tooltip.caretY;

            tooltipEl.style.opacity = 0;
            tooltipEl.style.position = 'fixed';
            tooltipEl.style.left = '0px';
            tooltipEl.style.top = '0px';
            tooltipEl.style.transform = 'none';
            tooltipEl.style.pointerEvents = 'none';

            const tooltipRect = tooltipEl.getBoundingClientRect();
            let left = anchorX + tooltipGap;
            let top = anchorY - (tooltipRect.height / 2);

            if (left + tooltipRect.width > window.innerWidth - viewportPadding) {
                left = anchorX - tooltipRect.width - tooltipGap;
            }

            if (left < viewportPadding) {
                left = Math.min(
                    Math.max(viewportPadding, anchorX - (tooltipRect.width / 2)),
                    window.innerWidth - tooltipRect.width - viewportPadding
                );
            }

            if (top < viewportPadding) {
                top = viewportPadding;
            }

            if (top + tooltipRect.height > window.innerHeight - viewportPadding) {
                top = window.innerHeight - tooltipRect.height - viewportPadding;
            }

            if (top < viewportPadding) {
                top = viewportPadding;
            }

            tooltipEl.style.opacity = 1;
            tooltipEl.style.left = `${left}px`;
            tooltipEl.style.top = `${top}px`;
        };

        if (this.productsChart) {
            this.productsChart.data.labels = labels;
            this.productsChart.data.datasets[0].data = values;
            this.productsChart.data.datasets[0].backgroundColor = isDark ? 'rgba(14, 165, 233, 0.75)' : 'rgba(2, 132, 199, 0.82)';
            this.productsChart.data.datasets[0].hoverBackgroundColor = isDark ? 'rgba(56, 189, 248, 0.9)' : 'rgba(3, 105, 161, 0.92)';

            this.productsChart.options.animation = productsAnimation;
            this.productsChart.options.plugins.tooltip.external = externalProductsTooltipHandler;
            this.productsChart.options.scales.x.grid.color = isDark ? 'rgba(148, 163, 184, 0.2)' : 'rgba(148, 163, 184, 0.18)';
            this.productsChart.options.scales.x.ticks.color = isDark ? '#cbd5e1' : '#334155';
            this.productsChart.options.scales.y.ticks.color = isDark ? '#e2e8f0' : '#1e293b';
            this.productsChart.update();
            return;
        }

        this.productsChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Quantidade Comprada',
                    data: values,
                    borderRadius: 8,
                    borderSkipped: false,
                    backgroundColor: isDark ? 'rgba(14, 165, 233, 0.75)' : 'rgba(2, 132, 199, 0.82)',
                    hoverBackgroundColor: isDark ? 'rgba(56, 189, 248, 0.9)' : 'rgba(3, 105, 161, 0.92)'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                animation: productsAnimation,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false,
                        external: externalProductsTooltipHandler
                    }
                },
                scales: {
                    x: {
                        grid: { color: isDark ? 'rgba(148, 163, 184, 0.2)' : 'rgba(148, 163, 184, 0.18)' },
                        ticks: { color: isDark ? '#cbd5e1' : '#334155' }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: isDark ? '#e2e8f0' : '#1e293b' }
                    }
                }
            }
        });
    }

    initOrderModal() {
        const root = document.getElementById('orderDetailModal');
        if (!root) return;

        this.orderModalEls = {
            root,
            close: document.getElementById('orderModalClose'),
            title: document.getElementById('orderModalTitle'),
            subtitle: document.getElementById('orderModalSubtitle'),
            valor: document.getElementById('orderModalValor'),
            qtdItens: document.getElementById('orderModalQtdItens'),
            qtdProdutos: document.getElementById('orderModalQtdProdutos'),
            itensListados: document.getElementById('orderModalItensListados'),
            pricingSummary: document.getElementById('orderModalPricingSummary'),
            itemsBody: document.getElementById('orderModalItemsBody'),
        };

        this.orderModalEls.close?.addEventListener('click', () => this.closeOrderModal());
        root.addEventListener('click', (event) => {
            if (event.target === root) this.closeOrderModal();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (!this.orderModalEls?.root || this.orderModalEls.root.classList.contains('hidden')) return;
            this.closeOrderModal();
        });

        const tableBody = document.getElementById('ordersTableBody');
        tableBody?.addEventListener('click', (event) => {
            const row = event.target.closest('tr[data-order-index]');
            if (!row) return;
            const orderIndex = Number(row.getAttribute('data-order-index'));
            this.openOrderModalByIndex(orderIndex);
        });

        tableBody?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const row = event.target.closest('tr[data-order-index]');
            if (!row) return;
            event.preventDefault();
            const orderIndex = Number(row.getAttribute('data-order-index'));
            this.openOrderModalByIndex(orderIndex);
        });
    }

    renderOrdersTable() {
        const tableBody = document.getElementById('ordersTableBody');
        const emptyEl = document.getElementById('ordersTableEmpty');
        const summaryEl = document.getElementById('ordersTimelineSummary');
        const tableContainer = tableBody?.closest('.orders-table-container');
        if (!tableBody) return;

        const pedidos = Array.isArray(this.pedidosInsights?.pedidos) ? [...this.pedidosInsights.pedidos] : [];
        const resumo = this.pedidosInsights?.resumo || {};

        const toDateMs = (value) => {
            const dt = value ? new Date(value) : null;
            return dt && !Number.isNaN(dt.getTime()) ? dt.getTime() : 0;
        };

        pedidos.sort((a, b) => {
            const dtDiff = toDateMs(b?.dataPedido) - toDateMs(a?.dataPedido);
            if (dtDiff !== 0) return dtDiff;
            return Number(b?.numped || 0) - Number(a?.numped || 0);
        });

        this.ordersTableData = pedidos;

        const totalPedidos = Number(resumo.totalPedidos || pedidos.length || 0);
        const valorTotalResumo = Number(resumo.valorTotal || 0);
        const valorTotalBase = valorTotalResumo > 0
            ? valorTotalResumo
            : pedidos.reduce((acc, pedido) => acc + (Number(pedido?.valorTotal || 0)), 0);
        const ticketMedioResumo = Number(resumo.ticketMedio || (totalPedidos > 0 ? (valorTotalBase / totalPedidos) : 0));

        if (summaryEl) {
            if (!totalPedidos) {
                summaryEl.textContent = 'Sem dados de pedidos';
            } else {
                summaryEl.textContent = `${totalPedidos} pedido(s) | Ticket médio ${this.formatCurrency(ticketMedioResumo)} | Total ${this.formatCurrency(valorTotalBase)}`;
            }
        }

        if (!pedidos.length) {
            tableBody.innerHTML = '';
            tableContainer?.classList.add('hidden');
            emptyEl?.classList.remove('hidden');
            this.closeOrderModal();
            return;
        }

        emptyEl?.classList.add('hidden');
        tableContainer?.classList.remove('hidden');

        tableBody.innerHTML = pedidos.map((pedido, index) => {
            const dt = pedido?.dataPedido ? new Date(pedido.dataPedido) : null;
            const dataPedido = dt && !Number.isNaN(dt.getTime())
                ? dt.toLocaleDateString('pt-BR')
                : '-';
            const numped = Number(pedido?.numped || 0);
            const valor = Number(pedido?.valorTotal || 0);
            const qtdItens = Number(pedido?.qtdItens || 0);
            const qtdProdutos = Number(pedido?.qtdProdutos || 0);

            return `
                <tr class="orders-table-row" data-order-index="${index}" tabindex="0" role="button" aria-label="Abrir detalhes do pedido ${numped}">
                    <td>#${numped.toLocaleString('pt-BR')}</td>
                    <td>${this.escapeHtml(dataPedido)}</td>
                    <td>${this.formatCurrency(valor)}</td>
                    <td>${this.formatQuantity(qtdItens)}</td>
                    <td>${qtdProdutos.toLocaleString('pt-BR')}</td>
                </tr>
            `;
        }).join('');
    }

    openOrderModalByIndex(index) {
        const pedido = this.ordersTableData?.[index];
        if (!pedido) return;
        this.openOrderModal(pedido);
    }

    montarComparativoCategoriaPorValor(valorAtual, quantidade = 1) {
        const perfil = this.getPerfilPrecificacaoAtual();
        const categoriaAtual = this.getCategoriaWinthorAtual();
        const tabela = this.getTabelaPrecificacaoCategoria(perfil);
        const valorPago = Number(valorAtual || 0);
        const quantidadeNormalizada = Number(quantidade || 0) > 0 ? Number(quantidade || 0) : 1;

        if (!(valorPago > 0) || !tabela?.length) {
            return {
                available: false,
                perfil,
                categoriaAtual,
                valorAtual: valorPago,
                valorUnitarioAtual: valorPago > 0 ? (valorPago / quantidadeNormalizada) : 0,
                quantidade: quantidadeNormalizada,
            };
        }

        const categoriaAtualInfo = tabela.find((regra) => regra.categoria === categoriaAtual) || null;
        const fatorAtual = this.getFatorPrecoCategoria(categoriaAtualInfo);

        if (!categoriaAtualInfo || !fatorAtual) {
            return {
                available: false,
                perfil,
                categoriaAtual,
                valorAtual: valorPago,
                valorUnitarioAtual: valorPago / quantidadeNormalizada,
                quantidade: quantidadeNormalizada,
            };
        }

        const valorBaseTabela = valorPago / fatorAtual;
        const ordemAtual = Number(categoriaAtualInfo.ordem || 0);
        const roundMoney = (value) => Number((Number(value || 0)).toFixed(2));

        const categorias = tabela
            .map((regra) => {
                const fator = this.getFatorPrecoCategoria(regra);
                const valorSimulado = fator ? roundMoney(valorBaseTabela * fator) : null;
                const valorUnitario = valorSimulado != null ? roundMoney(valorSimulado / quantidadeNormalizada) : null;
                const totalDesconto = fator ? Number((((1 - fator) * 100)).toFixed(1)) : 0;

                let posicao = 'atual';
                if (regra.ordem > ordemAtual) posicao = 'acima';
                if (regra.ordem < ordemAtual) posicao = 'abaixo';

                return {
                    ...regra,
                    posicao,
                    fator,
                    valorSimulado,
                    valorUnitario,
                    totalDesconto,
                    diferencaValor: valorSimulado != null ? roundMoney(valorSimulado - valorPago) : null,
                    economiaValor: valorSimulado != null ? roundMoney(valorPago - valorSimulado) : null,
                };
            })
            .sort((a, b) => b.ordem - a.ordem);

        return {
            available: true,
            perfil,
            categoriaAtual,
            valorAtual: roundMoney(valorPago),
            valorUnitarioAtual: roundMoney(valorPago / quantidadeNormalizada),
            quantidade: quantidadeNormalizada,
            valorBaseTabela: roundMoney(valorBaseTabela),
            categorias,
        };
    }

    renderOrderPricingSummary(comparativo) {
        if (!comparativo?.available) {
            return `
                <div class="order-modal-pricing-empty">
                    Não foi possível montar o comparativo deste pedido com base na categoria atual do cliente.
                </div>
            `;
        }

        return (comparativo.categorias || []).map((regra) => {
            const badge = regra.posicao === 'atual'
                ? 'Atual'
                : (regra.posicao === 'acima' ? 'Acima' : 'Abaixo');
            const diffText = regra.posicao === 'atual'
                ? 'Valor pago hoje'
                : (Number(regra.economiaValor || 0) > 0
                    ? `Economia ${this.formatCurrency(Number(regra.economiaValor || 0))}`
                    : `+${this.formatCurrency(Math.abs(Number(regra.diferencaValor || 0)))} vs atual`);

            return `
                <div class="order-pricing-card is-${regra.posicao}">
                    <div class="order-pricing-card-head">
                        <span class="order-pricing-card-title">${this.escapeHtml(regra.categoria)}</span>
                        <span class="order-pricing-card-badge">${badge}</span>
                    </div>
                    <strong>${this.formatCurrency(Number(regra.valorSimulado || 0))}</strong>
                    <div class="order-pricing-card-meta">
                        Tabela -${(Number(regra.descontoTabela || 0) * 100).toFixed(1)}% •
                        CX -${(Number(regra.descontoEmbalagem || 0) * 100).toFixed(1)}% •
                        PIX -${(Number(regra.descontoPix || 0) * 100).toFixed(1)}%
                    </div>
                    <div class="order-pricing-card-diff">${diffText}</div>
                </div>
            `;
        }).join('');
    }

    renderOrderItemComparisonRow(item, comparativo) {
        const categoriasFixas = ['BRONZE', 'PRATA', 'OURO', 'PLATINUM', 'DIAMANTE'];
        const regrasPorCategoria = new Map((comparativo?.categorias || []).map((regra) => [regra.categoria, regra]));
        const qtd = Number(item?.qtd || 0);
        const valorAtual = Number(item?.valorTotal || 0);
        const valorUnitarioAtual = qtd > 0 ? (valorAtual / qtd) : valorAtual;
        const categoriaAtual = comparativo?.categoriaAtual || 'N/D';

        const celulaPagoAtual = `
            <td class="order-price-cell is-paid">
                <div class="order-price-cell-total">${this.formatCurrency(valorAtual)}</div>
                <div class="order-price-cell-unit">Un. ${this.formatCurrency(valorUnitarioAtual)}</div>
                <div class="order-price-cell-diff">Atual: ${this.escapeHtml(categoriaAtual)}</div>
            </td>
        `;

        const celulasCategorias = categoriasFixas.map((categoria) => {
            const regra = regrasPorCategoria.get(categoria);
            if (!regra) {
                return `
                    <td class="order-price-cell">
                        <div class="order-price-cell-total">-</div>
                    </td>
                `;
            }

            const diffText = regra.posicao === 'atual'
                ? 'Categoria atual'
                : (Number(regra.economiaValor || 0) > 0
                    ? `Economiza ${this.formatCurrency(Number(regra.economiaValor || 0))}`
                    : `+${this.formatCurrency(Math.abs(Number(regra.diferencaValor || 0)))} vs atual`);

            return `
                <td class="order-price-cell is-${regra.posicao}">
                    <div class="order-price-cell-total">${this.formatCurrency(Number(regra.valorSimulado || 0))}</div>
                    <div class="order-price-cell-unit">Un. ${this.formatCurrency(Number(regra.valorUnitario || 0))}</div>
                    <div class="order-price-cell-diff">${diffText}</div>
                </td>
            `;
        }).join('');

        return `
            <tr>
                <td>${Number(item?.codprod || 0).toLocaleString('pt-BR')}</td>
                <td class="order-modal-product-cell" title="${this.escapeHtml(item?.produto || '')}">
                    ${this.escapeHtml(item?.produto || '-')}
                </td>
                <td>${this.formatQuantity(qtd)}</td>
                ${celulaPagoAtual}
                ${celulasCategorias}
            </tr>
        `;
    }

    openOrderModal(pedido) {
        if (!this.orderModalEls?.root) return;

        const itens = Array.isArray(pedido?.itens) ? pedido.itens : [];
        const dt = pedido?.dataPedido ? new Date(pedido.dataPedido) : null;
        const dataPedido = dt && !Number.isNaN(dt.getTime())
            ? dt.toLocaleDateString('pt-BR')
            : '-';
        const numped = Number(pedido?.numped || 0);

        if (this.orderModalEls.title) {
            this.orderModalEls.title.textContent = `Pedido #${numped.toLocaleString('pt-BR')}`;
        }
        if (this.orderModalEls.subtitle) {
            this.orderModalEls.subtitle.textContent = `Data ${dataPedido}`;
        }
        if (this.orderModalEls.valor) {
            this.orderModalEls.valor.textContent = this.formatCurrency(Number(pedido?.valorTotal || 0));
        }
        if (this.orderModalEls.qtdItens) {
            this.orderModalEls.qtdItens.textContent = this.formatQuantity(Number(pedido?.qtdItens || 0));
        }
        if (this.orderModalEls.qtdProdutos) {
            this.orderModalEls.qtdProdutos.textContent = Number(pedido?.qtdProdutos || 0).toLocaleString('pt-BR');
        }
        if (this.orderModalEls.itensListados) {
            this.orderModalEls.itensListados.textContent = itens.length.toLocaleString('pt-BR');
        }
        if (this.orderModalEls.pricingSummary) {
            const qtdBasePedido = Number(pedido?.qtdItens || 0) || itens.reduce((acc, item) => acc + (Number(item?.qtd || 0)), 0) || 1;
            const comparativoPedido = this.montarComparativoCategoriaPorValor(Number(pedido?.valorTotal || 0), qtdBasePedido);
            this.orderModalEls.pricingSummary.innerHTML = this.renderOrderPricingSummary(comparativoPedido);
        }

        if (this.orderModalEls.itemsBody) {
            if (!itens.length) {
                this.orderModalEls.itemsBody.innerHTML = `
                    <tr>
                        <td colspan="9" class="order-modal-empty-row">Sem itens detalhados para este pedido.</td>
                    </tr>
                `;
            } else {
                this.orderModalEls.itemsBody.innerHTML = itens.map((item) => {
                    const comparativoItem = this.montarComparativoCategoriaPorValor(
                        Number(item?.valorTotal || 0),
                        Number(item?.qtd || 0) || 1
                    );
                    return this.renderOrderItemComparisonRow(item, comparativoItem);
                }).join('');
            }
        }

        this.orderModalEls.root.classList.remove('hidden');
        this.orderModalEls.root.setAttribute('aria-hidden', 'false');
        document.body.classList.add('order-modal-open');
    }

    closeOrderModal() {
        if (!this.orderModalEls?.root) return;
        this.orderModalEls.root.classList.add('hidden');
        this.orderModalEls.root.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('order-modal-open');
    }

    // Mantido por compatibilidade com versões anteriores.
    renderOrdersTimelineChart() {
        this.renderOrdersTable();
    }

    renderProductSuggestions() {
        const container = document.getElementById('productSuggestions');
        if (!container) return;

        const sugestoes = this.produtosInsights?.sugestoes || [];

        if (!sugestoes.length) {
            container.innerHTML = '<div class="products-suggestions-empty">Sem sugestões para o período selecionado.</div>';
            return;
        }

        container.innerHTML = sugestoes.map((s) => {
            const tipoClass = (s.tipo || 'oportunidade').toLowerCase();
            const tipoLabel = tipoClass === 'reativacao'
                ? 'Reativação'
                : tipoClass === 'recorrencia'
                    ? 'Recorrência'
                    : 'Oportunidade';

            return `
                <div class="product-suggestion-item">
                    <div class="product-suggestion-title">
                        <span>${s.titulo || s.produto || 'Produto'}</span>
                        <span class="product-suggestion-type ${tipoClass}">${tipoLabel}</span>
                    </div>
                    <div class="product-suggestion-desc">${s.descricao || ''}</div>
                </div>
            `;
        }).join('');
    }

    renderProductsSummary() {
        const summaryEl = document.getElementById('productsInsightsSummary');
        if (!summaryEl) return;

        const resumo = this.produtosInsights?.resumo || {};
        const totalProdutos = Number(resumo.totalProdutos || 0);
        const valorTotal = Number(resumo.valorTotal || 0);

        if (!totalProdutos) {
            summaryEl.textContent = 'Sem dados de produtos';
            return;
        }

        summaryEl.textContent = `${totalProdutos} produto(s) | ${this.formatCurrency(valorTotal)}`;
    }

    initAiChatWidget() {
        this.aiEls = {
            root: document.getElementById('aiClientChat'),
            teaser: document.getElementById('aiChatTeaser'),
            teaserText: document.getElementById('aiChatTeaserText'),
            teaserMinimize: document.getElementById('aiChatTeaserMinimize'),
            toggle: document.getElementById('aiChatToggle'),
            panel: document.getElementById('aiChatPanel'),
            close: document.getElementById('aiChatClose'),
            messages: document.getElementById('aiChatMessages'),
            form: document.getElementById('aiChatForm'),
            input: document.getElementById('aiChatInput'),
            send: document.getElementById('aiChatSend')
        };

        if (!this.aiEls.root || !this.aiEls.panel || !this.aiEls.messages || !this.aiEls.form || !this.aiEls.input || !this.aiEls.send) {
            return;
        }

        this.mountAiChatToViewport();
        this.initAiChatTeaser();

        this.aiEls.teaserMinimize?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.setAiChatTeaserMinimized(!this.aiChat.teaserMinimized);
        });
        this.aiEls.toggle?.addEventListener('click', () => this.toggleAiChat(!this.aiChat.isOpen));
        this.aiEls.close?.addEventListener('click', () => this.toggleAiChat(false));

        this.aiEls.form.addEventListener('submit', (event) => {
            event.preventDefault();
            this.handleAiSubmit();
        });

        this.aiEls.input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.handleAiSubmit();
            }
        });

        this.appendAiMessage('assistant', 'Olá! Posso ajudar com recomendações para a próxima venda, produtos com maior chance de conversão e ações para melhorar a nota do cliente.');
        this.appendAiMessage('system', 'Sugestão: pergunte "Quais 3 produtos devo oferecer agora?" ou "Como melhorar a nota desse cliente no próximo mês?".');
    }

    initAiChatTeaser() {
        if (!this.aiEls?.teaser || !this.aiEls?.teaserText || !Array.isArray(this.aiChat?.teaserPhrases) || !this.aiChat.teaserPhrases.length) {
            return;
        }

        this.aiChat.teaserIndex = 0;
        this.aiEls.teaserText.textContent = this.aiChat.teaserPhrases[0];
        this.loadAiChatTeaserPreference();
        this.updateAiChatTeaserVisibility();
        this.startAiChatTeaserRotation();
    }

    startAiChatTeaserRotation() {
        if (!this.aiEls?.teaser || !this.aiEls?.teaserText) return;

        if (this.aiChat.teaserTimer) {
            clearInterval(this.aiChat.teaserTimer);
        }

        this.aiChat.teaserTimer = window.setInterval(() => {
            if (this.aiChat.isOpen || this.aiChat.teaserMinimized) return;
            this.rotateAiChatTeaserPhrase();
        }, 5200);
    }

    loadAiChatTeaserPreference() {
        let minimized = false;

        try {
            minimized = localStorage.getItem(this.aiChat.teaserStorageKey) === 'true';
        } catch (error) {
            console.debug('Nao foi possivel ler a preferencia do teaser da IA:', error);
        }

        this.setAiChatTeaserMinimized(minimized, { persist: false });
    }

    setAiChatTeaserMinimized(minimized, { persist = true } = {}) {
        this.aiChat.teaserMinimized = Boolean(minimized);

        if (this.aiChat.teaserSwapTimer) {
            clearTimeout(this.aiChat.teaserSwapTimer);
            this.aiChat.teaserSwapTimer = null;
        }

        if (this.aiEls?.teaser) {
            this.aiEls.teaser.classList.remove('is-changing');
            this.aiEls.teaser.classList.toggle('is-minimized', this.aiChat.teaserMinimized);
        }

        if (this.aiEls?.teaserMinimize) {
            const label = this.aiChat.teaserMinimized ? 'Expandir mensagem da IA' : 'Minimizar mensagem da IA';
            this.aiEls.teaserMinimize.textContent = this.aiChat.teaserMinimized ? '+' : '-';
            this.aiEls.teaserMinimize.setAttribute('aria-label', label);
            this.aiEls.teaserMinimize.setAttribute('title', label);
            this.aiEls.teaserMinimize.setAttribute('aria-pressed', this.aiChat.teaserMinimized ? 'true' : 'false');
        }

        if (persist) {
            try {
                localStorage.setItem(this.aiChat.teaserStorageKey, this.aiChat.teaserMinimized ? 'true' : 'false');
            } catch (error) {
                console.debug('Nao foi possivel salvar a preferencia do teaser da IA:', error);
            }
        }
    }

    rotateAiChatTeaserPhrase() {
        const teaser = this.aiEls?.teaser;
        const teaserText = this.aiEls?.teaserText;
        const phrases = this.aiChat?.teaserPhrases;
        if (!teaser || !teaserText || !Array.isArray(phrases) || phrases.length < 2 || this.aiChat.teaserMinimized) return;

        teaser.classList.add('is-changing');
        if (this.aiChat.teaserSwapTimer) {
            clearTimeout(this.aiChat.teaserSwapTimer);
        }

        this.aiChat.teaserSwapTimer = window.setTimeout(() => {
            this.aiChat.teaserIndex = (this.aiChat.teaserIndex + 1) % phrases.length;
            teaserText.textContent = phrases[this.aiChat.teaserIndex];
            teaser.classList.remove('is-changing');
        }, 180);
    }

    updateAiChatTeaserVisibility() {
        if (!this.aiEls?.teaser) return;
        this.aiEls.teaser.classList.toggle('is-hidden', this.aiChat.isOpen);
        this.aiEls.teaser.style.setProperty('pointer-events', this.aiChat.isOpen ? 'none' : 'auto', 'important');
    }

    mountAiChatToViewport() {
        if (!this.aiEls?.root) return;

        let portal = document.getElementById('aiChatViewportPortal');
        if (!portal) {
            portal = document.createElement('div');
            portal.id = 'aiChatViewportPortal';
            document.body.appendChild(portal);
        }

        this.aiChat.portal = portal;
        if (this.aiEls.root.parentElement !== portal) {
            portal.appendChild(this.aiEls.root);
        }

        this.applyAiChatViewportLayout();

        if (!this.aiChat.layoutBound) {
            this.aiChat.handleViewportLayout = () => this.applyAiChatViewportLayout();
            window.addEventListener('resize', this.aiChat.handleViewportLayout, { passive: true });
            window.addEventListener('orientationchange', this.aiChat.handleViewportLayout, { passive: true });
            this.aiChat.layoutBound = true;
        }
    }

    applyAiChatViewportLayout() {
        const portal = this.aiChat?.portal;
        const root = this.aiEls?.root;
        if (!portal || !root) return;

        const mobile = window.matchMedia('(max-width: 768px)').matches;
        const pad = mobile ? 14 : 24;
        const toggleSize = mobile ? 48 : 52;
        const panelGap = 12;

        portal.style.setProperty('position', 'fixed', 'important');
        portal.style.setProperty('inset', '0', 'important');
        portal.style.setProperty('top', '0', 'important');
        portal.style.setProperty('right', '0', 'important');
        portal.style.setProperty('bottom', '0', 'important');
        portal.style.setProperty('left', '0', 'important');
        portal.style.setProperty('display', 'flex', 'important');
        portal.style.setProperty('justify-content', 'flex-end', 'important');
        portal.style.setProperty('align-items', 'flex-end', 'important');
        portal.style.setProperty('padding', `${pad}px`, 'important');
        portal.style.setProperty('pointer-events', 'none', 'important');
        portal.style.setProperty('z-index', '2147483646', 'important');

        root.style.setProperty('position', 'static', 'important');
        root.style.setProperty('inset', 'auto', 'important');
        root.style.setProperty('top', 'auto', 'important');
        root.style.setProperty('right', 'auto', 'important');
        root.style.setProperty('bottom', 'auto', 'important');
        root.style.setProperty('left', 'auto', 'important');
        root.style.setProperty('margin', '0', 'important');
        root.style.setProperty('display', 'block', 'important');
        root.style.setProperty('width', '0', 'important');
        root.style.setProperty('height', '0', 'important');
        root.style.setProperty('overflow', 'visible', 'important');
        root.style.setProperty('pointer-events', 'none', 'important');
        root.style.setProperty('max-width', 'none', 'important');

        if (this.aiEls.toggle) {
            this.aiEls.toggle.style.setProperty('position', 'fixed', 'important');
            this.aiEls.toggle.style.setProperty('right', `${pad}px`, 'important');
            this.aiEls.toggle.style.setProperty('bottom', `${pad}px`, 'important');
            this.aiEls.toggle.style.setProperty('left', 'auto', 'important');
            this.aiEls.toggle.style.setProperty('top', 'auto', 'important');
            this.aiEls.toggle.style.setProperty('z-index', '2147483647', 'important');
            this.aiEls.toggle.style.setProperty('pointer-events', 'auto', 'important');
        }

        if (this.aiEls.panel) {
            this.aiEls.panel.style.setProperty('position', 'fixed', 'important');
            this.aiEls.panel.style.setProperty('right', `${pad}px`, 'important');
            this.aiEls.panel.style.setProperty('bottom', `${pad + toggleSize + panelGap}px`, 'important');
            this.aiEls.panel.style.setProperty('left', 'auto', 'important');
            this.aiEls.panel.style.setProperty('top', 'auto', 'important');
            this.aiEls.panel.style.setProperty('z-index', '2147483647', 'important');
            this.aiEls.panel.style.setProperty('max-width', `calc(100vw - ${pad * 2}px)`, 'important');
            this.aiEls.panel.style.setProperty('pointer-events', this.aiChat.isOpen ? 'auto' : 'none', 'important');
        }

        if (this.aiEls.teaser) {
            this.aiEls.teaser.style.setProperty('position', 'fixed', 'important');
            this.aiEls.teaser.style.setProperty('z-index', '2147483647', 'important');
            this.aiEls.teaser.style.setProperty('pointer-events', this.aiChat.isOpen ? 'none' : 'auto', 'important');
            if (mobile) {
                this.aiEls.teaser.style.setProperty('right', `${pad}px`, 'important');
                this.aiEls.teaser.style.setProperty('bottom', `${pad + toggleSize + panelGap}px`, 'important');
                this.aiEls.teaser.style.setProperty('left', 'auto', 'important');
                this.aiEls.teaser.style.setProperty('top', 'auto', 'important');
            } else {
                this.aiEls.teaser.style.setProperty('right', `${pad + toggleSize + 16}px`, 'important');
                this.aiEls.teaser.style.setProperty('bottom', `${pad + 2}px`, 'important');
                this.aiEls.teaser.style.setProperty('left', 'auto', 'important');
                this.aiEls.teaser.style.setProperty('top', 'auto', 'important');
            }
        }
    }

    toggleAiChat(open) {
        if (!this.aiEls?.panel) return;

        this.aiChat.isOpen = Boolean(open);
        this.aiEls.panel.classList.toggle('is-open', this.aiChat.isOpen);
        this.aiEls.panel.setAttribute('aria-hidden', this.aiChat.isOpen ? 'false' : 'true');
        this.aiEls.panel.style.setProperty('pointer-events', this.aiChat.isOpen ? 'auto' : 'none', 'important');
        this.updateAiChatTeaserVisibility();

        if (this.aiChat.isOpen) {
            setTimeout(() => {
                this.aiEls.input?.focus();
                this.scrollAiToBottom();
            }, 50);
        }
    }

    setAiSendingState(isSending) {
        this.aiChat.isSending = isSending;
        if (!this.aiEls) return;
        this.aiEls.send.disabled = isSending;
        this.aiEls.input.disabled = isSending;
    }

    scrollAiToBottom() {
        if (!this.aiEls?.messages) return;
        const el = this.aiEls.messages;
        const applyScroll = () => {
            el.scrollTop = el.scrollHeight + 9999;
        };

        applyScroll();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(applyScroll);
        }
        setTimeout(applyScroll, 30);
        setTimeout(applyScroll, 120);
    }

    appendAiMessage(role, content) {
        if (!this.aiEls?.messages || !content) return;

        const row = document.createElement('div');
        row.className = `ai-msg ai-msg-${role}`;

        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        const raw = String(content);

        const roleEl = document.createElement('div');
        roleEl.className = 'ai-msg-role';
        roleEl.textContent = role === 'assistant' ? 'Assistente' : role === 'user' ? 'Você' : 'Sistema';

        const contentEl = document.createElement('div');
        contentEl.className = 'ai-msg-content';

        if (role === 'assistant') {
            bubble.classList.add('ai-msg-bubble--rich');
            contentEl.innerHTML = this.renderAiMarkdown(raw);
            this.enhanceAiRenderedContent(contentEl);
        } else if (role === 'system') {
            bubble.classList.add('ai-msg-bubble--system');
            contentEl.textContent = raw;
        } else {
            contentEl.textContent = raw;
        }

        bubble.appendChild(roleEl);
        bubble.appendChild(contentEl);

        row.appendChild(bubble);

        this.aiEls.messages.appendChild(row);
        this.scrollAiToBottom();
    }

    setAiTyping(show) {
        if (!this.aiEls?.messages) return;
        let typingEl = document.getElementById('aiChatTyping');

        if (show) {
            if (typingEl) return;
            typingEl = document.createElement('div');
            typingEl.id = 'aiChatTyping';
            typingEl.className = 'ai-msg ai-msg-assistant ai-msg-typing';
            typingEl.innerHTML = `
                <div class="ai-msg-bubble">
                    <div class="ai-msg-role">Assistente</div>
                    <div class="ai-msg-content ai-msg-content-typing">
                    <span class="ai-dot"></span>
                    <span class="ai-dot"></span>
                    <span class="ai-dot"></span>
                    </div>
                </div>
            `;
            this.aiEls.messages.appendChild(typingEl);
            this.scrollAiToBottom();
            return;
        }

        if (typingEl) typingEl.remove();
    }

    stripHtml(html) {
        return String(html || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    configureAiMarkdown() {
        if (this.aiMarkdownConfigured || !window.marked) return;

        const renderer = new window.marked.Renderer();
        renderer.paragraph = (text) => `<p class="markdown-paragraph">${text}</p>`;
        renderer.blockquote = (quote) => `<blockquote class="markdown-blockquote">${quote}</blockquote>`;
        renderer.list = (body, ordered, start) => {
            const tag = ordered ? 'ol' : 'ul';
            const startAttr = ordered && Number(start) > 1 ? ` start="${Number(start)}"` : '';
            return `<${tag}${startAttr} class="markdown-list">${body}</${tag}>`;
        };
        renderer.listitem = (text) => `<li class="markdown-list-item">${text}</li>`;
        renderer.table = (header, body) => `
            <div class="table-wrapper">
                <table class="markdown-table">
                    <thead>${header}</thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
        `;
        renderer.codespan = (code) => `<code class="markdown-inline-code">${this.escapeHtml(code)}</code>`;
        renderer.code = (code, language) => {
            const lang = String(language || '').trim().toLowerCase();
            const validLang = lang && /^[a-z0-9_+.-]+$/i.test(lang);
            const classAttr = validLang ? ` class="language-${lang}"` : '';
            return `
                <div class="code-wrapper">
                    <pre class="markdown-code"><code${classAttr}>${this.escapeHtml(code)}</code></pre>
                </div>
            `;
        };
        renderer.link = (href, title, text) => {
            const safeHref = String(href || '#');
            const safeTitle = title ? ` title="${this.escapeHtml(title)}"` : '';
            return `<a href="${this.escapeHtml(safeHref)}" class="markdown-link" target="_blank" rel="noopener noreferrer"${safeTitle}>${text}</a>`;
        };

        window.marked.setOptions({
            gfm: true,
            breaks: true,
            mangle: false,
            headerIds: false,
            smartypants: true,
            renderer,
        });

        this.aiMarkdownConfigured = true;
    }

    renderAiMarkdown(content) {
        const source = String(content || '').trim();
        if (!source) return '';

        if (!window.marked) {
            return `<p class="markdown-paragraph">${this.escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
        }

        this.configureAiMarkdown();

        let html = '';
        try {
            html = typeof window.marked.parse === 'function'
                ? window.marked.parse(source)
                : window.marked(source);
        } catch (error) {
            console.warn('[IA Cliente] Falha ao renderizar markdown:', error);
            html = `<p class="markdown-paragraph">${this.escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
        }

        if (window.DOMPurify?.sanitize) {
            html = window.DOMPurify.sanitize(html);
        }

        return html;
    }

    enhanceAiRenderedContent(rootEl) {
        if (!rootEl) return;

        rootEl.querySelectorAll('table').forEach((table) => {
            if (table.classList.contains('markdown-table')) return;
            table.classList.add('markdown-table');
            if (!table.parentElement?.classList.contains('table-wrapper')) {
                const wrapper = document.createElement('div');
                wrapper.className = 'table-wrapper';
                table.parentNode.insertBefore(wrapper, table);
                wrapper.appendChild(table);
            }
        });

        rootEl.querySelectorAll('a[href]').forEach((link) => {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        });
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    sanitizeRcaNome(value) {
        let nome = String(value || '').replace(/\s+/g, ' ').trim();
        if (!nome || nome === '-') return null;

        // Remove telefones no fim (ex.: "GLAYCE 62 3928 4020", "(62) 99222-1111")
        nome = nome
            .replace(/\(?\d{2}\)?\s*\d{4,5}[-\s]?\d{4}\s*$/g, '')
            .replace(/\b\d{2}\s+\d{4,5}\s+\d{4}\s*$/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!nome || /^\d+$/.test(nome)) return null;
        return nome;
    }

    formatAiInline(text) {
        let out = this.escapeHtml(text || '');
        out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
        out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
        out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        return out;
    }

    isAiTableSeparator(line) {
        const raw = String(line || '').trim();
        if (!/^\|.*\|$/.test(raw)) return false;
        const cells = raw
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
        return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
    }

    renderAiTable(lines, startIndex) {
        let i = startIndex;
        const tableRows = [];
        while (i < lines.length) {
            const raw = String(lines[i] || '').trim();
            if (!/^\|.*\|$/.test(raw)) break;
            tableRows.push(raw);
            i++;
        }

        if (tableRows.length < 2 || !this.isAiTableSeparator(tableRows[1])) {
            return { html: `<p>${this.formatAiInline(lines[startIndex] || '')}</p>`, nextIndex: startIndex + 1 };
        }

        const parseCells = (row) => row
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());

        const headerCells = parseCells(tableRows[0]);
        const bodyRows = tableRows
            .slice(2)
            .map(parseCells)
            .filter((cells) => cells.some((cell) => cell.length > 0));

        if (!headerCells.length || !bodyRows.length) {
            return { html: `<p>${this.formatAiInline(lines[startIndex] || '')}</p>`, nextIndex: startIndex + 1 };
        }

        const colCount = headerCells.length;
        const normalize = (cells) => {
            const data = [...cells];
            while (data.length < colCount) data.push('');
            return data.slice(0, colCount);
        };

        const thead = `<thead><tr>${normalize(headerCells).map((cell) => `<th>${this.formatAiInline(cell)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${bodyRows.map((cells) => `<tr>${normalize(cells).map((cell) => `<td>${this.formatAiInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`;

        const html = `<div class="ai-md-table-wrap"><table class="ai-md-table">${thead}${tbody}</table></div>`;
        return { html, nextIndex: i };
    }

    isAiSpecialLine(line) {
        const raw = String(line || '').trim();
        if (!raw) return true;
        if (/^\|.*\|$/.test(raw)) return true;
        if (/^#{1,6}\s+/.test(raw)) return true;
        if (/^(\-|\*|•)\s+/.test(raw)) return true;
        if (/^\d+[.)]\s+/.test(raw)) return true;
        if (/^\*\*.+\*\*$/.test(raw)) return true;
        return false;
    }

    formatAiMessageToHtml(content) {
        const lines = String(content || '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n');

        const blocks = [];
        let i = 0;

        while (i < lines.length) {
            const lineRaw = String(lines[i] || '');
            const line = lineRaw.trim();

            if (!line) {
                i++;
                continue;
            }

            if (/^\|.*\|$/.test(line) && i + 1 < lines.length && this.isAiTableSeparator(lines[i + 1])) {
                const { html, nextIndex } = this.renderAiTable(lines, i);
                blocks.push(html);
                i = nextIndex;
                continue;
            }

            if (/^#{1,6}\s+/.test(line)) {
                const lvl = Math.min(4, Math.max(1, (line.match(/^#{1,6}/)?.[0].length || 1)));
                const text = line.replace(/^#{1,6}\s+/, '');
                blocks.push(`<h${lvl}>${this.formatAiInline(text)}</h${lvl}>`);
                i++;
                continue;
            }

            if (/^\*\*.+\*\*$/.test(line)) {
                const text = line.replace(/^\*\*(.+)\*\*$/, '$1');
                blocks.push(`<h4>${this.formatAiInline(text)}</h4>`);
                i++;
                continue;
            }

            if (/^(\-|\*|•)\s+/.test(line)) {
                const items = [];
                while (i < lines.length) {
                    const current = String(lines[i] || '').trim();
                    if (!/^(\-|\*|•)\s+/.test(current)) break;
                    items.push(current.replace(/^(\-|\*|•)\s+/, ''));
                    i++;
                }
                blocks.push(`<ul>${items.map((it) => `<li>${this.formatAiInline(it)}</li>`).join('')}</ul>`);
                continue;
            }

            if (/^\d+[.)]\s+/.test(line)) {
                const items = [];
                while (i < lines.length) {
                    const current = String(lines[i] || '').trim();
                    if (!/^\d+[.)]\s+/.test(current)) break;
                    items.push(current.replace(/^\d+[.)]\s+/, ''));
                    i++;
                }
                blocks.push(`<ol>${items.map((it) => `<li>${this.formatAiInline(it)}</li>`).join('')}</ol>`);
                continue;
            }

            const paragraphLines = [line];
            i++;
            while (i < lines.length) {
                const current = String(lines[i] || '').trim();
                if (!current) {
                    i++;
                    break;
                }
                if (this.isAiSpecialLine(current)) break;
                paragraphLines.push(current);
                i++;
            }
            blocks.push(`<p>${this.formatAiInline(paragraphLines.join(' '))}</p>`);
        }

        if (!blocks.length) {
            return `<p>${this.formatAiInline(content || '')}</p>`;
        }
        return blocks.join('');
    }

    renderAiStructuredHtml(payload) {
        if (!payload || typeof payload !== 'object') return '';

        const safeResumo = this.formatAiInline(payload.resumo || '');
        const produtos = Array.isArray(payload.produtos_sugeridos) ? payload.produtos_sugeridos : [];
        const abordagem = Array.isArray(payload.abordagem_venda) ? payload.abordagem_venda : [];
        const acoesNota = Array.isArray(payload.acoes_melhorar_nota) ? payload.acoes_melhorar_nota : [];
        const proximosPassos = Array.isArray(payload.proximos_passos) ? payload.proximos_passos : [];
        const alertas = Array.isArray(payload.alertas) ? payload.alertas : [];
        const lacunas = Array.isArray(payload.lacunas_dados) ? payload.lacunas_dados : [];

        const sections = [];

        if (safeResumo) {
            const resumoLines = String(payload.resumo || '').split('\n').filter((l) => l.trim());
            const resumoHtml = resumoLines.length > 1
                ? resumoLines.map((l) => `<p>${this.formatAiInline(l)}</p>`).join('')
                : `<p>${safeResumo}</p>`;
            sections.push(`
                <section class="ai-struct-section">
                    <h4>Resumo</h4>
                    ${resumoHtml}
                </section>
            `);
        }

        if (produtos.length) {
            const cards = produtos.map((item, idx) => {
                const produto = this.formatAiInline(item?.produto || `Sugestão ${idx + 1}`);
                const motivo = this.formatAiInline(item?.motivo || '');
                const acao = this.formatAiInline(item?.acao || '');

                return `
                    <article class="ai-struct-card">
                        <div class="ai-struct-card-title">
                            <span class="ai-struct-chip">#${idx + 1}</span>
                            <h5>${produto}</h5>
                        </div>
                        ${motivo ? `<p><strong>Motivo:</strong> ${motivo}</p>` : ''}
                        ${acao ? `<p><strong>Ação:</strong> ${acao}</p>` : ''}
                    </article>
                `;
            }).join('');

            sections.push(`
                <section class="ai-struct-section">
                    <h4>Produtos para ofertar agora</h4>
                    <div class="ai-struct-cards">${cards}</div>
                </section>
            `);
        }

        if (abordagem.length) {
            sections.push(`
                <section class="ai-struct-section">
                    <h4>Como abordar a venda</h4>
                    <ul class="ai-struct-list">
                        ${abordagem.map((item) => `<li>${this.formatAiInline(item)}</li>`).join('')}
                    </ul>
                </section>
            `);
        }

        if (acoesNota.length) {
            const cards = acoesNota.map((item) => {
                const acao = this.formatAiInline(item?.acao || '');
                const impacto = this.formatAiInline(item?.impacto || '');
                const detalhe = this.formatAiInline(item?.detalhe || '');
                return `
                    <article class="ai-struct-card">
                        ${acao ? `<h5>${acao}</h5>` : ''}
                        ${impacto ? `<p><strong>Impacto:</strong> ${impacto}</p>` : ''}
                        ${detalhe ? `<p>${detalhe}</p>` : ''}
                    </article>
                `;
            }).join('');

            sections.push(`
                <section class="ai-struct-section">
                    <h4>Ações para melhorar nota</h4>
                    <div class="ai-struct-cards">${cards}</div>
                </section>
            `);
        }

        if (proximosPassos.length) {
            sections.push(`
                <section class="ai-struct-section">
                    <h4>Próximos passos</h4>
                    <ol class="ai-struct-list ai-struct-list-ordered">
                        ${proximosPassos.map((item) => `<li>${this.formatAiInline(item)}</li>`).join('')}
                    </ol>
                </section>
            `);
        }

        if (alertas.length) {
            sections.push(`
                <section class="ai-struct-section">
                    <h4>Alertas</h4>
                    <ul class="ai-struct-list">
                        ${alertas.map((item) => `<li>${this.formatAiInline(item)}</li>`).join('')}
                    </ul>
                </section>
            `);
        }

        if (lacunas.length) {
            sections.push(`
                <section class="ai-struct-section ai-struct-section-muted">
                    <h4>Lacunas de dados</h4>
                    <ul class="ai-struct-list">
                        ${lacunas.map((item) => `<li>${this.formatAiInline(item)}</li>`).join('')}
                    </ul>
                </section>
            `);
        }

        if (!sections.length) return '';
        return `<div class="ai-structured">${sections.join('')}</div>`;
    }

    appendAiStructuredMessage(payload, fallbackText = '') {
        if (!this.aiEls?.messages || !payload) return false;

        const structuredHtml = this.renderAiStructuredHtml(payload);
        if (!structuredHtml) {
            if (fallbackText) this.appendAiMessage('assistant', fallbackText);
            return false;
        }

        const row = document.createElement('div');
        row.className = 'ai-msg ai-msg-assistant';

        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble ai-msg-bubble--rich ai-msg-bubble--structured';
        bubble.innerHTML = structuredHtml;

        row.appendChild(bubble);
        this.aiEls.messages.appendChild(row);
        this.scrollAiToBottom();
        return true;
    }

    buildAiContextPayload() {
        const registros = Array.isArray(this.clienteData) ? this.clienteData : [];
        const primeiro = registros[0] || {};
        const periodo = this.getDateRangeForPeriod(this.currentPeriod || 'all');
        const topProdutos = Array.isArray(this.produtosInsights?.topProdutos) ? this.produtosInsights.topProdutos : [];
        const sugestoes = Array.isArray(this.produtosInsights?.sugestoes) ? this.produtosInsights.sugestoes : [];
        const pedidos = Array.isArray(this.pedidosInsights?.pedidos) ? this.pedidosInsights.pedidos : [];
        const pedidosResumo = this.pedidosInsights?.resumo || {};

        const totalLiquido = registros.reduce((sum, item) => sum + (parseFloat(item.VLLIQUIDO) || 0), 0);
        const totalFrete = registros.reduce((sum, item) => sum + (parseFloat(item.VL_FRETE_TOTAL_PEDIDOS) || 0), 0);
        const mediaAtual = registros.length
            ? (registros.reduce((sum, item) => sum + (parseFloat(item.MEDIA_PONDERADA) || 0), 0) / registros.length)
            : 0;

        const pedidosOrdenados = [...pedidos].sort((a, b) => {
            const dtA = a?.dataPedido ? new Date(a.dataPedido).getTime() : 0;
            const dtB = b?.dataPedido ? new Date(b.dataPedido).getTime() : 0;
            if (dtB !== dtA) return dtB - dtA;
            return Number(b?.numped || 0) - Number(a?.numped || 0);
        });
        const pedidosEnviados = pedidosOrdenados.slice(0, 24);

        const gaps = this.calcularGapsPorMetrica()
            .slice(0, 8)
            .map((g) => ({
                titulo: g.titulo,
                impacto: g.metaDisplay,
                descricao: this.stripHtml(g.descricao)
            }));

        const historicoMensal = registros.slice(0, 24).map((item) => ({
            mes: Number(item.MES) || null,
            ano: Number(item.ANO) || null,
            vlVenda: Number(parseFloat(item.VLVENDA) || 0),
            vlDevolucao: Number(parseFloat(item.VLDEVOLUCAO) || 0),
            vlLiquido: Number(parseFloat(item.VLLIQUIDO) || 0),
            vlFrete: Number(parseFloat(item.VL_FRETE_TOTAL_PEDIDOS) || 0),
            prazoMedio: Number(parseFloat(item.PRAZOMEDIO) || 0),
            qtdNotas: Number(parseFloat(item.QTD_NOTAS) || 0),
            mixItens: Number(parseFloat(item.MIX_ITENS) || 0),
            qtdItensFaturados: Number(parseFloat(item.QTD_ITENS_FATURADOS) || 0),
            mediaPonderada: Number(parseFloat(item.MEDIA_PONDERADA) || 0),
            notas: {
                faturamento: Number(parseFloat(item.NOTA_AL) || 0),
                devolucao: Number(parseFloat(item.NOTA_AM) || 0),
                frete: Number(parseFloat(item.NOTA_AN) || 0),
                mix: Number(parseFloat(item.NOTA_AO) || 0),
                volume: Number(parseFloat(item.NOTA_AP) || 0),
                prazo: Number(parseFloat(item.NOTA_AQ) || 0),
                canal: Number(parseFloat(item.NOTA_AR) || 0),
                desconto: Number(parseFloat(item.NOTA_AS) || 0),
                frequencia: Number(parseFloat(item.NOTA_AT) || 0),
                atraso: Number(parseFloat(item.NOTA_AU) || 0)
            }
        }));

        const codRcaResponsavel = Number(
            this.rcaAtualInfo?.codRca
            || primeiro.CODUSUR_ATUAL
            || 0
        ) || null;

        const nomeRcaResponsavel = this.sanitizeRcaNome(this.rcaAtualInfo?.nomeRca)
            || (codRcaResponsavel ? `RCA ${codRcaResponsavel}` : null);
        const codRcaUltimaVenda = Number(primeiro.CODUSUR_ULTIMA_VENDA || 0) || null;
        const nomeRcaUltimaVenda = this.sanitizeRcaNome(primeiro.NOME_ULTIMO_RCA || null);
        const categoriaWinthorAtual = String(primeiro.CATEGORIA || primeiro.categoria || '')
            .trim()
            .toUpperCase() || null;

        return {
            contexto: 'detalhes_cliente',
            avisoContexto: 'cliente é o comprador. vendedorResponsavel e ultimoVendedorVenda são vendedores (RCA), nunca o cliente.',
            restricoesResposta: [
                'Nunca usar nome de vendedor/RCA como saudação para o cliente.',
                'Se não houver nome de contato do cliente, usar saudação genérica: "Olá, equipe da <fantasia>".',
                'Usar sempre a categoria real do WinThor em categoriaWinthorAtual.',
            ],
            filtroAtual: {
                periodo: this.currentPeriod || 'all',
                dataIni: periodo.dataIni,
                dataFim: periodo.dataFim
            },
            cliente: {
                codcli: primeiro.CODCLI || this.clienteCod || null,
                cliente: primeiro.CLIENTE || null,
                fantasia: primeiro.FANTASIA || null,
                cidade: primeiro.MUNICENT || null,
                estado: primeiro.ESTENT || null,
                ramoAtividade: primeiro.RAMO_ATIVIDADE || null,
                categoria: categoriaWinthorAtual,
                categoriaWinthorAtual,
            },
            categoriaWinthor: {
                valor: categoriaWinthorAtual,
                fonte: 'PCCLIENT.CATEGORIA',
            },
            contatoCliente: {
                nome: null,
                observacao: 'Sem nome de contato no contexto atual.',
            },
            vendedorResponsavel: {
                codRca: codRcaResponsavel,
                nome: nomeRcaResponsavel,
                fonte: 'PCCLIENT.CODUSUR1'
            },
            ultimoVendedorVenda: {
                codRca: codRcaUltimaVenda,
                nome: nomeRcaUltimaVenda,
                dataUltimaVenda: primeiro.DT_ULTIMA_VENDA || null
            },
            resumoPeriodo: {
                mesesExibidos: registros.length,
                mediaPeriodo: Number(mediaAtual.toFixed(2)),
                classificacaoMedia: this.getClassificacao(mediaAtual),
                totalLiquido: Number(totalLiquido.toFixed(2)),
                totalFrete: Number(totalFrete.toFixed(2))
            },
            topProdutos: topProdutos.slice(0, 12).map((p) => ({
                codprod: p.codprod,
                produto: p.produto,
                qtdTotal: Number(p.qtdTotal || 0),
                valorTotal: Number(p.valorTotal || 0),
                pedidos: Number(p.pedidos || 0),
                participacaoQtd: Number(p.participacaoQtd || 0)
            })),
            sugestoesProdutos: sugestoes.slice(0, 10).map((s) => ({
                tipo: s.tipo || null,
                titulo: s.titulo || s.produto || null,
                descricao: this.stripHtml(s.descricao || '')
            })),
            pedidosPeriodo: {
                totalPedidos: Number(pedidosResumo.totalPedidos || pedidos.length || 0),
                valorTotal: Number(pedidosResumo.valorTotal || 0),
                ticketMedio: Number(pedidosResumo.ticketMedio || 0),
                qtdItens: Number(pedidosResumo.qtdItens || 0),
                pedidosEnviados: pedidosEnviados.length,
                pedidosOmitidos: Math.max(0, pedidosOrdenados.length - pedidosEnviados.length),
                pedidos: pedidosEnviados.map((pedido) => {
                    const itens = Array.isArray(pedido?.itens) ? pedido.itens : [];
                    const itensEnviados = itens.slice(0, 20);
                    return {
                        numped: Number(pedido?.numped || 0),
                        dataPedido: pedido?.dataPedido || null,
                        valorTotal: Number(pedido?.valorTotal || 0),
                        qtdItens: Number(pedido?.qtdItens || 0),
                        qtdProdutos: Number(pedido?.qtdProdutos || 0),
                        itensEnviados: itensEnviados.length,
                        itensOmitidos: Math.max(0, itens.length - itensEnviados.length),
                        itens: itensEnviados.map((item) => ({
                            codprod: Number(item?.codprod || 0),
                            produto: item?.produto || null,
                            qtd: Number(item?.qtd || 0),
                            valorTotal: Number(item?.valorTotal || 0),
                        })),
                    };
                }),
            },
            acoesMelhoriaNota: gaps,
            historicoMensal
        };
    }

    async handleAiSubmit() {
        if (!this.aiEls?.input || !this.aiEls?.send) return;
        if (this.aiChat.isSending) return;

        const message = this.aiEls.input.value.trim();
        if (!message) return;
        const historyForRequest = this.aiChat.history.slice(-8);

        if (!this.aiChat.isOpen) this.toggleAiChat(true);

        this.aiEls.input.value = '';
        this.appendAiMessage('user', message);
        this.aiChat.history.push({ role: 'user', content: message });
        this.aiChat.history = this.aiChat.history.slice(-16);

        this.setAiSendingState(true);
        this.setAiTyping(true);

        try {
            const response = await fetch('/api/ai/chat-cliente', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    history: historyForRequest,
                    context: this.buildAiContextPayload()
                })
            });

            const result = await response.json();
            if (!response.ok || !result?.success) {
                throw new Error(result?.error || `Falha HTTP ${response.status}`);
            }

            const reply = String(result.reply || '').trim();
            if (!reply) {
                throw new Error('A IA não retornou texto.');
            }

            this.appendAiMessage('assistant', reply);

            this.aiChat.history.push({ role: 'assistant', content: reply });
            this.aiChat.history = this.aiChat.history.slice(-16);
        } catch (error) {
            console.error('[IA Cliente] Erro ao enviar mensagem:', error);
            this.appendAiMessage('assistant', 'Não consegui consultar a IA agora. Tente novamente em alguns segundos.');
        } finally {
            this.setAiTyping(false);
            this.setAiSendingState(false);
            this.aiEls.input.focus();
        }
    }

    // Helpers
    getMonthName(mes) {
        const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        return months[parseInt(mes) - 1] || mes;
    }

    getMonthNameShort(mes) {
        const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        return months[parseInt(mes) - 1] || mes;
    }

    getClassificacao(media) {
        const n = parseFloat(media) || 0;
        if (n < 6.0) return 'BRONZE';
        if (n < 7.0) return 'PRATA';
        if (n < 8.0) return 'OURO';
        if (n < 9.0) return 'PLATINUM';
        return 'DIAMANTE';
    }

    formatScore(score) {
        const n = parseFloat(score) || 0;
        let color = '#ef4444'; // poor (red)
        if (n >= 8) color = '#22c55e'; // excellent (green)
        else if (n >= 5) color = '#3b82f6'; // good (blue)
        
        // Ajuste para Dark Mode no inline style é complexo, melhor usar classes se possível, 
        // mas aqui mantivemos inline para simplicidade com cores vivas que funcionam em ambos.
        return `<span style="color:${color}; font-weight:700">${n.toFixed(1)}</span>`;
    }

    formatCurrency(val) {
        return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    formatQuantity(val) {
        const n = Number(val || 0);
        if (Number.isInteger(n)) {
            return n.toLocaleString('pt-BR');
        }
        return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    
    formatMoney(val) {
        // Formata sem o "R$" para os cards (o "R$" já está no HTML)
        return val.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    }

    formatDateForAPI(date) {
        const d = String(date.getDate()).padStart(2, '0');
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const y = date.getFullYear();
        return `${d}/${m}/${y}`;
    }

    formatDateBR(value) {
        if (!value) return '-';
        const dt = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(dt.getTime())) return String(value);
        return dt.toLocaleDateString('pt-BR');
    }

    showLoading(show) {
        const el = document.getElementById('loading');
        if(el) el.classList.toggle('hidden', !show);
    }

    showError(msg) {
        const el = document.getElementById('error');
        if(el) {
            document.getElementById('errorMessage').textContent = msg;
            el.classList.remove('hidden');
        }
    }

    hideError() {
        const el = document.getElementById('error');
        if(el) el.classList.add('hidden');
    }
    
    // Mantive exportDetails igual, apenas omiti para economizar espaço se não mudou a lógica
    async exportDetails() {
        if (!this.clienteData) return;
        try {
            const response = await fetch('/api/export-csv', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: this.clienteData })
            });
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = `detalhes_${this.clienteCod}.csv`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            } else { throw new Error('Erro na exportação'); }
        } catch (error) { this.showError('Erro export: ' + error.message); }
    }

    // ===========================
    // NOVO: COMPARAÇÃO DE PERFORMANCE
    // ===========================
    displayPerformanceComparison() {
        console.log("Iniciando comparação de performance..."); // DEBUG

        if (!this.clienteData || this.clienteData.length === 0) {
            console.warn("Sem dados de cliente para comparar.");
            return;
        }

        // DEBUG: Verifique como os dados estão chegando
        console.log("Exemplo de registro:", this.clienteData[0]);

        // Cria uma cópia e ordena por NOTA (Media Ponderada)
        const sortedData = [...this.clienteData].sort((a, b) => {
            // Tenta converter, se não der certo usa 0
            const notaA = parseFloat(a.MEDIA_PONDERADA || a.media || 0);
            const notaB = parseFloat(b.MEDIA_PONDERADA || b.media || 0);
            return notaA - notaB;
        });

        // Pior Mês (primeiro da lista)
        const worst = sortedData[0];
        // Melhor Mês (último da lista)
        const best = sortedData[sortedData.length - 1];

        console.log("Melhor:", best, "Pior:", worst); // DEBUG

        // Atualiza Melhor Mês
        this.updateComparisonCard('best', best);
        
        // Atualiza Pior Mês
        this.updateComparisonCard('worst', worst);
    }

    // E atualize o updateComparisonCard para ser mais seguro:
    updateComparisonCard(type, data) {
        if (!data) return;

        // Tenta pegar MEDIA_PONDERADA, se não existir tenta 'media', senão 0
        const mediaVal = data.MEDIA_PONDERADA !== undefined ? data.MEDIA_PONDERADA : data.media;
        const vendaVal = data.VLVENDA !== undefined ? data.VLVENDA : data.venda;

        const media = parseFloat(mediaVal) || 0;
        const venda = parseFloat(vendaVal) || 0;
        const classificacao = this.getClassificacao(media);
        
        // Elementos DOM - Verifica se existem antes de tentar alterar
        const elDate = document.getElementById(`${type}MonthDate`);
        const elScore = document.getElementById(`${type}MonthScore`);
        const elSales = document.getElementById(`${type}MonthSales`);
        const elBadge = document.getElementById(`${type}MonthBadge`);

        if(elDate) elDate.textContent = `${this.getMonthName(data.MES)}/${data.ANO}`;
        if(elScore) elScore.textContent = media.toFixed(2);
        if(elSales) elSales.textContent = this.formatCurrency(venda);
        
        if(elBadge) {
            elBadge.innerHTML = `<span class="classification-badge classification-${classificacao.toLowerCase()}">${classificacao}</span>`;
        }
    }


    // =========================================================
    // 1. FUNÇÃO QUE DESENHA O CONTAINER DO GAP
    // =========================================================

// =========================================================
    // RENDERIZADOR: PLANO DE AÇÃO
    // =========================================================
    renderProximoNivel(mediaAtual) {
        const container = document.getElementById('nextLevelContainer');
        if (!container) return;

        const media = parseFloat(mediaAtual) || 0;
        
        const niveis = [
            { nome: 'BRONZE',   min: 0, max: 6.0 },
            { nome: 'PRATA',    min: 6.0, max: 7.0 },
            { nome: 'OURO',     min: 7.0, max: 8.0 },
            { nome: 'PLATINUM', min: 8.0, max: 9.0 },
            { nome: 'DIAMANTE', min: 9.0, max: 10.0 }
        ];

        let nivelAtual = niveis[0];
        let proximoNivel = null;

        for (let i = 0; i < niveis.length; i++) {
            if (media >= niveis[i].min && media < niveis[i].max) {
                nivelAtual = niveis[i];
                proximoNivel = niveis[i + 1] || null;
                break;
            } else if (media >= 9.0) {
                nivelAtual = niveis[4];
            }
        }

        const sugestoes = this.calcularGapsPorMetrica();

        let htmlGaps = '';
        if (sugestoes.length > 0) {
            htmlGaps = '<div class="gap-grid">';
            sugestoes.forEach(sug => {
                htmlGaps += `
                    <div class="gap-card">
                        <div class="gap-icon">${sug.icon}</div>
                        <div class="gap-content">
                            <div class="gap-title">${sug.titulo}</div>
                            <div class="gap-desc">${sug.descricao}</div>
                            <div class="gap-meta" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd;">
                                Impacto: <strong>${sug.metaDisplay}</strong>
                            </div>
                        </div>
                    </div>
                `;
            });
            htmlGaps += '</div>';
        } else {
            htmlGaps = '<p style="text-align:center; padding:15px; color:var(--text-muted)">Cliente com pontuação máxima em todos os indicadores recentes.</p>';
        }

        const range = nivelAtual.max - nivelAtual.min;
        const progresso = Math.min(100, Math.max(0, ((media - nivelAtual.min) / range) * 100));
        const metaTexto = proximoNivel ? `META: ${proximoNivel.nome} (${proximoNivel.min.toFixed(1)})` : "NÍVEL MÁXIMO";

        container.innerHTML = `
            <div style="margin-bottom: 20px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:5px; font-weight:bold; color:var(--text-main)">
                    <span>${nivelAtual.nome} (${media.toFixed(2)})</span>
                    <span>${metaTexto}</span>
                </div>
                <div class="progress-bg">
                    <div class="progress-fill" style="width: ${progresso}%"></div>
                </div>
            </div>
            
            <h4 style="margin: 20px 0 10px 0; font-size: 0.95rem; border-left: 4px solid var(--primary); padding-left: 10px; color:var(--text-main)">
                O que falta para chegar lá?
            </h4>
            ${htmlGaps}
        `;
    }

    // =========================================================
    // CÁLCULO MATEMÁTICO COM PESO (IMPACTO NA MÉDIA GERAL)
    // =========================================================
    calcularGapsPorMetrica() {
        if (!this.originalData || this.originalData.length === 0) return [];

        const hoje = new Date();
        const mesAtual = hoje.getMonth() + 1;
        const anoAtual = hoje.getFullYear();

        // 1. Filtra meses fechados
        let dadosParaCalculo = this.originalData.filter(item => {
            const m = parseInt(item.MES);
            const a = parseInt(item.ANO);
            return a < anoAtual || (a === anoAtual && m < mesAtual);
        }).slice(0, 6);

        if (dadosParaCalculo.length === 0) {
            dadosParaCalculo = this.originalData.slice(0, 6); // Fallback para cliente novo
        }
        if (dadosParaCalculo.length === 0) return [];

        const lastReg = dadosParaCalculo[0];
        let codRamo = parseInt(lastReg.COD_RAMO_ATIVIDADE || lastReg.cod_ramo_atividade || 0);
        if (!codRamo) codRamo = 12; // Fallback seguro para Indústria

        // Helpers
        const getAvg = (chave) => {
            let validCount = 0;
            const sum = dadosParaCalculo.reduce((acc, item) => {
                const valRaw = item[chave] !== undefined ? item[chave] : item[chave.toLowerCase()];
                const val = parseFloat(valRaw);
                return !isNaN(val) ? (validCount++, acc + val) : acc;
            }, 0);
            return validCount > 0 ? sum / validCount : 0;
        };

        const gaps = [];
        const TOTAL_PESO = 600; // Soma dos pesos do seu sistema

        // Função que calcula quanto a média geral subiria se essa nota fosse 10
        const calcImpacto = (notaAtual, peso) => {
            const gapNota = 10 - notaAtual;
            if (gapNota <= 0) return 0;
            return (gapNota * peso) / TOTAL_PESO;
        };

        const formatImpacto = (val) => `+${val.toFixed(2)} pts`;

        // 1. FATURAMENTO (Peso 100)
        let metaFat = 4000;
        if (codRamo === 12) metaFat = 10000; else if (codRamo === 11) metaFat = 5000;
        const mediaFat = getAvg('VLLIQUIDO');
        const notaFat = getAvg('NOTA_AL');
        
        if (notaFat < 9.9) {
            let falta = metaFat - mediaFat;
            if (falta < 0) falta = 1000;
            gaps.push({
                icon: '<i class="fas fa-dollar-sign"></i>',
                titulo: 'Faturamento',
                descricao: `Vender mais <span style="color:#ef4444; font-weight:bold">${this.formatCurrency(falta)}</span> na média.`,
                metaDisplay: formatImpacto(calcImpacto(notaFat, 100))
            });
        }

        // 2. MIX (Peso 100)
        let metaMix = 8;
        if (codRamo === 12) metaMix = 25; else if (codRamo === 11) metaMix = 14;
        const mediaMix = getAvg('MIX_ITENS');
        const notaMix = getAvg('NOTA_AO');

        if (notaMix < 9.9) {
            let falta = Math.ceil(metaMix - mediaMix);
            if (falta <= 0) falta = 1;
            gaps.push({
                icon: '<i class="fas fa-cubes"></i>',
                titulo: 'Mix de Produtos',
                descricao: `Adicionar <span style="color:#ef4444; font-weight:bold">${falta} itens</span> ao mix.`,
                metaDisplay: formatImpacto(calcImpacto(notaMix, 100))
            });
        }

        // 3. VOLUME (Peso 100)
        let metaVol = 280;
        if (codRamo === 12) metaVol = 570; else if (codRamo === 11) metaVol = 300;
        const mediaVol = getAvg('QTD_ITENS_FATURADOS');
        const notaVol = getAvg('NOTA_AP');

        if (notaVol < 9.9) {
            let falta = Math.ceil(metaVol - mediaVol);
            if (falta <= 0) falta = 10;
            gaps.push({
                icon: '<i class="fas fa-boxes"></i>',
                titulo: 'Volume',
                descricao: `Vender mais <span style="color:#ef4444; font-weight:bold">${falta} unidades</span>.`,
                metaDisplay: formatImpacto(calcImpacto(notaVol, 100))
            });
        }

        // 4. PRAZO MÉDIO (Peso 100)
        let metaPrazo = (codRamo === 12 || codRamo === 11) ? 30 : 45; 
        const mediaPrazo = getAvg('PRAZOMEDIO');
        const notaPrazo = getAvg('NOTA_AQ');

        if (notaPrazo < 9.9) {
            let dias = Math.ceil(mediaPrazo - metaPrazo);
            if (dias <= 0) dias = 5; // Estimativa se a nota está baixa por outro motivo
            gaps.push({
                icon: '<i class="fas fa-calendar-minus"></i>',
                titulo: 'Prazo Médio',
                descricao: `Reduzir <span style="color:#ef4444; font-weight:bold">${dias} dias</span> no prazo.`,
                metaDisplay: formatImpacto(calcImpacto(notaPrazo, 100))
            });
        }

        // 5. TIPO VENDA (Peso 60) - Nota AR
        // Nota AR geralmente é binária (Site=10, Caixa=0). Difícil dar um "gap numérico" além de "Use o Site".
        const notaTipo = getAvg('NOTA_AR');
        if (notaTipo < 9.9) {
            gaps.push({
                icon: '<i class="fas fa-laptop"></i>',
                titulo: 'Canal de Venda',
                descricao: `Priorizar compras via <strong>Site/Portal</strong>.`,
                metaDisplay: formatImpacto(calcImpacto(notaTipo, 60))
            });
        }

        // 6. PAGAMENTOS (Peso 60)
        const notaPag = getAvg('NOTA_AU');
        if (notaPag < 9.9) {
            gaps.push({
                icon: '<i class="fas fa-calendar-check"></i>',
                titulo: 'Pagamentos',
                descricao: `Pagar boletos rigorosamente em dia.`,
                metaDisplay: formatImpacto(calcImpacto(notaPag, 60))
            });
        }

        // 7. FRETE (Peso 20)
        const mediaFrete = getAvg('VL_FRETE_TOTAL_PEDIDOS');
        const notaFrete = getAvg('NOTA_AN');
        if (notaFrete < 9.9) {
            gaps.push({
                icon: '<i class="fas fa-truck"></i>',
                titulo: 'Frete',
                descricao: `Reduzir <span style="color:#ef4444; font-weight:bold">${this.formatCurrency(mediaFrete)}</span> de frete.`,
                metaDisplay: formatImpacto(calcImpacto(notaFrete, 20))
            });
        }

        // 8. DEVOLUÇÃO (Peso 20)
        const mediaDev = getAvg('VLDEVOLUCAO');
        const notaDev = getAvg('NOTA_AM');
        if (notaDev < 9.9) {
            gaps.push({
                icon: '<i class="fas fa-undo"></i>',
                titulo: 'Devoluções',
                descricao: `Reduzir <span style="color:#ef4444; font-weight:bold">${this.formatCurrency(mediaDev)}</span> em devoluções.`,
                metaDisplay: formatImpacto(calcImpacto(notaDev, 20))
            });
        }

        // 9. DESCONTOS (Peso 20)
        // ✅ Ajuste para seguir a regra nova:
        // - Se NOTA_AS já for 10 (ex.: DPIX+SITE) => não cria ação
        // - Só cria ação quando existir desconto positivo real (VLDESCONTOS > 0)
        const mediaDesc = getAvg('VLDESCONTOS');      // média do valor de desconto (positivo = desconto concedido)
        const notaDesc  = getAvg('NOTA_AS');

        if (notaDesc < 9.9 && mediaDesc > 0.00001) {
            gaps.push({
                icon: '<i class="fas fa-percent"></i>',
                titulo: 'Descontos',
                descricao: `Reduzir descontos comerciais (Excesso médio: ${this.formatCurrency(mediaDesc)}).`,
                metaDisplay: formatImpacto(calcImpacto(notaDesc, 20))
            });
        }

        // 10. FREQUÊNCIA (Peso 20)
        const mediaNotas = getAvg('QTD_NOTAS');
        const notaFreq = getAvg('NOTA_AT');
        if (notaFreq < 9.9) {
            let faltam = Math.ceil(4 - mediaNotas);
            if (faltam <= 0) faltam = 1;
            gaps.push({
                icon: '<i class="fas fa-receipt"></i>',
                titulo: 'Frequência',
                descricao: `Fazer mais <span style="color:#ef4444; font-weight:bold">${faltam} compras</span>/mês.`,
                metaDisplay: formatImpacto(calcImpacto(notaFreq, 20))
            });
        }

        // Ordena para mostrar os de MAIOR IMPACTO primeiro
        gaps.sort((a, b) => {
            const impA = parseFloat(a.metaDisplay.replace('+','').replace(' pts',''));
            const impB = parseFloat(b.metaDisplay.replace('+','').replace(' pts',''));
            return impB - impA;
        });

        return gaps;
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

document.addEventListener('DOMContentLoaded', () => {
    new DetalhesCliente();
});

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    
    // 1. Pegar params da URL
    const urlParams = new URLSearchParams(window.location.search);
    const rcaId = urlParams.get('rca');
    const rcaNome = urlParams.get('nome');

    if (!rcaId) {
        alert('RCA não especificado.');
        window.location.href = 'relatorio-gestores.html';
        return;
    }

    // 2. Preencher Título
    document.getElementById('rcaTitle').textContent = `${rcaId} - ${rcaNome || 'Vendedor'}`;

    try {
        // 3. Buscar Dados
        const response = await fetch(`/api/carteira-rca/${rcaId}`);
        const json = await response.json();

        if (json.success) {
            renderTable(json.data);
        } else {
            throw new Error(json.error || 'Erro desconhecido');
        }

    } catch (error) {
        console.error(error);
        document.getElementById('loader').innerHTML = `<span style="color:var(--danger)">Erro: ${error.message}</span>`;
    }
});

function renderTable(data) {
    const tbody = document.getElementById('carteiraBody');
    document.getElementById('totalClientesBadge').textContent = `${data.length} Clientes`;

    // Otimização: Gera string HTML única
    const rows = data.map(item => {
        const classificacao = item.classificacao_atual || 'BRONZE';
        const dias = item.dias_sem_compra || 0;
        
        // Formata data
        let dataUltima = '-';
        if (item.data_ultimo_pedido) {
            dataUltima = new Date(item.data_ultimo_pedido).toLocaleDateString('pt-BR');
        }

        // Define cor do status de dias
        let diasBadgeClass = 'bg-green';
        if (dias > 30) diasBadgeClass = 'bg-yellow';
        if (dias > 60) diasBadgeClass = 'bg-red';

        // Link para detalhes do cliente (reusando a página existente)
        // OBS: Como não temos filtros de data aqui, mandamos um range genérico de 1 ano para o detalhe abrir
        const today = new Date();
        const lastYear = new Date(); lastYear.setFullYear(today.getFullYear() - 1);
        const dFim = today.toISOString().split('T')[0];
        const dIni = lastYear.toISOString().split('T')[0];
        const linkDetalhe = `/detalhes-cliente?codcli=${item.codcli}&dataIni=${dIni}&dataFim=${dFim}&codFilial=1,3`;

        return `
            <tr onclick="window.location.href='${linkDetalhe}'" style="cursor:pointer">
                <td><strong>${item.codcli}</strong></td>
                <td style="color:var(--primary); font-weight:600">${item.cliente}</td>
                <td><span class="badge bg-blue">${classificacao}</span></td>
                <td>${item.grupo_carteira || 'NORMAL'}</td>
                <td><span class="badge ${diasBadgeClass}">${dias} dias</span></td>
                <td>${dataUltima}</td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = rows;

    document.getElementById('loader').style.display = 'none';
    document.getElementById('mainContent').style.display = 'block';
}

// ===========================
// TEMA (Reutilizado)
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
    if (btn) btn.innerHTML = document.body.classList.contains('light')
        ? '<i class="fas fa-moon"></i>'
        : '<i class="fas fa-sun"></i>';
}


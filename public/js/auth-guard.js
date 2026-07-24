// auth-guard.js - Controle de Acesso e Permissões Granulares
(async function() {
    
    // 1. BLOQUEIO VISUAL IMEDIATO
    const styleBlock = document.createElement('style');
    styleBlock.id = 'auth-guard-style';
    styleBlock.innerHTML = 'body { display: none !important; opacity: 0 !important; }';
    document.head.appendChild(styleBlock);

    // 2. Aplica tema — suporta 'dark', 'light' e padrão (sem classe)
    function applyTheme() {
        const savedTheme = localStorage.getItem('theme');
        const theme = savedTheme === 'light' ? 'light' : 'default';
        if (!document.body) return;
        if (savedTheme === 'dark') localStorage.setItem('theme', 'default');
        // ✅ Sincroniza com o sistema de tema das páginas (light / default)
        const resolvedTheme = theme === 'light' ? 'light' : 'dark';
        document.body.classList.remove('dark', 'light');
        document.body.classList.add(resolvedTheme);
        document.body.dataset.theme = resolvedTheme;
        document.documentElement.dataset.theme = resolvedTheme;
        document.documentElement.style.colorScheme = resolvedTheme;
    }
    if (document.body) applyTheme();
    else document.addEventListener('DOMContentLoaded', applyTheme);

    // Função para desbloquear a visão
    function revealPage() {
        const style = document.getElementById('auth-guard-style');
        if (style) style.remove();
        
        if (document.body) {
            document.body.classList.remove('hidden-until-auth');
            document.body.style.display = ''; 
            document.body.style.opacity = '';
        }
    }

    try {
        const response = await fetch('/api/user-info');
        if (!response.ok) window.location.href = '/login.html';

        const user = await response.json();

        if (!user.logged) {
            window.location.href = '/login.html';
            return;
        }

        console.log(`[Auth] User: ${user.email} | Config: ${user.isConfig} | Painel: ${user.isPainel} | Excel: ${user.isExcel} | Admin: ${user.isAdmin}`);

        const path = window.location.pathname;

        // --- LÓGICA DE INTERFACE (REMOVE BOTÕES SE NÃO TIVER PERMISSÃO) ---
        
        const updateInterface = () => {
            // 1. Botão Configurações
            if (!user.isConfig) {
                document.querySelectorAll('#btnConfiguracoes, a[href*="configuracoes"]').forEach(el => el.remove());
            }

            // 2. Botão Painel Gestor
            if (!user.isPainel) {
                document.querySelectorAll('#btnPainelGestor, a[href*="relatorio-gestores"]').forEach(el => el.remove());
            }

            // 3. Botão Exportar Excel
            if (!user.isExcel) {
                document.querySelectorAll('#exportBtn, #exportDetailsBtn, .btn-excel').forEach(el => el.remove());
            }
            
            // 4. Elementos exclusivos de Super Admin (Incluindo Substituição de Carteira)
            // ALTERAÇÃO AQUI: Adicionado #btnSubstituicaoCarteira na lista de remoção
            if (!user.isAdmin) {
                document.querySelectorAll('#btnSubstituicaoCarteira, .admin-only').forEach(el => el.remove());
            }
        };

        // Executa limpeza de interface
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', updateInterface);
        } else {
            updateInterface();
        }

        // --- LÓGICA DE BLOQUEIO DE PÁGINA (REDIRECT) ---
        
        let accessDenied = false;

        // Regra 1: Pagina de Configurações
        if ((path.includes('/configuracoes') || path.includes('config-parametros')) && !user.isConfig) {
            accessDenied = true;
        }

        // Regra 2: Página de Relatório Gestor
        if ((path.includes('/relatorio-gestores') || path.includes('relatorio-gestores')) && !user.isPainel) {
            accessDenied = true;
        }

        // Regra 3: Página de Substituição de Carteira (NOVA REGRA)
        // Impede acesso direto pela URL se não for Admin
        if ((path.includes('/substituicao-carteira') || path.includes('substituicao-carteira')) && !user.isAdmin) {
            accessDenied = true;
        }

        if (accessDenied) {
            // Bloqueio Total
            const doBlock = () => {
                document.body.innerHTML = ''; 
                applyTheme(); 
                const style = document.getElementById('auth-guard-style');
                if(style) style.remove();
                document.body.classList.remove('hidden-until-auth');
                renderAccessDenied(user.name);
            };

            if (document.body) doBlock();
            else document.addEventListener('DOMContentLoaded', doBlock);
            return; 
        }

        // --- LIBERA A TELA (Sucesso) ---
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', revealPage);
        } else {
            revealPage();
        }

    } catch (error) {
        console.error('[Auth] Erro:', error);
        window.location.href = '/login.html';
    }
})();

function renderAccessDenied(userName) {
    document.body.style.display = 'flex';
    document.body.style.alignItems = 'center';
    document.body.style.justifyContent = 'center';
    document.body.style.height = '100vh';
    document.body.style.margin = '0';
    document.body.style.fontFamily = "'Inter', sans-serif";
    
    const style = document.createElement('style');
    style.innerHTML = `
        body { background-color: #f1f5f9; color: #1e293b; }
        .access-card { background: #ffffff; border: 1px solid #e2e8f0; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); width: 90%; max-width: 420px; padding: 40px; border-radius: 16px; text-align: center; }
        body.dark { background-color: #0f172a !important; color: #f1f5f9 !important; }
        body.dark .access-card { background: #1e293b !important; border: 1px solid #334155 !important; }
        .icon-lock { width: 80px; height: 80px; background: #fee2e2; color: #ef4444; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.5rem; margin: 0 auto 20px auto; }
        body.dark .icon-lock { background: rgba(239, 68, 68, 0.2); }
        .btn-home { display: inline-block; background: #007dcc; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; margin-top: 20px;}
    `;
    document.head.appendChild(style);

    document.body.innerHTML = `
        <div class="access-card">
            <div class="icon-lock"><i class="fas fa-lock"></i></div>
            <h2 style="margin: 0 0 10px 0;">Acesso Restrito</h2>
            <p style="opacity: 0.8;">Olá <strong>${userName}</strong>.<br>Você não tem permissão para acessar esta área específica.</p>
            <a href="/" class="btn-home">Voltar ao Início</a>
        </div>
    `;
}

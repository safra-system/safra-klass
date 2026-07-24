const btn = document.getElementById('toggleBtn');
const btnText = document.getElementById('btnText');
const card = document.getElementById('mainCard');

// Função para atualizar a UI baseada no estado
function updateUI(envName, envKey) {
    btnText.textContent = `CONECTADO EM ${envName}`;
    
    // Remove classes antigas
    card.classList.remove('mode-prod', 'mode-test');

    if (envKey === 'PROD') {
        card.classList.add('mode-prod');
        btn.innerHTML = `<i class="fas fa-database icon-large"></i> <span>CONECTADO EM ${envName}</span>`;
    } else {
        card.classList.add('mode-test');
        btn.innerHTML = `<i class="fas fa-flask icon-large"></i> <span>CONECTADO EM ${envName}</span>`;
    }
}

// Carregar estado inicial
async function loadStatus() {
    try {
        const res = await fetch('/api/env-status');
        const data = await res.json();
        updateUI(data.env, data.key);
    } catch (err) {
        btnText.textContent = "Erro ao carregar";
    }
}

// Realizar a troca
async function toggleEnv() {
    btn.classList.add('loading');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Alterando conexão...';

    try {
        // 1. Chama a API para trocar o banco
        const res = await fetch('/api/switch-env', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {

            try {
                await fetch('/api/clear-cache', { method: 'POST' });
                console.log('Cache limpo após troca de ambiente.');
            } catch (cacheErr) {
                console.error('Erro ao limpar cache:', cacheErr);
            }

            // Recarrega o status para garantir sincronia e atualizar a tela
            loadStatus();
            
            // Feedback visual rápido (opcional, mas bom para UX)
            alert(`Ambiente alterado com sucesso! Cache limpo.`);
        }
    } catch (err) {
        alert('Erro ao trocar ambiente');
        btn.innerHTML = originalText;
    } finally {
        btn.classList.remove('loading');
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

// Inicializa
loadStatus();
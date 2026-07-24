// test-mov-cart.js
require('dotenv').config();
const MovimentacaoCarteiraService = require('./movimentacao-carteira-service');
const dbSwitch = require('./db-switch');

(async () => {
  try {
    // Passa o console como logger para vermos tudo no terminal
    await dbSwitch.switchEnv(); // opcional
    const service = new MovimentacaoCarteiraService(console);

    console.log('--- 🏁 INICIO DO TESTE INDIVIDUAL (ETAPAS 1, 2, 3) ---');
    
    // 1. Processa o cliente específico (Vai classificar, verificar Upgrade/Bitrix e mover se necessário)
    const resultado = await service.processarCliente({
      CodFilial: [1, 3],
      ClienteCod: 6731, 
      DataIni: '01/01/2025',
      DataFim: '01/12/2025',
    });

    console.log('\n📦 Resultado do Processamento Individual:');
    console.log(JSON.stringify(resultado, null, 2));

    console.log('\n-------------------------------------------------------');
    console.log('--- 🚀 INICIO DO TESTE DE REDISTRIBUIÇÃO (ETAPA 5) ---');
    console.log('-------------------------------------------------------\n');

    // 2. Executa a Redistribuição Global
    // Isso vai olhar a tabela 'clientes_rotativos' no Postgres e tentar distribuir
    // para os vendedores 121..128, 10, 110 se eles tiverem vagas.
    await service.executarEtapa5Redistribuicao({skipBitrix: true});

  } catch (err) {
    console.error('❌ Erro no teste de movimentação:', err);
  } finally {
    console.log('\n🏁 Teste finalizado.');
    process.exit(0);
  }
})();
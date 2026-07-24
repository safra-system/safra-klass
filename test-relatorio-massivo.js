// test-relatorio-massivo.js
require('dotenv').config();
const RelatorioService = require('./relatorio-service');

(async () => {
  const service = new RelatorioService(console);
  
  // Lista de todos os RCAs que você quer gerar relatório
  const RCAS = [121, 122, 123, 124, 125, 126, 127, 128, 10, 110];

  // 🚨 SEU ID DE TESTE NO BITRIX (Onde você receberá todos os PDFs)
  const MEU_ID_BITRIX = 1; 

  console.log(`🚀 Iniciando Geração Massiva para Teste.`);
  console.log(`📂 Serão gerados ${RCAS.length} relatórios.`);
  console.log(`📩 Todos serão enviados para o Bitrix ID: ${MEU_ID_BITRIX}\n`);
  
  for (const rca of RCAS) {
    console.log(`>>> Processando RCA ${rca}...`);
    
    // Chamamos o método passando seu ID como segundo argumento (Override)
    await service.processarRelatorioVendedor(rca, MEU_ID_BITRIX);
    
    // Pausa de 2 segundos entre envios para não sobrecarregar
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n🏁 Teste massivo finalizado. Verifique seu chat no Bitrix.');
  process.exit(0);
})();
// =============================================================================
// teste-etapa5.js
// Executa APENAS a Etapa 5 (Redistribuição) em modo DRY-RUN.
//
// ✅ Bitrix:  DESLIGADO  (skipBitrix = true)
// ✅ Oracle:  LIGADO     (atualiza PCCLIENT de verdade)
// ✅ Postgres: LIGADO    (move clientes da fila rotativa)
//
// Para rodar em modo COMPLETAMENTE seguro (sem gravar nada), use --dry:
//   node teste-etapa5.js --dry
//
// Para rodar de verdade (grava Oracle + Postgres, Bitrix off):
//   node teste-etapa5.js
// =============================================================================

require('dotenv').config();

// -----------------------------------------------------------------------
// Inicializa o Oracle Client (mesmo padrão do server.js)
// -----------------------------------------------------------------------
const oracledb = require('oracledb');
try {
    oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_LIB_DIR });
    console.log('✅ Oracle Client inicializado.');
} catch (e) {
    if (!e.message.includes('NJS-009')) console.warn('⚠️  Oracle Client:', e.message);
}

const MovimentacaoCarteiraService = require('./movimentacao-carteira-service');
const RotativoRepository           = require('./rotativo-repository');

// -----------------------------------------------------------------------
// FLAG: --dry roda sem gravar nada (só loga o que FARIA)
// -----------------------------------------------------------------------
const DRY_RUN = process.argv.includes('--dry');

// -----------------------------------------------------------------------
// Logger personalizado — imprime com timestamp e destaca avisos de segmento
// -----------------------------------------------------------------------
const logger = {
    log: (...args) => {
        const msg = args.join(' ');
        const ts  = new Date().toLocaleTimeString('pt-BR');

        // Destaque visual para as linhas de segmento
        if (msg.includes('Bloqueado: Segmento') || msg.includes('incompatível')) {
            console.log(`[${ts}] 🚫 SEGMENTO BLOQUEADO »`, msg);
        } else if (msg.includes('->') && msg.includes('RCA')) {
            console.log(`[${ts}] 🔄`, msg);
        } else {
            console.log(`[${ts}]`, msg);
        }
    },
    warn:  (...args) => console.warn( `[WARN]`, ...args),
    error: (...args) => console.error(`[ERR] `, ...args),
};

// -----------------------------------------------------------------------
// Se --dry, monkey-patch os métodos que gravam para só logar
// -----------------------------------------------------------------------
if (DRY_RUN) {
    console.log('\n⚠️  MODO DRY-RUN ATIVO — Nenhuma gravação será feita.\n');

    // Intercepta _atualizarRcaCliente
    const proto = MovimentacaoCarteiraService.prototype;

    const origRca  = proto._atualizarRcaCliente.bind;
    proto._atualizarRcaCliente = async function(codcli, novoRca) {
        logger.log(`[DRY] _atualizarRcaCliente: Cli ${codcli} → RCA ${novoRca} (NÃO gravado)`);
    };

    // Intercepta removerClienteRotativo
    const origRepo = RotativoRepository.prototype.removerClienteRotativo;
    RotativoRepository.prototype.removerClienteRotativo = async function(codcli) {
        logger.log(`[DRY] removerClienteRotativo: Cli ${codcli} (NÃO removido)`);
    };

    // Intercepta registrarRemanejamentoGrupo2
    const origReg = RotativoRepository.prototype.registrarRemanejamentoGrupo2;
    RotativoRepository.prototype.registrarRemanejamentoGrupo2 = async function(dados) {
        logger.log(`[DRY] registrarRemanejamento: Cli ${dados.codcli} RCA ${dados.rcaAnterior}→${dados.rcaNovo} (NÃO registrado)`);
    };

    // Intercepta salvarDadosRelatorio
    RotativoRepository.prototype.salvarDadosRelatorio = async function(dados) {
        logger.log(`[DRY] salvarDadosRelatorio: Cli ${dados.codcli} (NÃO salvo)`);
    };
}

// -----------------------------------------------------------------------
// Execução principal
// -----------------------------------------------------------------------
(async () => {
    try {
        console.log('='.repeat(65));
        console.log('  TESTE — ETAPA 5 (Redistribuição de Carteira Rotativa)');
        console.log(`  Modo: ${DRY_RUN ? 'DRY-RUN (só lê, não grava)' : 'REAL (Oracle + Postgres, SEM Bitrix)'}`);
        console.log('='.repeat(65));

        // 1. Carrega os parâmetros diretamente para exibir o mapa configurado
        const rotativoRepo = new RotativoRepository(logger);
        const params       = await rotativoRepo.obterParametrosSistema();

        if (!params) {
            console.error('❌ Não foi possível carregar parâmetros do banco. Verifique POSTGRES_CONN_STRING.');
            process.exit(1);
        }

        // 2. Exibe o mapa de segmentos que será usado
        console.log('\n📋 MAPA DE SEGMENTOS CONFIGURADO (rca_segmento_map):');
        const mapa = params.rca_segmento_map || {};

        if (Object.keys(mapa).length === 0) {
            console.log('   ⚠️  Nenhuma regra cadastrada — todos os RCAs aceitam qualquer segmento.');
        } else {
            const nomes = { 10: 'Revenda', 11: 'Serviços', 12: 'Corporativo/Industrial' };
            for (const [rca, codativs] of Object.entries(mapa)) {
                const labels = codativs.map(c => `${c}(${nomes[c] || '?'})`).join(', ');
                console.log(`   RCA ${rca.toString().padEnd(5)} → aceita CODATV1: ${labels}`);
            }
        }

        // 3. Exibe os vendedores elegíveis
        console.log('\n👥 VENDEDORES CONFIGURADOS:');
        console.log(`   RCAs da rotativa: ${(params.rcas_rotativa || []).join(', ') || '(não definido — usando fallback)'}`);

        // 4. Exibe a fila rotativa atual
        const filaAtual = await rotativoRepo.listarTodosRotativos();
        console.log(`\n📦 FILA ROTATIVA: ${filaAtual.length} cliente(s) aguardando redistribuição`);

        if (filaAtual.length === 0) {
            console.log('\n   Nenhum cliente na fila. Adicione clientes à tabela clientes_rotativos para testar.');
            console.log('   Dica: O processamento normal (processarTodosClientesElegiveis) popula a fila.');
            await rotativoRepo.pool.end();
            process.exit(0);
        }

        // Exibe os 10 primeiros da fila para contexto
        const amostra = filaAtual.slice(0, 10);
        console.log('\n   Primeiros da fila:');
        for (const c of amostra) {
            console.log(`   Cli ${String(c.codcli).padEnd(8)} | ${String(c.classificacao_atual || 'N/A').padEnd(10)} | ${c.dias_sem_compra}d sem compra`);
        }
        if (filaAtual.length > 10) console.log(`   ... e mais ${filaAtual.length - 10} cliente(s)`);

        // 5. Executa a Etapa 5
        console.log('\n' + '='.repeat(65));
        console.log('  INICIANDO ETAPA 5...');
        console.log('='.repeat(65) + '\n');

        const service = new MovimentacaoCarteiraService(logger);
        await service.executarEtapa5Redistribuicao({ skipBitrix: true });

        // 6. Resumo pós-execução
        const filaDepois = await rotativoRepo.listarTodosRotativos();
        const distribuidos = filaAtual.length - filaDepois.length;

        console.log('\n' + '='.repeat(65));
        console.log('  RESULTADO FINAL');
        console.log('='.repeat(65));
        console.log(`  Clientes na fila antes : ${filaAtual.length}`);
        console.log(`  Clientes na fila depois: ${filaDepois.length}`);
        console.log(`  Distribuídos           : ${DRY_RUN ? '0 (dry-run)' : distribuidos}`);
        console.log(`  Bitrix                 : NÃO acionado`);
        console.log('='.repeat(65));

        if (!DRY_RUN && distribuidos > 0) {
            console.log('\n✅ Redistribuição concluída! Verifique os logs acima para confirmar');
            console.log('   que clientes com CODATV1 incompatível foram bloqueados corretamente.');
        }

        await rotativoRepo.pool.end();
        process.exit(0);

    } catch (err) {
        console.error('\n❌ ERRO FATAL:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
# Inicialização Ativa em Apenas Classificação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar uma única vez `ativo: true` e `modo: CLASSIFICACAO`, preservando a configuração existente e todas as escolhas posteriores do usuário.

**Architecture:** O repositório aplicará uma atualização JSONB atômica protegida por um marcador versionado. A leitura dos parâmetros e a inicialização do agendador usarão essa garantia; o frontend apenas refletirá o estado persistido.

**Tech Stack:** Node.js 24, CommonJS, `node:test`, Express e PostgreSQL JSONB.

## Global Constraints

- Preservar `datetime`, `frequency`, filiais e todos os demais parâmetros.
- Não inventar data ou horário.
- Nunca reaplicar o default depois que o marcador existir.
- Uma falha de inicialização deve impedir o CRON principal de usar a configuração antiga.
- Não acessar Oracle, PostgreSQL real ou Bitrix nos testes.

---

### Task 1: Inicialização versionada no repositório

**Files:**
- Modify: `rotativo-repository.js:1134-1252`
- Modify: `tests/unit/rotativo-repository-config.test.js`

**Interfaces:**
- Produces: `aplicarInicializacaoClassificacaoAtivaV1()`.
- `obterParametrosSistema()` só devolve parâmetros depois da verificação.
- `salvarParametrosSistema()` mantém `_system_migrations`.

- [ ] **Step 1: Escrever os testes RED**

Adicionar casos que exijam:

```js
test('inicializa uma vez como classificacao ativa preservando o agendamento', async () => {
  const params = await repo.obterParametrosSistema();
  assert.equal(params.cron_config.ativo, true);
  assert.equal(params.cron_config.modo, 'CLASSIFICACAO');
  assert.equal(params.cron_config.datetime, '2026-08-02T23:32');
  assert.equal(params.cron_config.frequency, 'monthly');
});

test('marcador existente preserva a escolha posterior do usuario', async () => {
  const params = await repo.obterParametrosSistema();
  assert.equal(params.cron_config.ativo, false);
  assert.equal(params.cron_config.modo, 'MOVIMENTACAO');
});

test('salvamento preserva o marcador interno', async () => {
  await repo.salvarParametrosSistema(payload);
  assert.equal(extra._system_migrations.cron_classificacao_ativa_v1, true);
});
```

- [ ] **Step 2: Confirmar RED**

Run: `node --test tests/unit/rotativo-repository-config.test.js`

Expected: FAIL porque não existe inicialização nem preservação do marcador.

- [ ] **Step 3: Implementar a atualização mínima**

Criar uma instrução `UPDATE parametros_sistema` condicionada à ausência de
`_system_migrations.cron_classificacao_ativa_v1`. Usar `jsonb_set` para
mesclar `ativo`, `modo` e o marcador sem substituir o restante do JSON.

No upsert, mesclar `_system_migrations` existente com a revisão atual:

```sql
extra_config = jsonb_set(
  EXCLUDED.extra_config,
  '{_system_migrations}',
  COALESCE(parametros_sistema.extra_config -> '_system_migrations', '{}'::jsonb)
    || COALESCE(EXCLUDED.extra_config -> '_system_migrations', '{}'::jsonb),
  true
)
```

- [ ] **Step 4: Confirmar GREEN**

Run: `node --test tests/unit/rotativo-repository-config.test.js`

Expected: todos os casos de repositório passam.

### Task 2: Inicialização segura do agendador

**Files:**
- Modify: `server.js:3474-3591`
- Modify: `tests/unit/config-execution-mode-contract.test.js`

**Interfaces:**
- Consumes: `rotativoRepo.aplicarInicializacaoClassificacaoAtivaV1()`.
- Produces: inicialização assíncrona que só chama
  `configurarAgendamentoDinamico()` depois da garantia.

- [ ] **Step 1: Escrever contrato RED do startup**

```js
test('startup aguarda a inicializacao antes de configurar o cron principal', () => {
  assert.match(server, /await rotativoRepo\.aplicarInicializacaoClassificacaoAtivaV1\(\)/);
  assert.ok(
    server.indexOf('aplicarInicializacaoClassificacaoAtivaV1') <
      server.indexOf('await configurarAgendamentoDinamico()')
  );
});
```

- [ ] **Step 2: Confirmar RED**

Run: `node --test tests/unit/config-execution-mode-contract.test.js`

Expected: FAIL porque o startup ainda dispara o agendador diretamente.

- [ ] **Step 3: Implementar fail-safe**

Extrair uma função assíncrona de startup. Se a inicialização versionada
falhar, registrar o erro e não chamar `configurarAgendamentoDinamico()`.
Manter o agendamento técnico WinThor independente.

- [ ] **Step 4: Confirmar GREEN**

Run: `node --test tests/unit/config-execution-mode-contract.test.js`

Expected: contrato de ordem e falha segura passa.

### Task 3: Fallback e preview

**Files:**
- Modify: `public/js/config-parametros.js:578-588`
- Modify: `preview-fixtures.js`
- Modify: `tests/unit/config-execution-mode-contract.test.js`
- Modify: `tests/unit/preview-server.test.js`

**Interfaces:**
- O fallback sem `cron_config` define ativo + `CLASSIFICACAO`.
- O preview isolado devolve o mesmo estado inicial.

- [ ] **Step 1: Escrever testes RED**

```js
test('fallback sem cron inicia ativo em classificacao', () => {
  assert.match(script, /elAtivo\.checked\s*=\s*true/);
  assert.match(script, /setSelectedExecutionMode\('CLASSIFICACAO'\)/);
});

test('preview inicia ativo em classificacao', async () => {
  assert.equal(body.data.cron_config.ativo, true);
  assert.equal(body.data.cron_config.modo, 'CLASSIFICACAO');
});
```

- [ ] **Step 2: Confirmar RED**

Run: `node --test tests/unit/config-execution-mode-contract.test.js tests/unit/preview-server.test.js`

Expected: FAIL porque ambos ainda iniciam desligados.

- [ ] **Step 3: Aplicar os defaults mínimos**

Alterar somente o fallback sem configuração e a fixture isolada. Dados reais
continuam sobrescrevendo o estado visual normalmente.

- [ ] **Step 4: Confirmar GREEN e regressão**

Run:

```powershell
npm.cmd test
git diff --check
```

Expected: suíte completa sem falhas e diff sem erros.

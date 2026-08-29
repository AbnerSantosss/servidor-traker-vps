// Boot do painel: ligação de eventos e inicialização.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ---------------- Bind ----------------
async function init() {
  $('#btnNewProject').addEventListener('click', openNewModal);
  $('#npCancel').addEventListener('click', closeNewModal);
  $('#newProjectForm').addEventListener('submit', createProject);
  $('#modalNew').addEventListener('click', (e) => { if (e.target.id === 'modalNew') closeNewModal(); });

  $$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

  $('#btnLogout').addEventListener('click', logout);

  // Alternador de tema. O ícone mostra para onde o clique LEVA (lua = "ir para o
  // escuro"), que é a convenção que as pessoas já conhecem de outros produtos —
  // mostrar o estado atual inverte o significado e faz todo mundo clicar errado
  // uma vez.
  const btnTema = $('#btnTema');
  const pintarBotaoTema = () => {
    const claro = temaAtual() === 'claro';
    btnTema.innerHTML = `<i data-lucide="${claro ? 'moon' : 'sun'}" aria-hidden="true"></i>`;
    btnTema.title = claro ? 'Mudar para o tema escuro' : 'Mudar para o tema claro';
    btnTema.setAttribute('aria-label', btnTema.title);
    aplicarIcones(btnTema);
  };
  btnTema.addEventListener('click', () => {
    definirTema(temaAtual() === 'claro' ? 'escuro' : 'claro');
    pintarBotaoTema();
  });
  pintarBotaoTema();

  $('#btnApplyFilters').addEventListener('click', loadDashboard);
  $('#filterPeriod').addEventListener('change', loadDashboard);

  $('#metaForm').addEventListener('submit', saveMeta);
  $('#googleForm').addEventListener('submit', saveGoogle);
  $('#gRoute').addEventListener('change', toggleGoogleRoute);

  // Aba Instalação — Trilha A (navegador) e Trilha B (backend)
  $('#btnGenerateGTM').addEventListener('click', generateGTMScript);
  $('#btnCopyCollector').addEventListener('click', () => copyText($('#collectorBox').textContent, 'Código da tag copiado. Cole no GTM como HTML personalizado.'));
  $('#btnCopyUrl').addEventListener('click', () => copyText($('#whUrl').textContent, 'URL do webhook copiada.'));
  $('#btnCopySlug').addEventListener('click', () => copyText($('#pjSlug').textContent, 'Slug copiado.'));
  $('#btnCopyCollectUrl').addEventListener('click', () => copyText($('#pjCollectUrl').textContent, 'URL de coleta copiada.'));
  $('#btnCopyCurl').addEventListener('click', () => copyText($('#curlBox').textContent, 'Exemplo de curl copiado.'));
  $('#btnGoTestar').addEventListener('click', () => activateTab('testar'));
  $('#btnToggleToken').addEventListener('click', toggleIngestToken);
  $('#btnCopyToken').addEventListener('click', copyIngestToken);
  $('#btnReloadLogs').addEventListener('click', loadLogs);

  // Aba Meta — tabela de mapeamento
  $('#btnAddMapRow').addEventListener('click', adicionarLinhaMapa);
  $('#metaEventMap').addEventListener('input', marcarMapaJsonSujo);
  $('#btnApplyMapJson').addEventListener('click', aplicarMapaJson);
  $('#btnResetMapJson').addEventListener('click', descartarMapaJson);

  // Aba Testar — console
  $$('#modoSwitch .modo').forEach((b) => b.addEventListener('click', () => escolherModoTeste(b.dataset.modo)));
  $('#testPayload').addEventListener('input', validarPayloadNaTela);
  $('#btnFormatPayload').addEventListener('click', formatarPayload);
  $('#btnDisparar').addEventListener('click', aoClicarDisparar);
  $('#btnCopyPayloadEnviado').addEventListener('click', copiarPayloadEnviado);
  $('#btnEnviarIngest').addEventListener('click', (e) => enviarPeloIngest(e.currentTarget));

  // Aba Domínios
  $('#domainForm').addEventListener('submit', addDomain);
  $('#domHostname').addEventListener('input', updateDomainInstruction);
  $('#domMethod').addEventListener('change', updateDomainInstruction);

  // Aba Postback
  $('#postbackForm').addEventListener('submit', savePostback);
  $('#pbUrl').addEventListener('input', updatePostbackPreview);
  $('#pbMethod').addEventListener('change', updatePostbackPreview);

  // Aba Usuários
  $('#usrInviteForm').addEventListener('submit', convidarUsuario);
  $('#usrRole').addEventListener('change', atualizarDescricaoPapel);
  $('#btnReloadUsuarios').addEventListener('click', loadUsuarios);
  $('#btnCopyInvite').addEventListener('click', () => copyText($('#usrInviteUrl').textContent, 'Link do convite copiado!'));
  $('#btnCloseInvite').addEventListener('click', esconderLinkConvite);
  atualizarDescricaoPapel();

  // Só carrega o painel com sessão válida — sem sessão, api() já mandou para /login.
  if (!(await checkSession())) return;
  loadServerInfo();
  loadProjects();
}

document.addEventListener('DOMContentLoaded', init);

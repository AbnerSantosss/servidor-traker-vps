// Dicionário de erros — traduz o que os destinos (Meta, Google, Postback) e o transporte
// HTTP devolvem em `deliveries.last_error`/`response` para um texto que um gestor de
// tráfego entende às 23h tentando descobrir por que as conversões pararam.
//
// Módulo PURO: nenhuma chamada de rede, nenhuma consulta ao banco. `explicarErro` recebe
// os campos crus de UMA entrega e devolve sempre a mesma forma:
//   { chave, resumo, detalhe, acao, gravidade, catalogado }
//
// `chave` é a peça mais importante: é por ela que o painel agrupa falhas parecidas em vez
// de mostrar 200 linhas com o mesmo problema. `catalogado: false` é uma promessa de
// honestidade — quando o texto não bate com nenhuma regra conhecida, o módulo NUNCA
// inventa uma causa; ele devolve o erro cru (truncado e sem segredo) e diz isso com todas
// as letras.
//
// Reconhecimento por padrão (regex/inclusão de string) — não por classificação estatística
// nem heurística obscura — para o mesmo motivo que os adaptadores de entrada
// (src/ingest/adaptadores.js) funcionam assim: regra explícita é auditável, "por que isto
// caiu aqui" sempre tem resposta.
//
// ORDEM DE AVALIAÇÃO (estável, primeira regra que casar vence — documentada em REGRAS):
//   1. status internos (skipped_consent, skipped_unmapped) — não dependem de texto;
//   2. regras específicas do destino (meta.*, ga4.*, ads.*, postback.*), na ordem em que
//      aparecem no array — regra mais específica antes da mais genérica do mesmo destino
//      (ex.: meta.janela_7_dias antes de meta.parametro_invalido, que também é código 100);
//   3. regras de transporte (rede.*), independentes de destino;
//   4. fallback `dead` — esgotou tentativas sem bater em nada conhecido;
//   5. fallback `desconhecido` — catalogado:false.

// ---------------------------------------------------------------- texto e mascaramento

/**
 * Trunca e mascara um texto antes de ele sair numa resposta do painel.
 *
 * `last_error` guarda o que o destino devolveu — e o destino é um terceiro, então esse
 * texto pode conter fragmento de token vazado por engano numa mensagem de erro (já
 * aconteceu com provedores por aí). Mascarar ANTES de truncar importa: cortar um segredo
 * no meio ainda deixaria a outra metade visível.
 */
export function truncarEMascarar(texto, max = 500) {
  if (!texto) return '';
  let t = String(texto);
  t = t.replace(
    /\b(access_token|refresh_token|client_secret|api_secret|developer[-_]?token|bearer_token)\s*[=:]\s*[^&\s"']+/gi,
    '$1=***'
  );
  t = t.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Converte qualquer campo (string ou objeto) numa string pesquisável. Serializar objeto
// em vez de exigir string plana é o que permite reconhecer, por exemplo, um enum do
// Google Ads (`INVALID_CUSTOMER_ID`) que só existe aninhado dentro de `response.detalhe`.
function paraTexto(valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  if (typeof valor === 'string') return valor;
  try {
    return JSON.stringify(valor);
  } catch {
    return String(valor);
  }
}

// Junta toda fonte de texto que os módulos de destino produzem (ver src/destinations/*.js)
// numa string só, para casar um padrão uma vez em vez de repetir o teste campo a campo.
// Hoje o endpoint do painel só tem `last_error` guardado (o `response` completo não é
// persistido em `deliveries` para todo status) — o parâmetro `response` existe para quando
// o chamador tiver o objeto inteiro à mão (teste unitário, ou uso futuro direto no
// despachante, antes de a entrega ser gravada).
function textoCombinado({ last_error, response }) {
  return [
    last_error,
    response?.error,
    response?.detalhe,
    response?.error_user_msg,
    response?.error_user_title,
    response?.problemas,
  ]
    .map(paraTexto)
    .filter(Boolean)
    .join(' | ');
}

// ---------------------------------------------------------------- catálogo

const REGRAS = [
  // ---- status internos: não dependem de destino nem de texto ----
  {
    chave: 'consentimento.negado',
    destino: null,
    gravidade: 'informativa',
    test: (ctx) => ctx.status === 'skipped_consent',
    resumo: 'Evento não foi enviado porque o visitante negou consentimento',
    detalhe:
      'O visitante recusou o consentimento de armazenamento/análise (ad_storage e/ou analytics_storage). Isto é o comportamento CORRETO: enviar mesmo assim violaria a escolha dele.',
    acao: 'Nenhuma ação necessária — isto é esperado, não é uma falha.',
  },
  {
    chave: 'mapeamento.ausente',
    destino: null,
    gravidade: 'atencao',
    test: (ctx) => ctx.status === 'skipped_unmapped',
    resumo: 'Evento não foi enviado por falta de mapeamento ou destino desligado',
    detalhe:
      'Acontece quando o destino está desativado no projeto, o tipo de destino é desconhecido, ou o evento caiu fora de um filtro configurado (ex.: filtro de eventos do postback).',
    acao: 'Confira se o destino está ativado em Configurações do projeto e se o mapeamento/filtro de eventos inclui este evento.',
  },

  // ---- Meta Conversions API (destino "meta") ----
  {
    chave: 'meta.nao_configurado',
    destino: 'meta',
    gravidade: 'critica',
    test: (ctx) => /meta n[ãa]o configurado/i.test(ctx.texto),
    resumo: 'Meta não está configurado neste projeto',
    detalhe: 'Falta o Pixel ID ou o Access Token nas configurações deste destino — sem os dois, nenhum evento sai daqui.',
    acao: 'Preencha Pixel ID e Access Token em Configurações > Meta.',
  },
  {
    chave: 'meta.evento_incompleto',
    destino: 'meta',
    gravidade: 'critica',
    test: (ctx) => /evento incompleto para a meta/i.test(ctx.texto),
    resumo: 'Evento bloqueado antes do envio por falta de dado obrigatório',
    detalhe:
      'O próprio servidor recusou mandar o evento porque falta um campo que a Meta exige para este tipo de evento — o exemplo mais comum é Purchase sem valor, que a Meta contabilizaria com receita zero.',
    acao: 'Corrija a origem do evento (dataLayer do site ou payload do webhook) para sempre enviar os campos obrigatórios deste evento; reenviar sem corrigir repete o mesmo bloqueio.',
  },
  {
    chave: 'meta.token_invalido',
    destino: 'meta',
    gravidade: 'critica',
    test: (ctx) =>
      ctx.codigo === 190 ||
      /\(#190\)/.test(ctx.texto) ||
      /oauthexception/i.test(ctx.texto) ||
      /error validating access token/i.test(ctx.texto) ||
      /access token.*(expired|invalid|inv[aá]lido|expirou)/i.test(ctx.texto),
    resumo: 'Token de acesso da Meta inválido ou expirado',
    detalhe:
      'A Meta recusou o token usado para autenticar as chamadas — comum quando o token foi gerado como token de usuário (que expira) em vez de um token de sistema de longa duração, ou quando alguém o revogou no Gerenciador de Negócios.',
    acao: 'Gere um novo token de acesso (token de usuário do sistema, de longa duração) e salve em Configurações > Meta.',
  },
  {
    chave: 'meta.janela_7_dias',
    destino: 'meta',
    gravidade: 'atencao',
    test: (ctx) =>
      ctx.subcodigo === 2804019 ||
      ctx.codigo === 2804019 ||
      /event.?time.*(7\s*days?|1\s*hour)/i.test(ctx.texto) ||
      /outside.*7.?day/i.test(ctx.texto),
    resumo: 'Evento enviado fora da janela de 7 dias aceita pela Meta',
    detalhe:
      'A Meta só aceita eventos com event_time entre 7 dias no passado e 1 hora no futuro. Fora dessa janela, ela rejeita o evento inteiro — geralmente sinal de relógio dessincronizado na origem, ou de reenvio manual de um evento muito antigo.',
    acao: 'Confira o relógio do sistema que gera o event_time. Eventos antigos demais não têm conserto: descarte-os em vez de insistir no reenvio.',
  },
  {
    chave: 'meta.limite_taxa',
    destino: 'meta',
    gravidade: 'atencao',
    test: (ctx) =>
      ctx.codigo === 80004 ||
      ctx.http_status === 429 ||
      /\(#80004\)/.test(ctx.texto) ||
      /too many calls/i.test(ctx.texto) ||
      /rate limit/i.test(ctx.texto),
    resumo: 'Limite de chamadas do pixel da Meta foi atingido',
    detalhe:
      'A Meta limita quantas chamadas por hora um pixel pode receber. Picos de tráfego (campanha nova, lançamento) podem estourar esse teto temporariamente.',
    acao: 'Normalmente se resolve sozinho: o sistema tenta de novo com espaçamento crescente entre tentativas. Se persistir por muito tempo, verifique se não há envio duplicado do mesmo evento.',
  },
  {
    chave: 'meta.pixel_invalido',
    destino: 'meta',
    gravidade: 'critica',
    test: (ctx) =>
      ctx.codigo === 803 ||
      /\(#803\)/.test(ctx.texto) ||
      (/pixel/i.test(ctx.texto) && /(does not exist|no permission|sem permiss[ãa]o|n[ãa]o existe)/i.test(ctx.texto)),
    resumo: 'Pixel da Meta inexistente ou sem permissão',
    detalhe: 'O Pixel ID configurado não existe mais, ou o token em uso não tem acesso ao Gerenciador de Eventos deste pixel.',
    acao: 'Confira o Pixel ID em Configurações > Meta e garanta que o token pertence a alguém (ou a um usuário de sistema) com acesso a este pixel.',
  },
  {
    chave: 'meta.parametro_invalido',
    destino: 'meta',
    gravidade: 'atencao',
    test: (ctx) => ctx.codigo === 100 || /\(#100\)/.test(ctx.texto) || /invalid parameter/i.test(ctx.texto),
    // A Meta às vezes manda um texto pronto para humano (error_user_msg/error_user_title)
    // — quando existe, é a melhor explicação disponível, melhor que a nossa própria.
    resumo: (ctx) => {
      const extra = ctx.response?.error_user_title || ctx.response?.error_user_msg;
      return extra ? `Meta recusou o evento: ${extra}` : 'Meta recusou o evento por parâmetro inválido';
    },
    detalhe: (ctx) =>
      ctx.response?.error_user_msg ||
      'Algum campo do evento não está no formato que a Meta espera. É um erro de conteúdo do evento, não de configuração da conta.',
    acao: 'Confira o payload deste evento na aba de detalhes e compare com a documentação de campos da Conversions API.',
  },

  // ---- GA4 Measurement Protocol e Google Ads API (destino "google") ----
  {
    chave: 'ga4.nao_configurado',
    destino: 'google',
    gravidade: 'critica',
    test: (ctx) => /GA4 n[ãa]o configurado/i.test(ctx.texto),
    resumo: 'GA4 não está configurado neste projeto',
    detalhe: 'Falta o Measurement ID ou o API Secret nas configurações deste destino.',
    acao: 'Preencha Measurement ID e API Secret em Configurações > Google.',
  },
  {
    chave: 'ads.nao_configurado',
    destino: 'google',
    gravidade: 'critica',
    test: (ctx) => /Google Ads n[ãa]o configurado/i.test(ctx.texto),
    resumo: (ctx) => {
      const m = ctx.texto.match(/Google Ads n[ãa]o configurado:\s*faltam\s*([^|]+)/i);
      return m ? `Google Ads não está configurado: falta ${m[1].trim()}` : 'Google Ads não está totalmente configurado';
    },
    detalhe:
      'A rota Google Ads exige OAuth2 completo (client id, client secret, refresh token), developer token aprovado, customer_id da conta e o mapeamento de conversion action para este evento.',
    acao: 'Complete o que falta em Configurações > Google (rota Google Ads).',
  },
  {
    chave: 'ads.oauth_revogado',
    destino: 'google',
    gravidade: 'critica',
    test: (ctx) => /oauth falhou/i.test(ctx.texto) || /UNAUTHENTICATED/i.test(ctx.texto),
    resumo: 'Autorização OAuth do Google Ads falhou',
    detalhe:
      'O refresh token usado para gerar o access token não funcionou — geralmente porque foi revogado (troca de senha, remoção de acesso do app) ou expirou.',
    acao: 'Refaça a autorização OAuth2 do Google Ads em Configurações > Google e salve o novo refresh token.',
  },
  {
    chave: 'ads.permissao_negada',
    destino: 'google',
    gravidade: 'critica',
    test: (ctx) =>
      /PERMISSION_DENIED/i.test(ctx.texto) ||
      /developer token.*not.*(approv|allow)/i.test(ctx.texto) ||
      /n[ãa]o tem permiss[ãa]o/i.test(ctx.texto),
    resumo: 'Google Ads negou permissão para esta operação',
    detalhe:
      'O developer token pode não estar aprovado para o nível de acesso necessário, ou a conta autenticada não tem papel na conta de anúncios informada (customer_id).',
    acao: 'Confira em Configurações > Google se developer_token, customer_id e login_customer_id (quando a conta é gerenciada por um MCC) estão corretos, e se o token foi aprovado pelo Google.',
  },
  {
    chave: 'ads.customer_id_invalido',
    destino: 'google',
    gravidade: 'critica',
    test: (ctx) => /INVALID_CUSTOMER_ID/i.test(ctx.texto),
    resumo: 'Customer ID do Google Ads é inválido',
    detalhe: 'O customer_id configurado não corresponde a uma conta Google Ads válida acessível por este token.',
    acao: 'Confira o Customer ID (sem hífen) em Configurações > Google.',
  },
  {
    chave: 'ads.conversion_action_inexistente',
    destino: 'google',
    gravidade: 'critica',
    test: (ctx) =>
      /conversion.?action/i.test(ctx.texto) &&
      /(not.?found|does not exist|invalid|inexistente|inv[aá]lid)/i.test(ctx.texto),
    resumo: 'Conversion action do Google Ads não existe ou está incorreta',
    detalhe: 'O resource name da conversion action mapeada para este evento não corresponde a uma ação de conversão real na conta.',
    acao: 'Confira o mapeamento de conversion actions em Configurações > Google contra a lista real em Ferramentas > Conversões do Google Ads.',
  },
  {
    chave: 'ads.clique_fora_da_janela',
    destino: 'google',
    gravidade: 'atencao',
    test: (ctx) => /click.*(expired|too old|window)/i.test(ctx.texto) || /conversion.*window/i.test(ctx.texto),
    resumo: 'Clique referenciado está fora da janela de conversão do Google Ads',
    detalhe: 'O Google Ads só associa uma conversão a um clique (gclid/gbraid/wbraid) dentro de uma janela de tempo. Cliques antigos demais são rejeitados.',
    acao: 'Revise a latência entre o clique e o disparo deste evento; se o funil demora muito para converter, considere Enhanced Conversions (e-mail/telefone) como reforço.',
  },
  {
    chave: 'ga4.validation_message',
    destino: 'google',
    gravidade: 'atencao',
    test: (ctx) => /validationMessages/i.test(ctx.texto),
    resumo: 'GA4 aceitou o payload mas reportou aviso de validação',
    detalhe:
      'O endpoint de depuração do Measurement Protocol devolveu validationMessages apontando campos com problema. Em produção, o GA4 aceita o mesmo payload sem avisar nada.',
    acao: 'Rode este payload no endpoint de debug (ver docs/04) e corrija os campos apontados antes de confiar que o evento chegou certo.',
  },
  {
    chave: 'ga4.credencial_invalida',
    destino: 'google',
    gravidade: 'atencao',
    // Este é o caso mais traiçoeiro do GA4: ele NUNCA devolve erro para measurement_id ou
    // api_secret errados no endpoint de produção — só aceita (204) e descarta em silêncio.
    // Como o próprio sendGa4() não tem como detectar isso sozinho, esta regra reconhece o
    // texto de um diagnóstico manual (comparação com o GA4 em tempo real, ou checagem via
    // /debug/mp/collect) — não é (e não pode ser, hoje) detectado automaticamente pelo
    // worker. Ver nota em "decisões que merecem revisão humana" no relatório da fase.
    test: (ctx) =>
      /measurement.?id/i.test(ctx.texto) &&
      /api.?secret/i.test(ctx.texto) &&
      /(inv[aá]lid|n[ãa]o confer|n[ãa]o existe|em sil[êe]ncio)/i.test(ctx.texto),
    resumo: 'GA4 pode estar aceitando eventos com credencial errada, sem avisar',
    detalhe:
      'O Measurement Protocol responde 204 (sucesso) mesmo quando o measurement_id ou o api_secret estão errados — ele descarta o evento em silêncio, sem erro nenhum. Um "sucesso" nos logs não garante que o dado chegou ao GA4.',
    acao: 'Confira no GA4 (Relatórios em tempo real) se os eventos realmente aparecem. Se não aparecerem, revalide measurement_id e api_secret em Configurações > Google.',
  },

  // ---- Postback genérico ----
  {
    chave: 'postback.nao_configurado',
    destino: 'postback',
    gravidade: 'critica',
    test: (ctx) => /postback sem URL configurada/i.test(ctx.texto),
    resumo: 'Postback sem URL configurada',
    detalhe: 'Não há para onde enviar — falta a URL de destino nas configurações deste destino.',
    acao: 'Preencha a URL em Configurações > Postback.',
  },
  {
    chave: 'postback.rota_invalida',
    destino: 'postback',
    gravidade: 'critica',
    test: (ctx) => Number.isFinite(ctx.http_status) && ctx.http_status >= 400 && ctx.http_status < 500,
    resumo: (ctx) => `URL de postback recusou a requisição (HTTP ${ctx.http_status})`,
    detalhe:
      'O endpoint de destino respondeu com erro de cliente — normalmente URL errada, rota removida, ou autenticação exigida que não foi enviada.',
    acao: 'Confira a URL, o método (GET/POST) e o token de autenticação em Configurações > Postback com quem administra o endpoint de destino.',
  },
  {
    chave: 'postback.servidor_indisponivel',
    destino: 'postback',
    gravidade: 'atencao',
    test: (ctx) => Number.isFinite(ctx.http_status) && ctx.http_status >= 500,
    resumo: (ctx) => `Servidor de destino do postback está com problema (HTTP ${ctx.http_status})`,
    detalhe: 'O problema é do lado de quem recebe o postback, não deste servidor. O sistema tenta de novo automaticamente.',
    acao: 'Avise o responsável pelo endpoint de destino. Nenhuma ação é necessária aqui além de aguardar o reenvio automático.',
  },

  // ---- Transporte: mesmo texto de erro de rede, independente do destino ----
  {
    chave: 'rede.timeout',
    destino: null,
    gravidade: 'atencao',
    test: (ctx) =>
      /timeout/i.test(ctx.texto) || /ETIMEDOUT/i.test(ctx.texto) || /AbortError/i.test(ctx.texto) || /operation was aborted/i.test(ctx.texto),
    resumo: 'Tempo de resposta do destino esgotou (timeout)',
    detalhe: 'O destino não respondeu dentro do tempo limite da requisição — pode ser lentidão pontual do lado de lá ou instabilidade de rede.',
    acao: 'Normalmente se resolve sozinho no reenvio automático. Se persistir por muitas tentativas seguidas, verifique a saúde do serviço de destino.',
  },
  {
    chave: 'rede.dns',
    destino: null,
    gravidade: 'critica',
    test: (ctx) => /ENOTFOUND/i.test(ctx.texto) || /getaddrinfo/i.test(ctx.texto) || /EAI_AGAIN/i.test(ctx.texto),
    resumo: 'Não foi possível resolver o endereço do destino (falha de DNS)',
    detalhe: 'O domínio configurado para este destino não resolveu para nenhum IP — hostname errado, digitado errado, ou fora do ar.',
    acao: 'Confira se a URL/domínio configurado está correto e ativo.',
  },
  {
    chave: 'rede.conexao_recusada',
    destino: null,
    gravidade: 'critica',
    test: (ctx) => /ECONNREFUSED/i.test(ctx.texto),
    resumo: 'Conexão recusada pelo servidor de destino',
    detalhe: 'O host respondeu recusando a conexão — geralmente porta fechada ou serviço fora do ar.',
    acao: 'Confirme com o responsável pelo destino se o serviço está no ar e a porta está aberta.',
  },
  {
    chave: 'rede.tls',
    destino: null,
    gravidade: 'critica',
    test: (ctx) => /certificate/i.test(ctx.texto) || /\bTLS\b/i.test(ctx.texto) || /\bSSL\b/i.test(ctx.texto) || /self.?signed/i.test(ctx.texto),
    resumo: 'Falha de TLS/SSL na conexão com o destino',
    detalhe: 'O certificado do destino é inválido, expirou, ou não é confiável — a conexão segura não pôde ser estabelecida.',
    acao: 'Peça ao responsável pelo destino para renovar/corrigir o certificado TLS.',
  },
];

// ---------------------------------------------------------------- função pública

/**
 * Traduz os campos crus de uma entrega falha para uma explicação estável.
 * Sempre devolve a mesma forma — inclusive quando nada casa (`catalogado: false`).
 */
export function explicarErro({ destino, status, http_status, last_error, response } = {}) {
  const ctx = {
    destino: String(destino || '').trim().toLowerCase(),
    status: String(status || '').trim(),
    http_status: Number.isFinite(Number(http_status)) ? Number(http_status) : undefined,
    response: response || undefined,
  };
  ctx.texto = textoCombinado({ last_error, response });
  // Código e SUBCÓDIGO são coisas diferentes e precisam ser lidos separadamente.
  //
  // A primeira versão colapsava os dois num campo só, com o `code` na frente — e o efeito
  // era anular justamente a informação mais útil: a Meta manda `code: 100` para meia dúzia
  // de causas distintas, e é o `error_subcode` que diz qual delas (2804019 = event_time
  // fora da janela de 7 dias). Com os dois presentes, o `code` vencia e a regra do subcode
  // nunca podia disparar. Quem só tem um dos dois continua funcionando: `codigo` cai para
  // o subcódigo quando não há código, que é como alguns clientes montam o objeto.
  const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  ctx.subcodigo = numero(ctx.response?.error_subcode ?? ctx.response?.subcode);
  ctx.codigo = numero(ctx.response?.code) ?? ctx.subcodigo;

  for (const regra of REGRAS) {
    if (regra.destino && regra.destino !== ctx.destino) continue;
    if (!regra.test(ctx)) continue;
    return {
      chave: regra.chave,
      resumo: typeof regra.resumo === 'function' ? regra.resumo(ctx) : regra.resumo,
      detalhe: typeof regra.detalhe === 'function' ? regra.detalhe(ctx) : regra.detalhe,
      acao: typeof regra.acao === 'function' ? regra.acao(ctx) : regra.acao,
      gravidade: regra.gravidade,
      catalogado: true,
    };
  }

  // Esgotou as tentativas (dead) sem bater em nenhuma causa conhecida ainda merece uma
  // explicação melhor que "desconhecido": pelo menos sabemos que ninguém vai receber este
  // evento neste destino sem uma ação manual — é diferente de "erro nunca visto antes".
  if (ctx.status === 'dead') {
    return {
      chave: 'dead',
      resumo: 'Entrega esgotou as tentativas automáticas',
      detalhe:
        'O sistema tentou reenviar este evento várias vezes, com espaçamento crescente entre as tentativas, e desistiu. Sem uma ação manual, ele nunca chegará a este destino.',
      acao: 'Abra a entrega para ver a última resposta do destino, corrija a causa e use "Reenviar" — reenviar sem corrigir repete o mesmo erro.',
      gravidade: 'critica',
      catalogado: true,
    };
  }

  // Honestidade acima de adivinhação: nunca inventamos uma explicação para um erro que não
  // reconhecemos. O texto cru (truncado e sem segredo) é a melhor informação disponível —
  // e dizer isso com todas as letras evita que o operador confie numa causa que chutamos.
  return {
    chave: 'desconhecido',
    resumo: ctx.texto
      ? `Erro não catalogado: ${truncarEMascarar(ctx.texto, 200)}`
      : 'Erro não catalogado, sem mensagem registrada',
    detalhe: 'Este erro ainda não está no dicionário de causas conhecidas do painel.',
    acao: 'Abra a entrega e leia a resposta completa do destino. Se for um padrão novo e recorrente, vale cadastrar no dicionário de erros (src/destinations/erros-explicados.js).',
    gravidade: 'atencao',
    catalogado: false,
  };
}

// Console de testes: envia (ou apenas simula) um evento e devolve exatamente o que sai
// para a plataforma, com um diagnóstico de qualidade de correspondência.
//
// Existe porque a alternativa é o caminho às cegas: configurar o pixel, esperar uma
// venda real, abrir o Events Manager e torcer. Aqui o operador vê o payload montado
// antes de qualquer evento de produção depender dele.
import { Router } from 'express';
import { getProject } from '../db/repos/projects.js';
import { getIdentity } from '../db/repos/identities.js';
import { requireAuth } from './auth.js';
import { adaptarPayload } from '../ingest/adaptadores.js';
import { normalizeEvent } from '../ingest/normalize.js';
import { applyConsent } from '../ingest/consent.js';
import { buildMetaPayload, sendToMeta, validarEventoMeta } from '../destinations/meta.js';
import { buildGa4Payload, sendToGoogle } from '../destinations/google.js';
import { sendPostback } from '../destinations/postback.js';
import { env } from '../config/env.js';
import { log } from '../config/log.js';

export const testarRouter = Router();
testarRouter.use(requireAuth);

// ---------------------------------------------------------------- diagnóstico

/**
 * Peso de cada campo na qualidade de correspondência.
 * A ordem reflete o impacto real no match da Meta, não a facilidade de preencher:
 * e-mail e telefone identificam a pessoa; fbc identifica o CLIQUE que gerou a venda,
 * que é o que fecha a atribuição.
 */
// Agrupamento seguindo a página de boas práticas da Meta, que lista como parâmetros de
// ALTA qualidade: e-mail, endereço IP, nome completo e telefone. Os demais (cidade,
// estado, país, CEP) são secundários e valem combinados com um identificador forte.
const PESOS = {
  em: { peso: 'alto', valor: 10, rotulo: 'E-mail', dica: 'Envie o e-mail do comprador em user_data.email (o servidor hasheia).' },
  ph: { peso: 'alto', valor: 9, rotulo: 'Telefone', dica: 'Envie com DDD; o DDI 55 é acrescentado automaticamente.' },
  client_ip_address: { peso: 'alto', valor: 9, rotulo: 'IP do comprador', dica: 'Precisa ser o IP público do visitante. IP de rede interna (10.x, 172.16-31.x, 192.168.x) é descartado — quem monta o webhook deve ler o cabeçalho X-Forwarded-For.' },
  fn: { peso: 'alto', valor: 4, rotulo: 'Nome', dica: 'Nome e sobrenome juntos contam como sinal forte para a Meta.' },
  ln: { peso: 'alto', valor: 4, rotulo: 'Sobrenome', dica: 'Nome e sobrenome juntos contam como sinal forte para a Meta.' },
  client_user_agent: { peso: 'medio', valor: 6, rotulo: 'Navegador do comprador', dica: 'Obrigatório para evento de site. Envie o User-Agent capturado no checkout, não o da biblioteca HTTP.' },
  external_id: { peso: 'medio', valor: 6, rotulo: 'ID do cliente', dica: 'Identificador estável do cliente; o mesmo valor deve ir ao Pixel do navegador, com a mesma formatação.' },
  fbp: { peso: 'medio', valor: 5, rotulo: 'Cookie do navegador (fbp)', dica: 'Vem do cookie _fbp; o coletor o captura e a ponte de identidade o recupera.' },
  // O fbc pesa menos na CORRESPONDÊNCIA (que é o que esta nota mede) do que na
  // ATRIBUIÇÃO — é ele que liga a venda ao clique no anúncio. Ausente, o match
  // continua possível por e-mail e telefone, mas a origem da venda se perde.
  fbc: { peso: 'medio', valor: 5, rotulo: 'Clique do Facebook (fbc)', dica: 'Depende do fbclid capturado no navegador. Sem ele a venda casa com a pessoa, mas não com o anúncio que a gerou.' },
  zp: { peso: 'baixo', valor: 2, rotulo: 'CEP', dica: 'Secundário; ajuda combinado com e-mail ou telefone.' },
  ct: { peso: 'baixo', valor: 1, rotulo: 'Cidade', dica: 'Secundário.' },
  st: { peso: 'baixo', valor: 1, rotulo: 'Estado', dica: 'Secundário.' },
  country: { peso: 'baixo', valor: 1, rotulo: 'País', dica: 'Secundário.' },
  db: { peso: 'baixo', valor: 1, rotulo: 'Data de nascimento', dica: 'Opcional; envie em user_data.birth_date.' },
  ge: { peso: 'baixo', valor: 1, rotulo: 'Gênero', dica: 'Opcional; envie em user_data.gender.' },
};

function diagnosticar({ userData = {}, eventoInterno, payloadOriginal, config, modo }) {
  const presentes = [];
  const ausentes = [];
  let obtido = 0;
  let total = 0;

  for (const [campo, meta] of Object.entries(PESOS)) {
    total += meta.valor;
    const tem = userData[campo] !== undefined && userData[campo] !== null && userData[campo] !== '';
    if (tem) {
      obtido += meta.valor;
      presentes.push({ campo, rotulo: meta.rotulo, peso: meta.peso });
    } else {
      ausentes.push({ campo, rotulo: meta.rotulo, peso: meta.peso, dica: meta.dica });
    }
  }

  const alertas = [];

  // O adaptador descarta IP de rede privada; avisar é o que transforma um campo
  // faltando numa ação concreta do outro lado.
  const ipOriginal = payloadOriginal?.attribution?.ipAddress || payloadOriginal?.user_data?.client_ip_address;
  if (ipOriginal && !userData.client_ip_address) {
    alertas.push(`O IP "${ipOriginal}" foi descartado por ser de rede interna. Quem monta o webhook precisa ler o cabeçalho X-Forwarded-For em vez do IP da conexão.`);
  }

  if (!userData.fbc && !userData.fbp) {
    alertas.push('Nenhum identificador de navegador (fbc/fbp) no evento. A Meta consegue casar por e-mail e telefone, mas não amarra a venda ao clique no anúncio.');
  }

  const nomeMapeado = config?.eventMap?.[eventoInterno.event_name];
  if (!nomeMapeado) {
    alertas.push(`O evento "${eventoInterno.event_name}" não tem mapeamento configurado; ele seria enviado com esse nome mesmo. Configure na aba Meta.`);
  }

  if (eventoInterno._consentFlags?.stripPII) {
    alertas.push('O consentimento negado removeu os dados pessoais deste evento — comportamento esperado, mas explica a pontuação baixa.');
  }

  if (modo === 'real') {
    alertas.push('Modo REAL: este evento entra nos dados de produção da conta de anúncios.');
  }

  return {
    pontuacao: total ? Math.round((obtido / total) * 100) : 0,
    camposPresentes: presentes,
    camposAusentes: ausentes,
    alertas,
  };
}

// ---------------------------------------------------------------- modelos

function modelos(project) {
  const agora = new Date().toISOString();
  const sufixo = Math.random().toString(36).slice(2, 10);

  return [
    {
      id: 'compra-checkout',
      titulo: 'Compra aprovada — formato do seu checkout',
      descricao: 'Payload exatamente como o checkout do site dispara. O servidor detecta o formato e traduz sozinho.',
      formato: 'codigo-vencedor',
      payload: {
        lead: { name: 'Maria Souza Lima', email: 'maria.teste@exemplo.com', phone: '11987654321', taxId: '00000000191' },
        event: 'checkout.session.completed',
        method: 'pix',
        eventId: `teste-${sufixo}`,
        pricing: { couponCode: null, discountMinor: 0, originalAmountMinor: 9700 },
        currency: 'BRL',
        paymentId: `pagamento-${sufixo}`,
        sessionId: `sessao-${sufixo}`,
        occurredAt: agora,
        productIds: ['plan-4'],
        amountMinor: 9700,
        attribution: {
          utm: { source: 'facebook', medium: 'cpc', campaign: 'teste', content: null, term: null },
          cookies: { ga: 'GA1.1.123456789.1700000000', fbc: null, fbp: 'fb.1.1700000000000.1234567890', gclid: null, fbclid: null, gbraid: null, wbraid: null },
          ipAddress: '187.45.22.10',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0',
          eventSourceUrl: `https://${project.domain}/`,
        },
        paymentStatus: 'paid',
        customerReference: null,
      },
    },
    {
      id: 'pix-gerado',
      titulo: 'PIX gerado — ainda não é receita',
      descricao: 'Vira AddPaymentInfo na Meta, nunca Purchase. Serve para conferir que pagamento pendente não conta como venda.',
      formato: 'codigo-vencedor',
      payload: {
        lead: { name: 'Joao Pereira', email: 'joao.teste@exemplo.com', phone: '83981055357', taxId: '00000000272' },
        event: 'checkout.pix.generated',
        method: 'pix',
        eventId: `teste-pix-${sufixo}`,
        pricing: { couponCode: null, discountMinor: 0, originalAmountMinor: 9700 },
        currency: 'BRL',
        gatewayId: 'mercadopago',
        paymentId: `pix-${sufixo}`,
        sessionId: `sessao-pix-${sufixo}`,
        occurredAt: agora,
        productIds: ['plan-4'],
        amountMinor: 9700,
        attribution: {
          utm: { source: null, medium: null, campaign: null, content: null, term: null },
          cookies: { ga: null, fbc: null, fbp: 'fb.1.1700000000000.9988776655', gclid: null, fbclid: null },
          ipAddress: '201.17.88.4',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0',
          eventSourceUrl: `https://${project.domain}/`,
        },
        chargeExpiresAt: agora,
      },
    },
    {
      id: 'compra-canonica',
      titulo: 'Compra — formato canônico',
      descricao: 'O formato nativo do servidor. Use se o seu backend for montar o payload por conta própria.',
      formato: null,
      payload: {
        event_name: 'purchase',
        event_id: `teste-canonico-${sufixo}`,
        user_id: `cliente-${sufixo}`,
        action_source: 'website',
        page_location: `https://${project.domain}/obrigado`,
        user_data: { email: 'cliente.teste@exemplo.com', phone: '11987654321' },
        custom_data: { value: 97, currency: 'BRL', order_id: `pedido-${sufixo}`, payment_method: 'pix' },
      },
    },
    {
      id: 'lead',
      titulo: 'Lead — captura de contato',
      descricao: 'Evento de formulário preenchido.',
      formato: null,
      payload: {
        event_name: 'lead',
        event_id: `teste-lead-${sufixo}`,
        user_data: { email: 'lead.teste@exemplo.com', phone: '11912345678' },
        custom_data: { content_name: 'Formulário de contato' },
      },
    },
    {
      id: 'page-view',
      titulo: 'Page view — único evento que vem do navegador',
      descricao: 'Normalmente disparado pela tag do GTM; aqui serve para conferir o caminho.',
      formato: null,
      payload: {
        event_name: 'page_view',
        event_id: `teste-pv-${sufixo}`,
        page_location: `https://${project.domain}/`,
        user_data: { fbp: 'fb.1.1700000000000.1234567890' },
      },
    },
  ];
}

testarRouter.get('/:id/testar/modelos', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'projeto não encontrado' });
  res.json({ modelos: modelos(project) });
});

// ---------------------------------------------------------------- execução

const ENVIADORES = { meta: sendToMeta, google: sendToGoogle, postback: sendPostback };

testarRouter.post('/:id/testar', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'projeto não encontrado' });

  const modo = ['simular', 'teste', 'real'].includes(req.body?.modo) ? req.body.modo : 'simular';
  const destino = ['meta', 'google', 'postback'].includes(req.body?.destino) ? req.body.destino : 'meta';
  const payloadOriginal = req.body?.payload;

  if (!payloadOriginal || typeof payloadOriginal !== 'object') {
    return res.status(400).json({ error: 'payload deve ser um objeto JSON' });
  }

  const config = project.destinations[destino]?.config || {};

  // Modo teste sem test_event_code enviaria para a produção sem o operador perceber —
  // exatamente o oposto do que ele pediu ao escolher "teste".
  if (modo === 'teste' && destino === 'meta' && !config.testEventCode) {
    return res.status(400).json({
      error: 'para testar sem contaminar os dados, configure o Test Event Code na aba Meta (Events Manager → Testar eventos)',
    });
  }

  try {
    // Mesmo caminho de um evento real: adaptar, normalizar, enriquecer, consentir.
    const { corpo, formato } = adaptarPayload(payloadOriginal);
    const eventoInterno = normalizeEvent(corpo, {
      clientIp: undefined,
      userAgent: undefined,
      source: 'webhook',
      cookies: {},
    });

    if (eventoInterno.user_id) {
      const identidade = await getIdentity(project.id, eventoInterno.user_id);
      for (const [chave, valor] of Object.entries(identidade?.params || {})) {
        const atual = eventoInterno.user_data[chave];
        if (atual === undefined || atual === null || atual === '') eventoInterno.user_data[chave] = valor;
      }
    }

    const permitido = applyConsent(eventoInterno);

    // Monta o payload de saída sem enviar.
    let payloadEnviado = null;
    let urlDestino = null;
    const configDoTeste = modo === 'real' ? { ...config, testEventCode: '' } : config;

    if (destino === 'meta') {
      payloadEnviado = buildMetaPayload(permitido, project, { config: configDoTeste });
      urlDestino = `https://graph.facebook.com/${env.META_API_VERSION}/${config.pixelId || '<pixel_id>'}/events`;
    } else if (destino === 'google') {
      payloadEnviado = buildGa4Payload(permitido, config);
      urlDestino = 'https://www.google-analytics.com/mp/collect';
    } else {
      payloadEnviado = { url: config.url, method: config.method || 'GET', evento: permitido.event_name };
      urlDestino = config.url || '(postback sem URL configurada)';
    }

    const userDataMontado = destino === 'meta' ? payloadEnviado.data[0].user_data : {};
    const diagnostico = diagnosticar({
      userData: userDataMontado,
      eventoInterno: permitido,
      payloadOriginal,
      config,
      modo,
    });

    // Campo obrigatório faltando é mais grave que pontuação baixa: o evento é recusado
    // pela Meta, ou aceito e contabilizado errado. Vai no topo dos alertas.
    if (destino === 'meta') {
      const { bloqueios, avisos } = validarEventoMeta(payloadEnviado.data[0]);
      diagnostico.bloqueios = bloqueios;
      if (bloqueios.length) {
        diagnostico.alertas.unshift(`Este evento NÃO seria enviado: ${bloqueios.join('; ')}.`);
      }
      for (const aviso of avisos) diagnostico.alertas.push(`Seria enviado, porém com ${aviso}.`);
    }

    let enviado = false;
    let resposta = null;

    if (modo !== 'simular') {
      const projetoDoTeste = modo === 'real'
        ? { ...project, destinations: { ...project.destinations, [destino]: { ...project.destinations[destino], config: configDoTeste } } }
        : project;

      const resultado = await ENVIADORES[destino](permitido, projetoDoTeste);
      enviado = true;
      resposta = {
        ok: Boolean(resultado.ok),
        httpStatus: resultado.httpStatus || null,
        corpo: resultado.response ?? null,
      };
      log('info', 'evento de teste enviado pelo painel', {
        project: project.id, destino, modo, evento: permitido.event_name,
        ok: resultado.ok, por: req.user.email,
      });
    }

    res.json({
      modo,
      destino,
      formatoDetectado: formato,
      eventoInterno: {
        event_name: permitido.event_name,
        event_id: permitido.event_id,
        event_time: permitido.event_time,
        action_source: permitido.action_source,
        user_data: permitido.user_data,
        custom_data: permitido.custom_data,
      },
      urlDestino,
      payloadEnviado,
      enviado,
      resposta,
      diagnostico,
    });
  } catch (err) {
    log('error', 'falha no console de testes', { project: project.id, error: err.message });
    res.status(500).json({ error: `falha ao montar o evento: ${err.message}` });
  }
});

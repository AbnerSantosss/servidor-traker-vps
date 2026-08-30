// Geração dos scripts client-side servidos pelo próprio domínio first-party.
//
// Servir a tag a partir do domínio do cliente (e não de um CDN de terceiro) é parte da
// mitigação de bloqueadores: não existe regra de blocklist para o domínio dele. Como o
// script é gerado pelo servidor, também dá para evoluir a lógica de captura sem que o
// cliente precise republicar o container do GTM.
import { Router } from 'express';
import { getProject, getProjectBySlug } from '../db/repos/projects.js';
import { baseFirstParty } from '../tenancy/first-party.js';

export const scriptsRouter = Router();

// Host de quem PEDIU o script. Serve apenas de queda: quando o projeto ainda não tem
// domínio first-party verificado, o comportamento é o de antes.
function endpointBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

/**
 * Tag coletora (ponte de identidade).
 * Captura sticky: guarda em localStorage os identificadores de clique, porque eles
 * aparecem UMA vez (na URL de entrada) e precisam sobreviver às páginas seguintes e
 * ao corte de cookies do ITP.
 */
function renderCollector({ collectUrl }) {
  return `/* Servidor Traker — coletor de identidade (ponte user_id -> identificadores de marketing) */
(function () {
  var ENDPOINT = ${JSON.stringify(collectUrl)};
  /* DEBUG ligável sem republicar o container: ?trk_debug=1 na URL, ou window.trkDebug=true
     definido antes da tag. Era uma constante false, o que deixava a falha mais comum da
     instalação (não achar o user_id) absolutamente silenciosa. O nome é prefixado para não
     colidir com um ?debug=1 que o próprio site já use. */
  var DEBUG = false;
  try {
    DEBUG = window.trkDebug === true ||
            new URLSearchParams(location.search).get('trk_debug') === '1';
  } catch(e){}
  /* Chaves procuradas no dataLayer, em ordem. Precisam bater com a chave que o webhook
     de conversão envia — é o que amarra o clique no anúncio à venda. */
  var USER_ID_KEYS = ['user_id','userId','user_id_cp','customerReference','customer_reference',
                      'sessionId','session_id','checkout_session_id','taxId','cpf',
                      'player_id','playerId','jogador_codigo','jogador_id','codigo','customer_id','cliente_id'];

  function clean(v){ if(v==null) return ''; var s=String(v); if(s==='undefined'||s==='null') return ''; if(s.indexOf('{'+'{')===0) return ''; return s.trim(); }
  function getCookie(n){ var m=('; '+document.cookie).split('; '+n+'='); return m.length===2?m.pop().split(';').shift():''; }
  function getQuery(n){ try{ return new URLSearchParams(location.search).get(n)||''; }catch(e){ return ''; } }
  function lsGet(k){ try{ return localStorage.getItem(k)||''; }catch(e){ return ''; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

  /* Se o fbclid sumiu da URL, ainda dá para recuperá-lo de dentro do cookie _fbc
     (formato oficial: fb.1.TIMESTAMP.FBCLID). */
  function fbclidDeFbc(c){ if(!c) return ''; var p=String(c).split('.'); return p.length>=4?p.slice(3).join('.'):''; }
  function fbclidFromFbc(){ return fbclidDeFbc(getCookie('_fbc')); }

  /* fbclid DESTE clique. Só existe na URL de entrada, e enquanto estiver ali é ele que
     manda: esta tag roda ANTES do Pixel (prioridade alta no GTM, de propósito — ela
     precisa capturar o fbclid antes de qualquer navegação interna), e quem reescreve o
     cookie _fbc é o Pixel. No page_view de um clique novo, portanto, o _fbc do navegador
     ainda é o do clique ANTERIOR. */
  var FBCLID_DA_URL = getQuery('fbclid');
  /* base64url, sensível a maiúsculas. Valor fora do alfabeto não é fbclid de verdade e
     não vira fbc — melhor não ter do que fabricar um valor adulterado. */
  var FBCLID_OK = /^[A-Za-z0-9_-]+$/.test(FBCLID_DA_URL);

  /* Um fbc cujo fbclid não é o do clique atual é PIOR que nenhum: a Meta compara o fbc
     com o fbclid da URL do evento e marca "o servidor está enviando um valor fbclid
     modificado no parâmetro fbc". Batendo, preserva-se o cookie inteiro — o timestamp
     dele é o do clique de verdade. */
  function fbcCoerente(fbc){
    if(!FBCLID_OK) return fbc||'';
    if(fbc && fbclidDeFbc(fbc)===FBCLID_DA_URL) return fbc;
    return 'fb.1.'+Date.now()+'.'+FBCLID_DA_URL;
  }

  function sticky(store,val){ var v=clean(val); if(v){ lsSet(store,v); return v; } return lsGet(store); }

  /* Segunda fonte do user_id: variável global. Cobre o site renderizado no servidor que
     expõe o identificador em window mas não usa dataLayer. */
  function fromWindow(chaves){
    for(var i=0;i<chaves.length;i++){ try{ var v=clean(window[chaves[i]]); if(v) return v; }catch(e){} }
    return '';
  }

  function fromDataLayer(){
    var keys=[].slice.call(arguments), d=window.dataLayer||[];
    for(var i=d.length-1;i>=0;i--){
      var e=d[i]||{}, cp=e.custom_parameters||{};
      for(var j=0;j<keys.length;j++){
        var k=keys[j];
        if(clean(e[k])) return clean(e[k]);
        if(clean(cp[k])) return clean(cp[k]);
      }
    }
    return '';
  }

  var d = {};
  d.gclid       = sticky('tk_gclid', getQuery('gclid'));
  d.gbraid      = sticky('tk_gbraid', getQuery('gbraid'));
  d.wbraid      = sticky('tk_wbraid', getQuery('wbraid'));
  d.fbclid      = sticky('tk_fbclid', FBCLID_DA_URL || fbclidFromFbc());
  d.ttclid      = sticky('tk_ttclid', getQuery('ttclid'));
  d.clickid     = sticky('tk_clickid', getQuery('clickid'));
  d.tblci       = sticky('tk_tblci', getQuery('tblci'));
  d.fbp         = sticky('tk_fbp', getCookie('_fbp'));
  /* fbcCoerente e não o cookie cru: ver o comentário da função. É aqui que o tk_fbc
     deixa de poder discordar do tk_fbclid. */
  d.fbc         = sticky('tk_fbc', fbcCoerente(getCookie('_fbc')));
  d.ttp         = sticky('tk_ttp', getCookie('_ttp'));
  d.utm_source  = sticky('tk_utm_source', getQuery('utm_source'));
  d.utm_medium  = sticky('tk_utm_medium', getQuery('utm_medium'));
  d.utm_campaign= sticky('tk_utm_campaign', getQuery('utm_campaign'));
  d.utm_content = sticky('tk_utm_content', getQuery('utm_content'));
  d.utm_term    = sticky('tk_utm_term', getQuery('utm_term'));
  d.landing_page= sticky('tk_landing', location.href);

  /* Envia a ponte de identidade. Fica numa função porque há TRÊS gatilhos possíveis:
     a tentativa automática no load, e as duas saídas manuais (window.trkIdentify e a
     fila trkQueue) para o site que só descobre quem é o visitante depois. */
  function enviarIdentidade(uid){
    uid = clean(uid);
    if(!uid){
      if(DEBUG) console.warn('[traker] user_id vazio — nada a gravar');
      return false;
    }
    d.user_id = uid;

    var temIdentificador = d.gclid||d.gbraid||d.wbraid||d.fbclid||d.fbp||d.fbc||d.ttclid||d.ttp||d.clickid||d.tblci;
    if(!temIdentificador){
      /* Sem nenhum identificador de marketing não há o que atribuir: gravar só o user_id
         ocuparia linha no banco sem servir para nada. */
      if(DEBUG) console.warn('[traker] user_id encontrado ("'+uid+'"), mas nenhum identificador de marketing nesta sessão (sem fbclid/gclid/_fbp/_fbc/...). Nada a enviar — abra a página a partir de um anúncio, ou teste com ?fbclid=TESTE123 na URL.');
      return false;
    }

    /* Uma gravação por sessão por usuário — o dado é sticky, reenviar a cada página é desperdício. */
    var guard='tk_sent_'+uid;
    try{ if(sessionStorage.getItem(guard)) { if(DEBUG) console.log('[traker] identidade de "'+uid+'" já gravada nesta sessão'); return false; } }catch(e){}

    var body=JSON.stringify(d), enviado=false;
    /* text/plain evita preflight CORS (sendBeacon não permite header customizado mesmo).
       credentials/cookies vão junto de propósito: o servidor usa os _fbp/_fbc da própria
       requisição como fallback quando o JS não conseguiu lê-los. Requisição simples, então
       ela É entregue mesmo sem cabeçalho CORS na resposta — o CORS só esconderia a resposta,
       que aqui ninguém lê. */
    try{
      var blob=new Blob([body],{type:'text/plain'});
      enviado=!!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob));
    }catch(e){}
    if(!enviado){
      try{ fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'text/plain'},body:body,keepalive:true,credentials:'include'}); }catch(e){}
    }
    try{ sessionStorage.setItem(guard,'1'); }catch(e){}
    if(DEBUG) console.log('[traker] identidade enviada para '+ENDPOINT, d);
    return true;
  }

  /* Saída manual, para quando o site não expõe o identificador no dataLayer nem como
     global — o caso mais comum é login assíncrono e SPA. O site chama isto assim que
     souber quem é o visitante. Nenhum dataLayer envolvido. */
  window.trkIdentify = function (dados) {
    try {
      dados = dados || {};
      return enviarIdentidade(dados.user_id || dados.userId || dados.external_id);
    } catch(e){ return false; }
  };

  /* Mesma saída, para quem prefere não depender da ordem de carregamento das tags:
     window.trkQueue.push(['__identify__', { user_id: 'jogador-123' }]). */
  try {
    var fila = window.trkQueue;
    if (fila && fila.length) {
      for (var q=0; q<fila.length; q++) {
        if (fila[q] && fila[q][0] === '__identify__') window.trkIdentify(fila[q][1]);
      }
    }
  } catch(e){}

  /* Tentativa automática, em duas fontes: primeiro o dataLayer (o caminho natural em
     site com GTM), depois as variáveis globais (site renderizado no servidor que expõe
     o identificador em window). Não achando nenhuma das duas, o site PRECISA chamar
     window.trkIdentify(...) — e é isso que o DEBUG explica abaixo. */
  var uid = fromDataLayer.apply(null, USER_ID_KEYS) || fromWindow(USER_ID_KEYS);
  if(uid){ enviarIdentidade(uid); }
  else if(DEBUG){
    /* Diagnóstico útil de verdade: o problema quase sempre é que o site guarda o código
       do usuário sob um nome que não está na lista. Mostrar o que EXISTE resolve em um
       olhar — sem isso o operador fica adivinhando. */
    var vistas={};
    try{ (window.dataLayer||[]).forEach(function(e){ Object.keys(e||{}).forEach(function(k){ vistas[k]=e[k]; }); }); }catch(e){}
    console.warn('[traker] user_id NÃO encontrado — a ponte de identidade não será gravada.');
    console.warn('[traker] chaves procuradas:', USER_ID_KEYS.join(', '));
    console.warn('[traker] chaves presentes no dataLayer:', vistas);
    console.warn('[traker] identificadores de marketing já capturados:', d);
    console.warn('[traker] saídas: (a) o site dar dataLayer.push({user_id:"..."}), ou (b) chamar window.trkIdentify({user_id:"..."}) quando souber quem é o visitante.');
  }
})();`;
}

/**
 * Tag de captura de eventos: expõe window.trk(evento, opções).
 * O event_id gerado aqui é o MESMO que deve ir para o Pixel do navegador (eventID) —
 * é o que permite à Meta deduplicar navegador x servidor.
 */
function renderSnippet({ ingestUrl }) {
  return `/* Servidor Traker — tag de captura de eventos (GTM Web) */
(function () {
  var ENDPOINT = ${JSON.stringify(ingestUrl)};

  function getCookie(n){ var m=('; '+document.cookie).split('; '+n+'='); return m.length===2?m.pop().split(';').shift():''; }
  function ls(k){ try{ return localStorage.getItem(k)||''; }catch(e){ return ''; } }
  function getQuery(n){ try{ return new URLSearchParams(location.search).get(n)||''; }catch(e){ return ''; } }

  /* Coerência entre fbc e fbclid — mesma regra do coletor, repetida aqui porque as duas
     metades são IIFEs separadas (podem ser servidas em arquivos diferentes: /s/ e /t/).
     O fbc que carrega o fbclid de OUTRO clique faz a Meta acusar "valor fbclid
     modificado no parâmetro fbc"; na página de entrada isso é o caso normal, porque
     quem reescreve o cookie _fbc é o Pixel e ele roda depois desta tag. */
  function fbclidDeFbc(c){ if(!c) return ''; var p=String(c).split('.'); return p.length>=4?p.slice(3).join('.'):''; }
  var FBCLID_DA_URL = getQuery('fbclid');
  var FBCLID_OK = /^[A-Za-z0-9_-]+$/.test(FBCLID_DA_URL);
  function fbcCoerente(fbc){
    if(!FBCLID_OK) return fbc||'';
    if(fbc && fbclidDeFbc(fbc)===FBCLID_DA_URL) return fbc;
    return 'fb.1.'+Date.now()+'.'+FBCLID_DA_URL;
  }

  /* O cookie _gcl_aw guarda "GCL.TIMESTAMP.GCLID", não o gclid puro. */
  function gclidDoCookie(){ var c=getCookie('_gcl_aw'); if(!c) return ''; var p=c.split('.'); return p.length>=3?p.slice(2).join('.'):c; }
  /* O cookie _ga guarda "GA1.1.CLIENT_ID" — o GA4 precisa das duas últimas partes. */
  function gaClientId(){ var c=getCookie('_ga'); if(!c) return ''; var p=c.split('.'); return p.length>=4?p[2]+'.'+p[3]:''; }
  function uuid(){
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch(e){}
    return 'evt-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  /* event_id determinístico quando existe um ID de negócio: a mesma compra enviada
     pelo navegador e pelo webhook do backend gera o mesmo id e a Meta deduplica. */
  function eventId(nome, opts){
    if (opts.event_id) return String(opts.event_id);
    var cd = opts.custom_data || {};
    var negocio = cd.order_id || cd.transaction_id;
    return negocio ? (nome + '-' + negocio) : uuid();
  }

  window.trk = function (nome, opts) {
    opts = opts || {};
    var id = eventId(nome, opts);
    var payload = {
      event_name: nome,
      event_id: id,
      event_time: Math.floor(Date.now()/1000),
      page_location: location.href,
      page_path: location.pathname,
      page_title: document.title,
      page_referrer: document.referrer,
      user_id: opts.user_id,
      user_data: Object.assign({
        fbp: getCookie('_fbp') || ls('tk_fbp'),
        fbc: fbcCoerente(getCookie('_fbc') || ls('tk_fbc')),
        fbclid: FBCLID_DA_URL || ls('tk_fbclid'),
        gclid: gclidDoCookie() || ls('tk_gclid'),
        ga_client_id: gaClientId(),
        utm_source: ls('tk_utm_source'),
        utm_medium: ls('tk_utm_medium'),
        utm_campaign: ls('tk_utm_campaign')
      }, opts.user_data || {}),
      custom_data: opts.custom_data || {},
      consent_state: opts.consent_state || (window.trkConsent || {})
    };

    var body = JSON.stringify(payload);
    var enviado = false;
    try {
      var blob = new Blob([body], {type:'text/plain'});
      enviado = !!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob));
    } catch(e){}
    if (!enviado) {
      try { fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'text/plain'},body:body,keepalive:true,credentials:'include'}); } catch(e){}
    }
    /* Devolve o event_id para você repassar ao Pixel: fbq('track','Purchase',{...},{eventID:id}) */
    return id;
  };
})();`;
}

/**
 * Tag única — instalação "sem GTM" (F9/E9 do plano de melhorias).
 *
 * Empacota numa linha só as duas metades servidas separadas (`/s/` coletor + `/t/`
 * eventos) — o mesmo que a `/g/` faz para o GTM —, com três diferenças de propósito:
 *
 *   1. Descoberta de user_id SEM dataLayer. O coletor atual vasculha `window.dataLayer`
 *      (é assim que o GTM expõe variável). Aqui não há GTM, então a descoberta troca de
 *      fonte: primeiro tenta ler `window[chave]` diretamente (padrão comum de site que
 *      já expõe `window.user_id` num script inline do servidor), e o site pode sempre
 *      informar explicitamente via `window.trkIdentify(...)` — o caminho recomendado
 *      para SPA/login assíncrono, onde não existe global disponível no load.
 *   2. `page_view` automático, com dedupe por URL — o `/t/` de hoje não dispara nada
 *      sozinho, é o container do GTM que decide quando chamar `trk('page_view', ...)`.
 *      Sem container, a tag precisa saber fazer isso por conta própria.
 *   3. Fila de pré-carregamento. A tag é `async`: o HTML pode ter uma chamada a
 *      `trk(...)` ANTES do arquivo terminar de baixar. Não publicamos um stub próprio
 *      (mais um arquivo pra manter sincronizado com a API real) — em vez disso, quem
 *      instala é livre para acumular chamadas num array global e a tag drena esse
 *      array ao iniciar. Contrato do array (documentado também na tela de instalação):
 *
 *        window.trkQueue = window.trkQueue || [];
 *        window.trkQueue.push(['purchase', { custom_data: { value: 97 } }]);       // == trk('purchase', {...})
 *        window.trkQueue.push(['__identify__', { user_id: 'jogador-123' }]);        // == trkIdentify({...})
 *
 *      Cada item é um array de 2 posições: nome do evento (ou o marcador especial
 *      `__identify__`) e o argumento. `trkIdentify` normalmente roda tarde (só depois
 *      do login), então na prática o array serve mais para eventos de topo de funil
 *      (page_view customizado, clique em CTA) que podem acontecer antes do <script>
 *      terminar de carregar.
 *
 * Configuração, em ordem de precedência — ATRIBUTO DA TAG VENCE:
 *   1. `data-*` no próprio elemento `<script>` (lido via `document.currentScript`).
 *   2. `window.trkConfig = {...}`, definido ANTES da tag.
 *   3. Padrão embutido no código.
 *
 *   Por quê o atributo vence: o elemento `<script>` é a fonte de verdade de "como ESTA
 *   instalação foi configurada" — está ao lado do próprio snippet, visível em quem olha
 *   o HTML. `window.trkConfig` é um global que qualquer outro script carregado na
 *   página poderia sobrescrever sem saber que o traker existe; um atalho de "digitar no
 *   painel e colar" (data-*) não tem esse risco de colisão.
 *
 * Chaves aceitas (mesmos nomes nos dois lugares, `data-` em kebab-case):
 *   autoPageview / data-auto-pageview   — "0" desliga o page_view automático (padrão: ligado)
 *   debug / data-debug                  — "1" liga console.log de diagnóstico
 *   userIdKeys / data-user-id-keys      — lista (array ou "a,b,c") de globals extras a checar
 *   paramsGlobais / data-params-globais — objeto (ou JSON em string) mesclado no custom_data de TODO evento
 *   clickIds / data-click-ids           — lista de chaves extras a capturar da query string (camada aberta)
 */
function renderTagUnica({ ingestUrl, collectUrl }) {
  return `/* Servidor Traker — tag única (instalação sem GTM). Ver comentário de
   renderTagUnica em src/ingest/scripts.js para o contrato completo de configuração,
   fila de pré-carregamento (trkQueue) e precedência data-* vs window.trkConfig. */
(function () {
  var ENDPOINT_EVENTO = ${JSON.stringify(ingestUrl)};
  var ENDPOINT_COLETA = ${JSON.stringify(collectUrl)};

  // document.currentScript só é confiável se lido de forma SÍNCRONA aqui no topo —
  // depois de qualquer await/setTimeout/callback ele já voltou a ser null.
  var SCRIPT_TAG = document.currentScript;
  var CFG = window.trkConfig || {};

  function attr(nome){ try{ return SCRIPT_TAG ? SCRIPT_TAG.getAttribute(nome) : null; }catch(e){ return null; } }
  function cfgBool(dataAttr, chave, padrao){
    var a = attr(dataAttr);
    if (a !== null && a !== undefined && a !== '') return a !== '0' && a !== 'false';
    if (CFG[chave] !== undefined) return !!CFG[chave];
    return padrao;
  }
  function cfgLista(dataAttr, chave, padrao){
    var a = attr(dataAttr);
    if (a) { var partes=a.split(','), out=[]; for(var i=0;i<partes.length;i++){ var v=partes[i].trim(); if(v) out.push(v); } return out; }
    if (Object.prototype.toString.call(CFG[chave]) === '[object Array]') return CFG[chave];
    return padrao;
  }
  function cfgObjeto(dataAttr, chave, padrao){
    var a = attr(dataAttr);
    if (a) { try { var p = JSON.parse(a); if (p && typeof p === 'object') return p; } catch(e){} }
    if (CFG[chave] && typeof CFG[chave] === 'object') return CFG[chave];
    return padrao;
  }

  var AUTO_PAGEVIEW = cfgBool('data-auto-pageview', 'autoPageview', true);
  var DEBUG = cfgBool('data-debug', 'debug', false);
  /* Mesma lista padrão do coletor legado (/s/) — só muda a FONTE lida (window, não
     dataLayer). O site pode ampliar via userIdKeys/data-user-id-keys se usar outro nome. */
  var USER_ID_KEYS = cfgLista('data-user-id-keys', 'userIdKeys', [
    'user_id','userId','user_id_cp','customerReference','customer_reference',
    'sessionId','session_id','checkout_session_id','taxId','cpf',
    'player_id','playerId','jogador_codigo','jogador_id','codigo','customer_id','cliente_id'
  ]);
  var PARAMS_GLOBAIS = cfgObjeto('data-params-globais', 'paramsGlobais', {});
  /* Camada aberta (16.4 do plano): vazio por padrão de propósito — capturar da query
     string só o que o site pede explicitamente evita virar um coletor de PII acidental. */
  var CLICK_ID_KEYS = cfgLista('data-click-ids', 'clickIds', []);

  function clean(v){ if(v==null) return ''; var s=String(v); if(s==='undefined'||s==='null') return ''; if(s.indexOf('{'+'{')===0) return ''; return s.trim(); }
  function getCookie(n){ var m=('; '+document.cookie).split('; '+n+'='); return m.length===2?m.pop().split(';').shift():''; }
  function getQuery(n){ try{ return new URLSearchParams(location.search).get(n)||''; }catch(e){ return ''; } }
  function lsGet(k){ try{ return localStorage.getItem(k)||''; }catch(e){ return ''; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function sticky(store,val){ var v=clean(val); if(v){ lsSet(store,v); return v; } return lsGet(store); }
  /* Lê um valor exposto pelo próprio site como global (window.user_id, por exemplo) —
     substitui a varredura do dataLayer do coletor legado; ver comentário do topo. */
  function fromWindow(chaves){
    for(var i=0;i<chaves.length;i++){ var v=clean(window[chaves[i]]); if(v) return v; }
    return '';
  }
  /* Se o fbclid sumiu da URL, ainda dá para recuperá-lo de dentro do cookie _fbc
     (formato oficial: fb.1.TIMESTAMP.FBCLID). */
  function fbclidDeFbc(c){ if(!c) return ''; var p=String(c).split('.'); return p.length>=4?p.slice(3).join('.'):''; }
  function fbclidFromFbc(){ return fbclidDeFbc(getCookie('_fbc')); }

  /* fbclid DESTE clique (só existe na URL de entrada) e a regra que impede o fbc de
     carregar o fbclid de um clique anterior — é isso que a Meta detecta como "valor
     fbclid modificado no parâmetro fbc". Ver o comentário longo em renderCollector. */
  var FBCLID_DA_URL = getQuery('fbclid');
  var FBCLID_OK = /^[A-Za-z0-9_-]+$/.test(FBCLID_DA_URL);
  function fbcCoerente(fbc){
    if(!FBCLID_OK) return fbc||'';
    if(fbc && fbclidDeFbc(fbc)===FBCLID_DA_URL) return fbc;
    return 'fb.1.'+Date.now()+'.'+FBCLID_DA_URL;
  }
  /* O cookie _gcl_aw guarda "GCL.TIMESTAMP.GCLID", não o gclid puro. */
  function gclidDoCookie(){ var c=getCookie('_gcl_aw'); if(!c) return ''; var p=c.split('.'); return p.length>=3?p.slice(2).join('.'):c; }
  /* O cookie _ga guarda "GA1.1.CLIENT_ID" — o GA4 precisa das duas últimas partes. */
  function gaClientId(){ var c=getCookie('_ga'); if(!c) return ''; var p=c.split('.'); return p.length>=4?p[2]+'.'+p[3]:''; }
  function uuid(){
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch(e){}
    return 'evt-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  /* ---- captura sticky (mesma lógica do coletor /s/, sem depender de dataLayer) ---- */
  var d = {};
  d.gclid        = sticky('tk_gclid', getQuery('gclid'));
  d.gbraid       = sticky('tk_gbraid', getQuery('gbraid'));
  d.wbraid       = sticky('tk_wbraid', getQuery('wbraid'));
  d.fbclid       = sticky('tk_fbclid', FBCLID_DA_URL || fbclidFromFbc());
  d.ttclid       = sticky('tk_ttclid', getQuery('ttclid'));
  d.clickid      = sticky('tk_clickid', getQuery('clickid'));
  d.tblci        = sticky('tk_tblci', getQuery('tblci'));
  /* Camada explícita de outras plataformas (F9/E9, seção 16.4 do plano). */
  d.msclkid      = sticky('tk_msclkid', getQuery('msclkid'));
  d.twclid       = sticky('tk_twclid', getQuery('twclid'));
  d.li_fat_id    = sticky('tk_li_fat_id', getQuery('li_fat_id'));
  d.epik         = sticky('tk_epik', getQuery('epik'));
  d.sccid        = sticky('tk_sccid', getQuery('sccid'));
  d._scid        = sticky('tk__scid', getQuery('_scid') || getQuery('scid'));
  d.rdt_cid      = sticky('tk_rdt_cid', getQuery('rdt_cid'));
  d.irclickid    = sticky('tk_irclickid', getQuery('irclickid'));
  d.obclid       = sticky('tk_obclid', getQuery('obclid'));
  d.kwai_click_id= sticky('tk_kwai_click_id', getQuery('kwai_click_id'));
  d.fbp          = sticky('tk_fbp', getCookie('_fbp'));
  d.fbc          = sticky('tk_fbc', fbcCoerente(getCookie('_fbc')));
  d.ttp          = sticky('tk_ttp', getCookie('_ttp'));
  d.utm_source   = sticky('tk_utm_source', getQuery('utm_source'));
  d.utm_medium   = sticky('tk_utm_medium', getQuery('utm_medium'));
  d.utm_campaign = sticky('tk_utm_campaign', getQuery('utm_campaign'));
  d.utm_content  = sticky('tk_utm_content', getQuery('utm_content'));
  d.utm_term     = sticky('tk_utm_term', getQuery('utm_term'));
  d.landing_page = sticky('tk_landing', location.href);
  /* Camada aberta: só o que estiver na allowlist configurada — nunca varre a URL
     inteira (vira coleta de PII acidental). O servidor sanitiza de novo ao receber. */
  d.click_ids = {};
  for (var _ci=0; _ci<CLICK_ID_KEYS.length; _ci++){
    var _ck = CLICK_ID_KEYS[_ci];
    var _cv = sticky('tk_click_id_'+_ck, getQuery(_ck));
    if (_cv) d.click_ids[_ck] = _cv;
  }

  /* ---- ponte de identidade (substitui o /s/ + dataLayer) ---- */
  function enviarIdentidade(userId){
    var uid = clean(userId);
    if (!uid) return;

    var temExplicito = d.gclid||d.gbraid||d.wbraid||d.fbclid||d.fbp||d.fbc||d.ttclid||d.ttp||d.clickid||d.tblci||
      d.msclkid||d.twclid||d.li_fat_id||d.epik||d.sccid||d._scid||d.rdt_cid||d.irclickid||d.obclid||d.kwai_click_id;
    var temAberto = false;
    for (var k in d.click_ids) { if (d.click_ids.hasOwnProperty(k)) { temAberto = true; break; } }
    if (!temExplicito && !temAberto) return;

    /* Uma gravação por sessão por usuário — o dado é sticky, reenviar a cada página
       (ou a cada chamada de trkIdentify com o mesmo uid) é desperdício. */
    var guard = 'tk_sent_' + uid;
    try { if (sessionStorage.getItem(guard)) return; } catch(e){}

    var body = JSON.stringify(Object.assign({}, d, { user_id: uid })), enviado = false;
    try {
      var blob = new Blob([body], {type:'text/plain'});
      enviado = !!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT_COLETA, blob));
    } catch(e){}
    if (!enviado) {
      try { fetch(ENDPOINT_COLETA,{method:'POST',headers:{'Content-Type':'text/plain'},body:body,keepalive:true,credentials:'include'}); } catch(e){}
    }
    try { sessionStorage.setItem(guard,'1'); } catch(e){}
    if (DEBUG) console.log('[traker] identidade coletada', uid, d);
  }

  /* O site chama isto quando descobre quem é o visitante (login, checkout) — nenhum
     dataLayer envolvido, é uma chamada de função direta. */
  window.trkIdentify = function (dados) {
    try {
      dados = dados || {};
      enviarIdentidade(dados.user_id || dados.userId || dados.external_id);
    } catch(e){}
  };

  /* Tentativa automática: funciona só quando o site já expõe o identificador como
     global no momento em que a tag carrega (comum em página renderizada no servidor).
     Quando não expõe (SPA, login assíncrono), o site PRECISA chamar trkIdentify(). */
  try {
    var uidAuto = fromWindow(USER_ID_KEYS);
    if (uidAuto) enviarIdentidade(uidAuto);
    else if (DEBUG) console.warn('[traker] user_id ainda não disponível — chame window.trkIdentify(...) quando o site souber quem é o visitante');
  } catch(e){}

  /* ---- captura de eventos (substitui o /t/) ---- */
  /* event_id determinístico quando existe um ID de negócio: a mesma compra enviada
     pelo navegador e pelo webhook do backend gera o mesmo id e a Meta deduplica. */
  function eventId(nome, opts){
    if (opts.event_id) return String(opts.event_id);
    var cd = opts.custom_data || {};
    var negocio = cd.order_id || cd.transaction_id;
    return negocio ? (nome + '-' + negocio) : uuid();
  }

  window.trk = function (nome, opts) {
    opts = opts || {};
    var id = eventId(nome, opts);
    var userData = {
      fbp: getCookie('_fbp') || lsGet('tk_fbp'),
      fbc: fbcCoerente(getCookie('_fbc') || lsGet('tk_fbc')),
      fbclid: FBCLID_DA_URL || lsGet('tk_fbclid'),
      gclid: gclidDoCookie() || lsGet('tk_gclid'),
      ga_client_id: gaClientId(),
      gbraid: lsGet('tk_gbraid'),
      wbraid: lsGet('tk_wbraid'),
      ttclid: lsGet('tk_ttclid'),
      ttp: getCookie('_ttp') || lsGet('tk_ttp'),
      clickid: lsGet('tk_clickid'),
      tblci: lsGet('tk_tblci'),
      msclkid: lsGet('tk_msclkid'),
      twclid: lsGet('tk_twclid'),
      li_fat_id: lsGet('tk_li_fat_id'),
      epik: lsGet('tk_epik'),
      sccid: lsGet('tk_sccid'),
      _scid: lsGet('tk__scid'),
      rdt_cid: lsGet('tk_rdt_cid'),
      irclickid: lsGet('tk_irclickid'),
      obclid: lsGet('tk_obclid'),
      kwai_click_id: lsGet('tk_kwai_click_id'),
      utm_source: lsGet('tk_utm_source'),
      utm_medium: lsGet('tk_utm_medium'),
      utm_campaign: lsGet('tk_utm_campaign'),
      utm_content: lsGet('tk_utm_content'),
      utm_term: lsGet('tk_utm_term'),
      click_ids: Object.assign({}, d.click_ids, opts.click_ids || {})
    };
    var payload = {
      event_name: nome,
      event_id: id,
      event_time: Math.floor(Date.now()/1000),
      page_location: location.href,
      page_path: location.pathname,
      page_title: document.title,
      page_referrer: document.referrer,
      user_id: opts.user_id,
      user_data: Object.assign(userData, opts.user_data || {}),
      /* paramsGlobais primeiro: opts.custom_data do evento específico tem prioridade
         sobre o que foi configurado globalmente na tag. */
      custom_data: Object.assign({}, PARAMS_GLOBAIS, opts.custom_data || {}),
      consent_state: opts.consent_state || (window.trkConsent || {})
    };

    var body = JSON.stringify(payload);
    var enviado = false;
    try {
      var blob = new Blob([body], {type:'text/plain'});
      enviado = !!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT_EVENTO, blob));
    } catch(e){}
    if (!enviado) {
      try { fetch(ENDPOINT_EVENTO,{method:'POST',headers:{'Content-Type':'text/plain'},body:body,keepalive:true,credentials:'include'}); } catch(e){}
    }
    if (DEBUG) console.log('[traker] evento', nome, payload);
    /* Devolve o event_id para você repassar ao Pixel: fbq('track','Purchase',{...},{eventID:id}) */
    return id;
  };

  /* ---- page_view automático, com dedupe por URL ---- */
  var ultimaUrlPageView = '';
  function dispararPageView(){
    if (!AUTO_PAGEVIEW) return;
    var url = location.href;
    if (url === ultimaUrlPageView) return; // mesma URL não dispara duas vezes seguidas
    ultimaUrlPageView = url;
    window.trk('page_view', {});
  }
  if (AUTO_PAGEVIEW) {
    dispararPageView();
    /* SPA: pushState/replaceState não geram evento de navegador nenhum — é por isso
       que frameworks de rota tiveram que ser "escutados" via monkey-patch desde sempre
       (é o mesmo truque que o próprio gtag.js usa). popstate (botão voltar) já é nativo. */
    var _push = history.pushState, _replace = history.replaceState;
    history.pushState = function(){ var r = _push.apply(this, arguments); dispararPageView(); return r; };
    history.replaceState = function(){ var r = _replace.apply(this, arguments); dispararPageView(); return r; };
    window.addEventListener('popstate', dispararPageView);
  }

  /* ---- drena a fila de pré-carregamento (ver contrato no comentário do topo) ---- */
  try {
    var fila = window.trkQueue;
    if (fila && fila.length) {
      for (var fi=0; fi<fila.length; fi++){
        try {
          var item = fila[fi];
          if (item && item[0] === '__identify__') window.trkIdentify(item[1]);
          else window.trk(item[0], item[1]);
        } catch(e){}
      }
      fila.length = 0;
    }
  } catch(e){}
})();`;
}

/**
 * Tag única para GTM (rota /g/) — o que antes eram duas tags de "HTML personalizado".
 *
 * Difere de renderTagUnica (/w/) num ponto que não é cosmético: aqui a descoberta de
 * user_id continua sendo a varredura do `window.dataLayer` do coletor, porque é assim
 * que o GTM expõe variável. A /w/ lê `window[chave]`, que no GTM quase nunca existe.
 *
 * A ordem importa e é o motivo de existir um arquivo só em vez de dois <script src>:
 * o coletor grava os `tk_*` no localStorage e o snippet os lê ao montar o payload. Dois
 * arquivos externos injetados pelo GTM não têm ordem de execução garantida; um arquivo
 * tem — é execução síncrona de cima para baixo.
 */
function renderTagGtm({ ingestUrl, collectUrl }) {
  return `${renderCollector({ collectUrl })}

${renderSnippet({ ingestUrl })}

/* Servidor Traker — page_view. Único evento que nasce no navegador; o gatilho All Pages
   do GTM já garante uma execução por carregamento, então não há dedupe por URL aqui. */
(function () {
  try { window.trk('page_view', {}); } catch (e) {}
})();`;
}

async function serveScript(req, res, render, urlBuilder) {
  const { slug, projectId } = req.params;
  const project = slug ? await getProjectBySlug(slug) : await getProject(projectId);

  res.type('application/javascript; charset=utf-8');

  // CORS aberto, de propósito. Estas rotas servem JavaScript público — é o script que os
  // sites dos clientes carregam com <script src>, que já dispensa CORS. O cabeçalho existe
  // para o caso de alguém buscar o mesmo arquivo por `fetch`, que é o que a aba Instalação
  // do painel faz para exibir o código na tela; sem ele, o painel em host próprio recebe
  // erro de CORS e mostra um fallback em vez do script real.
  //
  // Não há segredo aqui e nenhuma credencial é aceita (`Allow-Credentials` fica de fora
  // deliberadamente): o conteúdo é o mesmo para qualquer visitante, e qualquer um já pode
  // obtê-lo com um GET direto.
  res.set('Access-Control-Allow-Origin', '*');
  if (!project || project.status !== 'active') {
    return res.status(404).send('/* projeto não encontrado */');
  }
  // Cache curto: permite evoluir a tag sem esperar expiração longa no navegador.
  res.set('Cache-Control', 'public, max-age=300');
  res.send(render({ ...(await urlBuilder(req, project)) }));
}

// O endereço que a tag vai chamar em produção.
//
// NÃO é o host da requisição: a aba Instalação do painel busca este script no host do
// serviço, e usar esse host escreveria na tag o endereço do serviço em vez do domínio do
// cliente. O cookie nasceria no domínio errado e o Pixel do cliente não conseguiria
// lê-lo — sem nenhum erro aparecer. Ver src/tenancy/first-party.js.
const urls = async (req, project) => {
  const base = await baseFirstParty(project.id, {
    preferido: req.get('host'),
    fallback: endpointBase(req),
  });
  return {
    collectUrl: `${base}/c/${project.slug}`,
    ingestUrl: `${base}/e/${project.slug}`,
  };
};

// Rotas curtas (as recomendadas na instalação).
scriptsRouter.get('/s/:slug.js', (req, res) => serveScript(req, res, renderCollector, urls));
scriptsRouter.get('/t/:slug.js', (req, res) => serveScript(req, res, renderSnippet, urls));

// Tag única do GTM: coletor + snippet + page_view num arquivo só (ordem garantida).
scriptsRouter.get('/g/:slug.js', (req, res) => serveScript(req, res, renderTagGtm, urls));

// Instalação sem GTM (F9/E9): tag única, rota nova — /s/ e /t/ continuam intactas (I-4).
scriptsRouter.get('/w/:slug.js', (req, res) => serveScript(req, res, renderTagUnica, urls));

// Aliases legados usados pelo painel atual.
scriptsRouter.get('/collector/:projectId.js', (req, res) => serveScript(req, res, renderCollector, urls));
scriptsRouter.get('/snippet/:projectId.js', (req, res) => serveScript(req, res, renderSnippet, urls));

export { renderCollector, renderSnippet, renderTagUnica, renderTagGtm };

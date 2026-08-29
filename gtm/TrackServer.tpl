___INFO___

{
  "type": "TAG",
  "id": "cvt_trackserver",
  "version": 1,
  "securityGroups": [],
  "displayName": "TrackServer — Enviar Evento",
  "brand": {
    "id": "trackserver",
    "displayName": "TrackServer"
  },
  "description": "Captura um evento e envia para o seu Servidor Proprio de Tracking (endpoint /e/{slug}), que reencaminha via Conversions API para Meta e Google. Ver wiki: arquitetura/GTM Web - Eventos e Data Layer.md.",
  "categories": ["ANALYTICS", "CONVERSIONS", "ADVERTISING"]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "ingestUrl",
    "displayName": "URL de Ingestao",
    "help": "URL completa do endpoint do seu projeto, ex.: https://traker.codigovencedor.com/e/x7k2v9ab",
    "valueValidators": [{ "type": "NON_EMPTY" }]
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "Nome do evento",
    "help": "Ex.: page_view, view_content, add_to_cart, lead, purchase. Aceita variavel {{Event}}.",
    "valueValidators": [{ "type": "NON_EMPTY" }]
  },
  {
    "type": "TEXT",
    "name": "eventId",
    "displayName": "event_id (opcional)",
    "help": "Deixe vazio para gerar automaticamente. Use o MESMO id do Pixel client-side para deduplicacao."
  },
  {
    "type": "SIMPLE_TABLE",
    "name": "customData",
    "displayName": "Custom data (valor, moeda, etc.)",
    "simpleTableColumns": [
      { "defaultValue": "", "displayName": "Chave", "name": "key", "type": "TEXT" },
      { "defaultValue": "", "displayName": "Valor", "name": "value", "type": "TEXT" }
    ]
  },
  {
    "type": "SIMPLE_TABLE",
    "name": "userData",
    "displayName": "User data (email, telefone, etc.)",
    "help": "PII e hasheada no servidor (SHA-256). fbp/fbc/gclid vao em texto plano.",
    "simpleTableColumns": [
      { "defaultValue": "", "displayName": "Chave", "name": "key", "type": "TEXT" },
      { "defaultValue": "", "displayName": "Valor", "name": "value", "type": "TEXT" }
    ]
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const sendPixel = require('sendPixel');
const sendHttpRequest = require('sendHttpRequest');
const getCookieValues = require('getCookieValues');
const getUrl = require('getUrl');
const getReferrerUrl = require('getReferrerUrl');
const getTimestampMillis = require('getTimestampMillis');
const generateRandom = require('generateRandom');
const makeInteger = require('makeInteger');
const JSON = require('JSON');

function firstCookie(name) {
  const vals = getCookieValues(name);
  return (vals && vals.length) ? vals[0] : undefined;
}

function tableToObject(tbl) {
  const obj = {};
  if (tbl) {
    for (let i = 0; i < tbl.length; i++) {
      if (tbl[i].key) obj[tbl[i].key] = tbl[i].value;
    }
  }
  return obj;
}

const eventId = data.eventId && data.eventId !== ''
  ? data.eventId
  : getTimestampMillis() + '.' + generateRandom(100000, 999999);

const userData = tableToObject(data.userData);
userData.fbp = userData.fbp || firstCookie('_fbp');
userData.fbc = userData.fbc || firstCookie('_fbc');
userData.gclid = userData.gclid || firstCookie('_gcl_aw');

const payload = {
  event_name: data.eventName,
  event_id: eventId,
  event_time: makeInteger(getTimestampMillis() / 1000),
  page_location: getUrl(),
  page_referrer: getReferrerUrl(),
  user_data: userData,
  custom_data: tableToObject(data.customData),
  consent_state: {}
};

const body = JSON.stringify(payload);

sendHttpRequest(data.ingestUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 3000
}, body).then((result) => {
  if (result.statusCode >= 200 && result.statusCode < 300) {
    data.gtmOnSuccess();
  } else {
    data.gtmOnFailure();
  }
}).catch(() => {
  // fallback via pixel GET caso sendHttpRequest nao esteja disponivel
  sendPixel(data.ingestUrl, data.gtmOnSuccess, data.gtmOnFailure);
});


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": { "publicId": "send_http", "versionId": "1" },
      "param": [
        {
          "key": "allowedUrls",
          "value": {
            "type": 1,
            "string": "specific",
            "listItem": [
              { "type": 1, "string": "https://*/*" }
            ]
          }
        }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "get_cookies", "versionId": "1" },
      "param": [
        {
          "key": "cookieAccess",
          "value": { "type": 1, "string": "specific" }
        },
        {
          "key": "cookieNames",
          "value": {
            "type": 2,
            "listItem": [
              { "type": 1, "string": "_fbp" },
              { "type": 1, "string": "_fbc" },
              { "type": 1, "string": "_gcl_aw" }
            ]
          }
        }
      ]
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "get_url", "versionId": "1" },
      "param": [{ "key": "urlParts", "value": { "type": 1, "string": "any" } }]
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "get_referrer", "versionId": "1" },
      "param": [{ "key": "urlParts", "value": { "type": 1, "string": "any" } }]
    },
    "isRequired": true
  }
]


___TESTS___

scenarios: []


___NOTES___

Custom Template para o GTM Web do "Servidor Proprio de Tracking".
Importe em: GTM Web > Templates > Modelos de tag > Novo > (menu) Importar > selecione este arquivo.
Depois crie uma tag desse template, preencha a URL de ingestao (do painel) e o nome do evento,
e associe a um acionador (ex.: All Pages para page_view, ou evento de conversao para purchase).
Preview Mode: use o Preview do GTM Web para confirmar que a tag dispara e retorna sucesso;
no painel do TrackServer, a aba Logs deve mostrar o evento recebido.

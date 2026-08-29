// Consent Mode v2 aplicado no servidor — fonte única da regra, auditável.
// A tag do navegador apenas TRANSPORTA o estado de consentimento; quem decide o que
// sai do payload é o servidor. Ver wiki: integracoes/Meta Conversions API.md
//
//   ad_user_data = denied       -> remove PII hasheável (em, ph, fn, ln, external_id, endereço)
//   ad_personalization = denied -> mantém o evento, sinaliza Limited Data Use (LDU)
//
// Sobre consentimento AUSENTE: por padrão o evento segue com a PII, porque muitos
// sites ainda não enviam consent_state e cortar tudo silenciosamente inutilizaria o
// tracking sem o operador perceber. Ligando STRICT_CONSENT=true, a ausência de sinal
// passa a ser tratada como negação — postura mais defensável sob LGPD/GDPR, e a
// recomendada quando o site já tem CMP configurado. A escolha é consciente e fica
// visível no log pelo flag consentMissing.

import { env } from '../config/env.js';

const PII_FIELDS = ['email', 'phone', 'first_name', 'last_name', 'external_id', 'city', 'state', 'zip', 'country'];

export function applyConsent(event, { strictConsent = env.STRICT_CONSENT } = {}) {
  const consent = event.consent_state || {};
  const adUserData = consent.ad_user_data;
  const adPersonalization = consent.ad_personalization;

  const flags = {
    stripPII: adUserData === 'denied' || (strictConsent && adUserData === undefined),
    limitedDataUse: adPersonalization === 'denied',
    consentMissing: adUserData === undefined,
  };

  const out = structuredClone(event);
  if (flags.stripPII) {
    for (const field of PII_FIELDS) delete out.user_data[field];
  }
  out._consentFlags = flags;
  return out;
}

// Alguns destinos (postback para sistemas internos do cliente) não estão sujeitos às
// mesmas regras de plataforma de anúncio; ainda assim respeitamos ad_storage = denied.
export function isBlockedByConsent(event) {
  return event.consent_state?.ad_storage === 'denied' && event.consent_state?.analytics_storage === 'denied';
}

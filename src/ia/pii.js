// Hasheamento de PII para tudo que envolve IA.
//
// Mora num módulo próprio porque tem DOIS consumidores em pontas opostas do sistema: a
// ingestão (que precisa guardar o corpo bruto de um webhook sem gravar e-mail em claro no
// banco) e o worker (que precisa mandar esse corpo para um modelo de terceiro). Deixá-lo
// dentro do dispatcher obrigaria a ingestão a importar a fila de entregas inteira — e
// acoplar o caminho crítico do webhook ao código que fala com Meta e Google seria trocar
// um problema de organização por um risco real.
//
// Não confundir com o `mascararAmostra` de src/db/repos/webhooks.js: lá o dado só serve
// de diagnóstico e vira "[oculto]"; aqui o hash PRECISA sobreviver, porque é ele que vira
// `user_data.email`/`phone` no evento final — a Meta casa hash com hash. Mandar e-mail em
// claro para um terceiro a cada evento trocaria uma escolha de arquitetura por um problema
// de LGPD. Ver Plano-Melhorias-Painel.md, seções 3.4 e 7.4.
import { hashEmail, hashName, hashPhone } from '../config/crypto.js';

const CHAVE_EMAIL_RE = /email|mail/i;
const CHAVE_TELEFONE_RE = /telefone|phone|celular|whatsapp|^tel$/i;
const CHAVE_NOME_RE = /nome|name/i;

function hashearPiiRecursivo(valor, chaveNormalizada) {
  if (Array.isArray(valor)) return valor.map((v) => hashearPiiRecursivo(v, chaveNormalizada));
  if (valor && typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = hashearPiiRecursivo(v, String(k).toLowerCase());
    return out;
  }
  if (typeof valor === 'string' && valor.trim()) {
    if (CHAVE_EMAIL_RE.test(chaveNormalizada)) return hashEmail(valor) || valor;
    if (CHAVE_TELEFONE_RE.test(chaveNormalizada)) return hashPhone(valor) || valor;
    if (CHAVE_NOME_RE.test(chaveNormalizada)) return hashName(valor) || valor;
  }
  return valor;
}

/**
 * Hasheia recursivamente e-mail, telefone e nome de um payload arbitrário, reaproveitando
 * as MESMAS funções de hash que a Meta CAPI usa no resto do produto — um único ponto de
 * verdade para "como se hasheia PII neste produto".
 *
 * É idempotente na prática: um hash SHA-256 já aplicado não casa com formato de e-mail nem
 * de telefone, então rodar duas vezes não estraga o valor. Isso importa porque a ingestão
 * hasheia ao guardar e o worker hasheia de novo antes de montar o prompt.
 */
export function hashearPiiParaPrompt(payload) {
  return hashearPiiRecursivo(payload, '');
}

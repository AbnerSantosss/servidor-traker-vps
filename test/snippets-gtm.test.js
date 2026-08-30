// Os blocos que o painel manda colar no GTM têm de ser HTML válido.
//
// O campo "HTML personalizado" do GTM valida o conteúdo como HTML: JavaScript solto ali
// é recusado com "HTML inválido" e a área de trabalho **inteira** para de publicar — não
// só a tag nova. Foi o que aconteceu em 19/08/2026: o painel exibia o corpo do arquivo
// `.js` (buscado no servidor) e mandava colar num campo de HTML.
//
// Teste estático porque é onde o defeito vive: o bloco é montado por uma função de
// browser, sem DOM aqui. O que se protege é a forma do que vai para a tela.
import './setup-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAMINHO = join(RAIZ, 'public', 'admin', 'instalacao.js');

// O repositório de deploy da API não carrega `public/` — o painel é servido pelo repo do
// app (ver docs/14-repos-azure.md). Sem o arquivo, pular é honesto; falhar seria ruído
// vermelho em todo build do backend. Mesmo padrão de design-tokens.test.js.
const temPainel = existsSync(CAMINHO);
const fonte = temPainel ? readFileSync(CAMINHO, 'utf8') : '';

// Corpo da função, do cabeçalho até a chave que fecha na coluna 0.
function corpoDaFuncao(nome) {
  const i = fonte.indexOf(`function ${nome}(`);
  assert.notEqual(i, -1, `função ${nome} não encontrada em public/admin/instalacao.js`);
  const fim = fonte.indexOf('\n}', i);
  return fonte.slice(i, fim);
}

// ATUALIZADO no merge com a linha de desenvolvimento (30/08/2026). Este arquivo nasceu
// na linha de produção, quando a instalação pedia DUAS tags no GTM: a Tag 1 (identidade,
// `scriptColetor`) e a Tag 2 (`scriptTag`). Em 25-26/08 o painel passou a instalar
// EXATAMENTE UMA tag (`scriptGtm`, a rota /g/, que junta coletor + snippet + page_view),
// e as duas asserções por nome de tag passaram a testar um modelo que não existe mais.
//
// A regra que o arquivo protege continua igual e continua valendo: o que vai para o campo
// "HTML personalizado" tem de ser uma tag <script>, nunca JavaScript solto. Só o número de
// blocos mudou. Trocar as duas entradas por uma é a tradução da mesma regra para a tag
// única — não um afrouxamento.
describe('blocos de código para o GTM', { skip: temPainel ? false : 'public/ ausente (repo da API)' }, () => {
  test('a tag única do GTM sai como <script src>, não como corpo de JavaScript', () => {
    const corpo = corpoDaFuncao('generateGTMScript');
    assert.match(corpo, /<script src="\$\{urls\.scriptGtm\}">/);
  });

  test('a Tag 1 não busca o conteúdo do .js para jogar no bloco', () => {
    // A regressão a evitar: voltar a exibir `await res.text()` num campo de HTML.
    const corpo = corpoDaFuncao('generateGTMScript');
    assert.doesNotMatch(corpo, /\.text\(\)/, 'o corpo do arquivo .js não pode ir para o bloco do GTM');
  });

  // Os três blocos que a tela manda colar no GTM ou no HTML do site. Os outros blocos de
  // cbEscrever são exemplos de outra natureza (chamada JavaScript, comando curl) e não
  // entram nesta regra — daí a lista explícita em vez de uma varredura cega.
  const BLOCOS_HTML = [
    ['tag única do GTM', '<script src="${urls.scriptGtm}">'],
    ['tag única, sem GTM', '<script async src="${urls.scriptUnica}"'],
  ];

  for (const [nome, forma] of BLOCOS_HTML) {
    test(`o bloco da ${nome} é uma tag <script>, não JavaScript solto`, () => {
      assert.ok(fonte.includes(forma), `esperava o bloco montado como ${forma}`);
    });
  }
});

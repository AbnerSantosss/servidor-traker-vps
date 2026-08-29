// Contraste dos tokens de cor.
//
// Por que isto é teste e não revisão manual: contraste é a única parte do design
// que tem resposta certa e verificável, e é justamente a que quebra em silêncio.
// Este projeto já teve um par de cinzas que reprovava em 4.5:1 e a consequência
// relatada foi "não dá para ler" — sem ninguém saber apontar qual cor era.
//
// A referência é a WCAG 2.1 AA: 4.5:1 para texto normal, 3:1 para texto grande
// (≥ 24px, ou ≥ 18.66px em negrito) e para elementos de interface (bordas de
// campo, ícones que carregam significado).
import './setup-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAMINHO_CSS = join(RAIZ, 'public', 'app.css');

// O repositório de deploy da API não carrega `public/` — o painel é servido pelo
// repo do app (ver docs/14-repos-azure.md). Sem o CSS estes testes não têm objeto:
// pular é honesto, falhar seria ruído vermelho em todo build do backend. Mesmo
// padrão dos testes de página em integracao.test.js.
const TEM_PAINEL = existsSync(CAMINHO_CSS);
const CSS = TEM_PAINEL ? readFileSync(CAMINHO_CSS, 'utf8') : '';
const SEM_PAINEL = !TEM_PAINEL && 'painel servido pelo repo do app';

/** Extrai os tokens de cor literal de um bloco de tema. */
function lerBloco(regex, nomeAmigavel) {
  if (!TEM_PAINEL) return {};
  const bloco = CSS.match(regex);
  assert.ok(bloco, `bloco ${nomeAmigavel} não encontrado em app.css`);
  const tokens = {};
  for (const linha of bloco[1].split('\n')) {
    // Aceita várias declarações na mesma linha (a paleta de dados vem assim).
    for (const [, nome, valor] of linha.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const v = valor.trim();
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) tokens[nome] = v;
    }
  }
  return tokens;
}

/**
 * Os dois temas, cada um como a paleta que de fato chega à tela.
 *
 * O tema claro redefine só o que muda de valor e herda o resto do `:root` — por isso
 * ele é medido MESCLADO sobre o escuro, nessa ordem. Medir o bloco claro isolado
 * testaria uma paleta que não existe em lugar nenhum, e deixaria passar justamente o
 * token que alguém esqueceu de redefinir.
 */
const TEMA_ESCURO = lerBloco(/:root\s*\{([\s\S]*?)\n\}/, ':root (escuro)');
const TEMA_CLARO = {
  ...TEMA_ESCURO,
  ...lerBloco(/:root\[data-tema="claro"\]\s*\{([\s\S]*?)\n\}/, ':root[data-tema="claro"]'),
};

function paraRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Luminância relativa, conforme a definição da WCAG. */
function luminancia(hex) {
  const [r, g, b] = paraRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a, b) {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// A mesma bateria roda nos dois temas: uma paleta que passa no escuro pode reprovar
// no claro (e vice-versa), e foi o que aconteceu — no escuro o acento é claro e exige
// texto ESCURO em cima; branco sobre ele dá 2.77:1.
for (const [nomeTema, tokens] of [['escuro', TEMA_ESCURO], ['claro', TEMA_CLARO]]) {
const cor = (nome) => {
  assert.ok(tokens[nome], `[${nomeTema}] token ${nome} não existe ou não é cor literal`);
  return tokens[nome];
};

describe(`tokens de design — contraste (tema ${nomeTema})`, { skip: SEM_PAINEL }, () => {
  const superficies = ['--canvas', '--surface', '--surface-2'];

  test('texto principal e secundário passam em 4.5:1 sobre toda superfície', () => {
    for (const sup of superficies) {
      for (const texto of ['--text', '--muted']) {
        const razao = contraste(cor(texto), cor(sup));
        assert.ok(
          razao >= 4.5,
          `${texto} sobre ${sup} dá ${razao.toFixed(2)}:1 — abaixo de 4.5:1`,
        );
      }
    }
  });

  test('o terciário passa em 4.5:1 — é rótulo, mas ainda é texto', () => {
    // --muted-2 é o token mais escorregadio da paleta: por ser "só legenda",
    // é o primeiro que alguém escurece de menos. Ele carrega rótulo de eixo e
    // cabeçalho de tabela, então continua sendo texto que precisa ser lido.
    for (const sup of superficies) {
      const razao = contraste(cor('--muted-2'), cor(sup));
      assert.ok(razao >= 4.5, `--muted-2 sobre ${sup} dá ${razao.toFixed(2)}:1`);
    }
  });

  test('cores semânticas são legíveis sobre a superfície e sobre o próprio -soft', () => {
    for (const nome of ['ok', 'danger', 'warning', 'info']) {
      const frente = cor(`--${nome}`);
      const fundoSoft = cor(`--${nome}-soft`);
      const sobreSurface = contraste(frente, cor('--surface'));
      const sobreSoft = contraste(frente, fundoSoft);
      assert.ok(sobreSurface >= 4.5, `--${nome} sobre --surface: ${sobreSurface.toFixed(2)}:1`);
      // O par soft é o fundo do badge; o texto por cima é a própria cor semântica.
      assert.ok(sobreSoft >= 4.5, `--${nome} sobre --${nome}-soft: ${sobreSoft.toFixed(2)}:1`);
    }
  });

  test('texto sobre o acento (botão primário) é legível', () => {
    const razao = contraste(cor('--on-accent'), cor('--accent'));
    assert.ok(razao >= 4.5, `--on-accent sobre --accent dá ${razao.toFixed(2)}:1`);
  });

  test('o acento se distingue da superfície como elemento de interface (3:1)', () => {
    // Anel de foco, borda de campo ativo e barra do item selecionado dependem
    // disto — não é texto, então a régua é 3:1.
    const razao = contraste(cor('--accent'), cor('--surface'));
    assert.ok(razao >= 3, `--accent sobre --surface dá ${razao.toFixed(2)}:1`);
  });

  test('as bordas se distinguem da superfície que separam', () => {
    // Borda que some faz o card "flutuar" sem limite em monitor mal calibrado —
    // que é a maioria. A régua aqui é frouxa de propósito (1.2:1): borda é
    // separação sutil, não sinal. O que o teste barra é a borda invisível.
    const razao = contraste(cor('--line'), cor('--surface'));
    assert.ok(razao >= 1.2, `--line sobre --surface dá ${razao.toFixed(2)}:1`);
  });

  test('nenhum PAR de séries colide — não só os vizinhos', () => {
    // O teste abaixo compara séries VIZINHAS, que é a ordem em que elas aparecem
    // na legenda. Mas o gráfico desenha as oito ao mesmo tempo, e duas séries
    // distantes na ordem podem estar coladas na tela: foi o caso do ciano com o
    // teal (16° de matiz, luminância quase igual) e, no tema claro, do azul com o
    // cinza "neutro", que era azulado. Ambos passaram despercebidos por anos
    // porque ninguém comparava todos os pares.
    const matiz = (hexCor) => {
      const [r, g, b] = paraRgb(hexCor).map((v) => v / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (!d) return 0;
      let x;
      if (mx === r) x = ((g - b) / d) % 6;
      else if (mx === g) x = (b - r) / d + 2;
      else x = (r - g) / d + 4;
      return Math.round(x * 60 + 360) % 360;
    };
    const serie = Array.from({ length: 8 }, (_, i) => cor(`--dado-${i + 1}`));
    const colisoes = [];
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const dh = Math.min(Math.abs(matiz(serie[i]) - matiz(serie[j])),
                            360 - Math.abs(matiz(serie[i]) - matiz(serie[j])));
        const dl = Math.abs(luminancia(serie[i]) - luminancia(serie[j]));
        // Matiz perto E luminância perto = mesma cor para quem olha o gráfico.
        // Uma das duas basta para separar.
        if (dh < 25 && dl < 0.06) colisoes.push(`--dado-${i + 1}/--dado-${j + 1} (Δmatiz ${dh}°, Δlum ${dl.toFixed(3)})`);
      }
    }
    assert.deepEqual(colisoes, [], `[${nomeTema}] séries indistinguíveis: ${colisoes.join(', ')}`);
  });

  test('as 8 cores de série são distinguíveis entre si', () => {
    const serie = Array.from({ length: 8 }, (_, i) => `--dado-${i + 1}`);
    for (const nome of serie) cor(nome); // todas existem

    // Séries vizinhas na legenda são as que mais se confundem. Exigir uma
    // diferença mínima de luminância evita a paleta "toda azul" em que duas
    // linhas do gráfico viram uma só.
    for (let i = 0; i < serie.length - 1; i++) {
      const l1 = luminancia(cor(serie[i]));
      const l2 = luminancia(cor(serie[i + 1]));
      assert.ok(
        Math.abs(l1 - l2) > 0.02,
        `${serie[i]} e ${serie[i + 1]} têm luminância quase igual (${l1.toFixed(3)} vs ${l2.toFixed(3)})`,
      );
    }
  });

  test('cada série é visível sobre o fundo do gráfico', () => {
    for (let i = 1; i <= 8; i++) {
      const razao = contraste(cor(`--dado-${i}`), cor('--surface'));
      assert.ok(razao >= 1.6, `--dado-${i} sobre --surface dá ${razao.toFixed(2)}:1`);
    }
  });

  test('a marca continua legível sobre o fundo escuro que ela exige', () => {
    // O gradiente da logo é claro e vive sobre --brand-ink; é essa combinação
    // (e não "marca sobre branco") que precisa passar.
    for (const nome of ['--brand-cyan', '--brand-violet']) {
      const razao = contraste(cor(nome), cor('--brand-ink'));
      assert.ok(razao >= 3, `${nome} sobre --brand-ink dá ${razao.toFixed(2)}:1`);
    }
  });
});
}

describe('tokens de design — integridade', { skip: SEM_PAINEL }, () => {
  test('os aliases de transição não viraram cor literal', () => {
    // --amber, --ink e --teal só existem para o CSS antigo continuar funcionando
    // durante a migração, e precisam APONTAR para os papéis novos. Se alguém
    // devolver um hex a eles, o tema volta a ter duas fontes de verdade.
    for (const alias of ['--amber', '--ink', '--teal']) {
      assert.ok(
        !TEMA_ESCURO[alias],
        `${alias} voltou a ser cor literal — ele deve ser var(--...) de um papel novo`,
      );
    }
  });

  test('a fonte é servida localmente, nunca de um terceiro', () => {
    assert.match(CSS, /@font-face/, 'a fonte própria sumiu do app.css');
    assert.ok(
      !/@import\s+url\(['"]?https?:/.test(CSS) && !/fonts\.googleapis|fonts\.gstatic/.test(CSS),
      'apareceu fonte externa no CSS — a CSP proíbe, e cada carga contaria a um terceiro quem usa o painel',
    );
  });

  test('a cor da série principal não é a mesma do acento', () => {
    // Enquanto `--dado-1` e `--accent` foram o mesmo azul, a barra de receita do
    // dashboard tinha exatamente a cor do botão primário — o gráfico parecia
    // clicável, e "receita" e "ação" liam como a mesma coisa. São papéis
    // diferentes (dado vs. interface) e precisam de cores diferentes.
    for (const [nome, tokens] of [['escuro', TEMA_ESCURO], ['claro', TEMA_CLARO]]) {
      assert.notEqual(
        tokens['--dado-1']?.toUpperCase(),
        tokens['--accent']?.toUpperCase(),
        `[${nome}] --dado-1 é idêntico a --accent`,
      );
    }
  });
});

// As buscas por vício visual rodam sobre o CSS SEM COMENTÁRIOS — os comentários do
// app.css citam pelo nome os efeitos removidos, e procurar no arquivo cru acusaria a
// própria explicação (foi o que aconteceu na primeira versão do teste da landing).
const REGRAS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('tokens de design — vícios visuais do painel', { skip: SEM_PAINEL }, () => {
  test('nenhum gradiente sobrou fora do shimmer de carregamento', () => {
    // O shimmer do skeleton é a única exceção legítima: ali o gradiente É a
    // animação de carregando, não decoração de marca.
    const gradientes = [...REGRAS.matchAll(/[a-z-]*gradient\([^;]*/g)].map((m) => m[0]);
    const indevidos = gradientes.filter((g) => !/--surface-2|--surface-3/.test(g));
    assert.deepEqual(
      indevidos, [],
      'gradiente fora do shimmer: era o filete de marca virando decoração genérica',
    );
  });

  test('nenhuma pílula: raio de cápsula não é forma deste painel', () => {
    assert.ok(
      !/border-radius:\s*(100px|999px|9999px|50rem)/.test(REGRAS),
      'voltou border-radius de cápsula — a forma do painel é o raio 6/10/14',
    );
  });

  test('nenhum vidro fosco', () => {
    assert.ok(
      !/backdrop-filter/.test(REGRAS),
      'voltou backdrop-filter — a topbar se separa por superfície e filete, não por blur',
    );
  });

  test('caixa-alta só onde é rótulo de seção, não em chip nem badge', () => {
    // Contar usos seria a medida errada — e foi a primeira que escrevi. Caixa-alta
    // em rótulo curto de seção é o IDIOMA deste painel (as classes `-k`, o `th`, o
    // `.eyebrow`): mudar isso seria redesenhar tudo, não tirar vício. O vício é
    // caixa-alta em BADGE e CHIP, que são conteúdo — "ADMINISTRADOR", "TAG ÚNICA",
    // "WEBHOOK" gritando no meio da tela. Então o teste mede exatamente isso: quais
    // seletores usam caixa-alta, e nenhum deles pode ser de badge/chip/pílula.
    const comCaixaAlta = [...REGRAS.matchAll(/([^{}]+)\{[^{}]*text-transform:\s*uppercase[^{}]*\}/g)]
      .map((m) => m[1].trim().split(String.fromCharCode(10)).pop().trim());
    const proibidos = comCaixaAlta.filter((sel) => /badge|chip|pill|\.tag-n|role|peso/i.test(sel));
    assert.deepEqual(
      proibidos, [],
      `caixa-alta em badge/chip: ${proibidos.join(', ')} — badge é conteúdo, não rótulo de seção`,
    );
  });

  test('a marca não pinta filete, barra nem anel de foco', () => {
    // `--brand-grad`/`--brand-cyan`/`--brand-violet` são identidade: logo, avatar
    // da empresa. Quando viram pintura de componente, a marca deixa de significar
    // marca e o painel ganha duas cores frias competindo com o acento.
    const usos = [...REGRAS.matchAll(/^[^{}]*\{[^{}]*var\(--brand-(grad|cyan|violet)\)[^{}]*\}/gm)]
      .map((m) => m[0].split('{')[0].trim());
    assert.deepEqual(usos, [], `marca usada como pintura em: ${usos.join(', ')}`);
  });
});

// ---------------------------------------------------------------- landing
//
// Por que a landing precisa de bateria PRÓPRIA, e não das duas de cima: ela é a
// única superfície do produto que não acompanha o tema — abre sempre escura, por
// decisão de produto. Enquanto os tokens dela eram DERIVADOS dos tokens de tema
// (`--lp-text: var(--surface)`), ela parecia coberta e não estava: quando o tema
// escuro virou o padrão, `--surface` deixou de ser #FFFFFF e passou a #121A2E, e o
// texto da primeira dobra virou 1.14:1 sobre #0B0F1A — título, lead e links
// invisíveis em produção, sem um único teste vermelho.
//
// A regra que este bloco trava: os tokens da landing são LITERAIS e vivem no
// próprio arquivo dela. Se alguém voltar a escrevê-los como var(--algo-de-tema),
// `lerBlocoDe` não os reconhece como cor e o teste falha dizendo o porquê.
const CAMINHO_LANDING = join(RAIZ, 'public', 'estilos', 'landing.css');
const TEM_LANDING = existsSync(CAMINHO_LANDING);
const CSS_LANDING = TEM_LANDING ? readFileSync(CAMINHO_LANDING, 'utf8') : '';
const SEM_LANDING = !TEM_LANDING && 'landing servida pelo repo do app';

function lerBlocoDe(css, regex, nomeAmigavel) {
  if (!css) return {};
  const bloco = css.match(regex);
  assert.ok(bloco, `bloco ${nomeAmigavel} não encontrado em landing.css`);
  const tokens = {};
  for (const linha of bloco[1].split('\n')) {
    for (const [, nome, valor] of linha.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const v = valor.trim();
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) tokens[nome] = v;
    }
  }
  return tokens;
}

const LANDING = lerBlocoDe(CSS_LANDING, /\.lp-page\s*\{([\s\S]*?)\n\}/, '.lp-page');

// As buscas por vício visual rodam sobre o CSS SEM COMENTÁRIOS. O comentário do
// topo do landing.css explica quais efeitos foram removidos e cita o nome deles;
// procurar no arquivo cru acusaria a própria explicação — foi o que aconteceu na
// primeira versão deste teste.
const REGRAS_LANDING = CSS_LANDING.replace(/\/\*[\s\S]*?\*\//g, '');

describe('tokens de design — landing pública', { skip: SEM_LANDING }, () => {
  const cor = (nome) => {
    assert.ok(
      LANDING[nome],
      `${nome} não é cor literal em .lp-page — a landing não acompanha o tema, ` +
        'então não pode se descrever com token de tema (foi assim que o texto virou 1.14:1)',
    );
    return LANDING[nome];
  };

  test('o texto da primeira dobra é legível sobre o fundo dela', () => {
    for (const superficie of ['--canvas', '--surface', '--surface-2']) {
      for (const texto of ['--text', '--muted', '--muted-2']) {
        const r = contraste(cor(texto), cor(superficie));
        assert.ok(r >= 4.5, `${texto} sobre ${superficie} dá ${r.toFixed(2)}:1, abaixo de 4.5:1`);
      }
    }
  });

  test('o acento é legível como texto e o texto em cima dele também', () => {
    const sobreFundo = contraste(cor('--accent'), cor('--canvas'));
    assert.ok(sobreFundo >= 4.5, `o acento dá ${sobreFundo.toFixed(2)}:1 sobre o fundo`);
    const noBotao = contraste(cor('--on-accent'), cor('--accent'));
    assert.ok(noBotao >= 4.5, `o texto do botão primário dá ${noBotao.toFixed(2)}:1`);
  });

  test('a faixa de papel — a única clara — tem tinta legível', () => {
    const r = contraste(cor('--lp-papel-tinta'), cor('--lp-papel'));
    assert.ok(r >= 4.5, `a tinta sobre o papel dá ${r.toFixed(2)}:1`);
  });

  test('as bordas se distinguem da superfície que separam (3:1 de interface)', () => {
    const r = contraste(cor('--line-2'), cor('--surface-2'));
    assert.ok(r >= 1.4, `--line-2 sobre --surface-2 dá ${r.toFixed(2)}:1 — a caixa desaparece`);
  });

  test('a landing não voltou a ter aurora, gradiente em texto nem glow de marca', () => {
    // Estes três eram os vícios visuais removidos em 2026-08-25. O teste não é
    // sobre gosto: o gradiente em `background-clip: text` deixava metade da frase
    // mais importante da página a 2:1 do fundo, e a aurora eram três blobs com
    // blur de 90px animados em loop — o efeito mais caro que a página tinha.
    assert.ok(!/-webkit-background-clip:\s*text|background-clip:\s*text/.test(REGRAS_LANDING),
      'voltou texto com gradiente recortado — ele custa contraste na parte mais importante da página');
    assert.ok(!/filter:\s*blur\(\s*[5-9]\d|filter:\s*blur\(\s*\d{3}/.test(REGRAS_LANDING),
      'voltou blob desfocado de raio grande na landing');
    assert.ok(!/mix-blend-mode/.test(REGRAS_LANDING),
      'voltou mix-blend-mode — era o truque para esconder o fundo preto do PNG da logo');
  });

  test('a primeira dobra é presa a uma tela, e com a unidade certa', () => {
    assert.match(REGRAS_LANDING, /min-height:\s*100svh/,
      'a primeira dobra precisa de 100svh: com 100vh a barra de endereço do celular esconde o CTA');
  });
});

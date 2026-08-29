// Grava a logo inicial de um projeto a partir de um arquivo PNG do disco.
//
//   node src/scripts/seed-marca.js                         # Codigo Vencedor + C:\...\Logo.png
//   node src/scripts/seed-marca.js --arquivo=./marca.png --nome="Minha Empresa" --cor=#4F46E5
//   node src/scripts/seed-marca.js --projeto=prj_abc123
//
// Por que um script e não uma migração: a imagem é DADO de um cliente específico, não
// estrutura. Migração roda em todo ambiente (inclusive no banco de teste e no de outro
// cliente); seed roda onde o operador manda. É a mesma divisão de src/scripts/seed.js.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// O redimensionamento é feito aqui, em Node puro, sem dependência nova (o projeto tem
// três: express, pg, nodemailer — e essa lista é um ativo). PNG de 8 bits sem entrelace
// é um formato que se decodifica com o zlib que já vem no Node: inflar os IDAT, desfazer
// os filtros por linha, reamostrar e reescrever. São ~120 linhas contra uma dependência
// nativa (sharp/canvas) que precisaria compilar na imagem Docker.
//
// A alternativa era gravar o PNG original (171 KB, dentro do teto de 200 KB) — funciona,
// mas põe uma imagem de 447×331 numa linha de banco lida a cada abertura do painel para
// ser exibida em 24×24. Reduzir custa este arquivo e devolve ~95% dos bytes.
// ─────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { query, closePool, waitForDatabase } from '../db/pool.js';
import { validarLogoMarca, validarCorMarca } from '../db/repos/projects.js';

const LADO = 128; // o painel exibe em 24×24; 128 cobre telas 2×/3× sem pesar

// ============================================================== leitura de PNG

function lerChunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('o arquivo não é um PNG');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const tipo = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ tipo, dados: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (tipo === 'IEND') break;
  }
  return chunks;
}

const CANAIS = { 0: 1, 2: 3, 4: 2, 6: 4 }; // colorType -> canais (3 = paleta, não suportado)

/** Decodifica um PNG 8 bits, não entrelaçado, para { largura, altura, pixels RGBA }. */
function decodificarPng(buf) {
  const chunks = lerChunks(buf);
  const ihdr = chunks.find((c) => c.tipo === 'IHDR');
  if (!ihdr) throw new Error('PNG sem IHDR');

  const largura = ihdr.dados.readUInt32BE(0);
  const altura = ihdr.dados.readUInt32BE(4);
  const profundidade = ihdr.dados[8];
  const tipoCor = ihdr.dados[9];
  const entrelace = ihdr.dados[12];

  if (profundidade !== 8) throw new Error(`só PNG de 8 bits por canal (este tem ${profundidade})`);
  if (entrelace !== 0) throw new Error('PNG entrelaçado (Adam7) não é suportado — reexporte sem entrelace');
  const canais = CANAIS[tipoCor];
  if (!canais) throw new Error(`tipo de cor ${tipoCor} não suportado (paleta: reexporte como RGB/RGBA)`);

  const bruto = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.tipo === 'IDAT').map((c) => c.dados)));

  // Desfaz os filtros por linha. Cada scanline vem precedida de um byte dizendo qual
  // dos cinco filtros foi aplicado; todos são diferenças em relação ao pixel à esquerda
  // (a), ao de cima (b) e ao da diagonal (c).
  const bpp = canais;
  const passo = largura * bpp;
  const linhas = Buffer.alloc(altura * passo);
  for (let y = 0; y < altura; y++) {
    const filtro = bruto[y * (passo + 1)];
    const entrada = bruto.subarray(y * (passo + 1) + 1, y * (passo + 1) + 1 + passo);
    const saida = linhas.subarray(y * passo, (y + 1) * passo);
    const anterior = y > 0 ? linhas.subarray((y - 1) * passo, y * passo) : null;
    for (let i = 0; i < passo; i++) {
      const a = i >= bpp ? saida[i - bpp] : 0;
      const b = anterior ? anterior[i] : 0;
      const c = anterior && i >= bpp ? anterior[i - bpp] : 0;
      let v = entrada[i];
      if (filtro === 1) v += a;
      else if (filtro === 2) v += b;
      else if (filtro === 3) v += (a + b) >> 1;
      else if (filtro === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filtro !== 0) throw new Error(`filtro PNG desconhecido: ${filtro}`);
      saida[i] = v & 0xff;
    }
  }

  // Normaliza tudo para RGBA — o resto do script só conhece 4 canais.
  const pixels = Buffer.alloc(largura * altura * 4);
  for (let i = 0, n = largura * altura; i < n; i++) {
    const o = i * canais; const d = i * 4;
    if (canais === 4) { pixels[d] = linhas[o]; pixels[d + 1] = linhas[o + 1]; pixels[d + 2] = linhas[o + 2]; pixels[d + 3] = linhas[o + 3]; }
    else if (canais === 3) { pixels[d] = linhas[o]; pixels[d + 1] = linhas[o + 1]; pixels[d + 2] = linhas[o + 2]; pixels[d + 3] = 255; }
    else if (canais === 2) { pixels[d] = pixels[d + 1] = pixels[d + 2] = linhas[o]; pixels[d + 3] = linhas[o + 1]; }
    else { pixels[d] = pixels[d + 1] = pixels[d + 2] = linhas[o]; pixels[d + 3] = 255; }
  }
  return { largura, altura, pixels };
}

// ============================================================== reamostragem

/**
 * Reduz por média de área (box filter) e encaixa o resultado, centralizado, numa tela
 * quadrada de `LADO`. Encaixar em vez de recortar porque logo é quase sempre horizontal:
 * um recorte central de 447×331 cortaria justamente as pontas do logotipo. O vazio ao
 * redor recebe a cor do canto da imagem original (logo com fundo chapado fica um ladrilho
 * inteiro) ou fica transparente, quando o canto já é transparente.
 *
 * A média é feita com alfa PRÉ-MULTIPLICADO: sem isso, a cor de um pixel transparente
 * (frequentemente preto) entra na conta e a borda do logotipo escurece.
 */
function reduzirParaQuadrado(img, lado) {
  const escala = Math.min(lado / img.largura, lado / img.altura);
  const lw = Math.max(1, Math.round(img.largura * escala));
  const lh = Math.max(1, Math.round(img.altura * escala));
  const offX = Math.floor((lado - lw) / 2);
  const offY = Math.floor((lado - lh) / 2);

  const fundo = [img.pixels[0], img.pixels[1], img.pixels[2], img.pixels[3]];
  const opaco = fundo[3] === 255;
  const saida = Buffer.alloc(lado * lado * 4);
  for (let i = 0; i < lado * lado; i++) {
    const d = i * 4;
    saida[d] = opaco ? fundo[0] : 0;
    saida[d + 1] = opaco ? fundo[1] : 0;
    saida[d + 2] = opaco ? fundo[2] : 0;
    saida[d + 3] = opaco ? 255 : 0;
  }

  for (let y = 0; y < lh; y++) {
    const y0 = Math.floor((y * img.altura) / lh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.altura) / lh));
    for (let x = 0; x < lw; x++) {
      const x0 = Math.floor((x * img.largura) / lw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.largura) / lw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.largura + sx) * 4;
          const alfa = img.pixels[o + 3] / 255;
          r += img.pixels[o] * alfa; g += img.pixels[o + 1] * alfa; b += img.pixels[o + 2] * alfa;
          a += img.pixels[o + 3];
          n++;
        }
      }
      const alfaMedio = a / n;
      const k = alfaMedio > 0 ? 255 / alfaMedio : 0; // desfaz a pré-multiplicação
      const d = ((y + offY) * lado + (x + offX)) * 4;
      const fa = alfaMedio / 255;
      // Composição source-over sobre o fundo já pintado acima.
      const dr = saida[d], dg = saida[d + 1], db = saida[d + 2], da = saida[d + 3] / 255;
      const sr = Math.min(255, (r / n) * k), sg = Math.min(255, (g / n) * k), sb = Math.min(255, (b / n) * k);
      const outA = fa + da * (1 - fa);
      saida[d] = outA ? Math.round((sr * fa + dr * da * (1 - fa)) / outA) : 0;
      saida[d + 1] = outA ? Math.round((sg * fa + dg * da * (1 - fa)) / outA) : 0;
      saida[d + 2] = outA ? Math.round((sb * fa + db * da * (1 - fa)) / outA) : 0;
      saida[d + 3] = Math.round(outA * 255);
    }
  }
  return { largura: lado, altura: lado, pixels: saida };
}

// ============================================================== escrita de PNG

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tipo, dados) {
  const cabecalho = Buffer.alloc(8);
  cabecalho.writeUInt32BE(dados.length, 0);
  cabecalho.write(tipo, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tipo, 'ascii'), dados])), 0);
  return Buffer.concat([cabecalho, dados, crc]);
}

function codificarPng({ largura, altura, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;  // bits por canal
  ihdr[9] = 6;  // RGBA
  // Filtro 0 (nenhum) em todas as linhas: a economia de um filtro adaptativo é pequena
  // numa imagem de 128×128 e o código dobraria de tamanho.
  const passo = largura * 4;
  const bruto = Buffer.alloc(altura * (passo + 1));
  for (let y = 0; y < altura; y++) {
    bruto[y * (passo + 1)] = 0;
    pixels.copy(bruto, y * (passo + 1) + 1, y * passo, (y + 1) * passo);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(bruto, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ============================================================== o seed em si

/** Converte um PNG do disco na data-URI 128×128 que o painel guarda. Exportada para teste. */
export function logoDataUri(caminho, lado = LADO) {
  const original = decodificarPng(readFileSync(caminho));
  const reduzida = reduzirParaQuadrado(original, lado);
  const png = codificarPng(reduzida);
  return { dataUri: `data:image/png;base64,${png.toString('base64')}`, bytes: png.length, original };
}

function arg(nome, padrao) {
  const achado = process.argv.slice(2).find((a) => a.startsWith(`--${nome}=`));
  return achado ? achado.slice(nome.length + 3) : padrao;
}

async function main() {
  const arquivo = arg('arquivo', 'C:\\Users\\binho\\Downloads\\Logo.png');
  const nome = arg('nome', 'Codigo Vencedor');
  const projetoId = arg('projeto', '');
  // Índigo da paleta de ação: é a cor de fallback das iniciais e da barra do item ativo,
  // trocável em dez segundos pelo modal "Marca da empresa".
  const cor = validarCorMarca(arg('cor', '#4F46E5'));

  const { dataUri, bytes, original } = logoDataUri(arquivo);
  validarLogoMarca(dataUri); // a mesma validação que a API aplica — falha aqui, não no painel

  await waitForDatabase();
  const { rows } = projetoId
    ? await query('SELECT id, name FROM projects WHERE id = $1', [projetoId])
    : await query('SELECT id, name FROM projects WHERE name ILIKE $1 ORDER BY created_at ASC', [`%${nome}%`]);

  if (!rows.length) {
    console.error(`nenhum projeto encontrado (${projetoId ? `id ${projetoId}` : `nome ~ "${nome}"`}).`);
    process.exitCode = 1;
    return;
  }

  for (const p of rows) {
    await query('UPDATE projects SET logo = $2, cor = $3, updated_at = now() WHERE id = $1', [p.id, dataUri, cor]);
    console.log(
      `marca gravada em ${p.name} (${p.id}): ${original.largura}×${original.altura} → ${LADO}×${LADO}, ` +
      `${Math.ceil(bytes / 1024)} KB, cor ${cor}`
    );
  }
}

if (process.argv[1]?.endsWith('seed-marca.js')) {
  main()
    .catch((err) => { console.error('falha ao gravar a marca:', err.message); process.exitCode = 1; })
    .finally(closePool);
}

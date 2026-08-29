// Ponte com o Lucide (vendor/lucide.min.js) — troca os placeholders <i data-lucide="..">
// pelo SVG de verdade. Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// O painel injeta HTML dinamicamente o tempo todo (troca de aba, re-render de tabela,
// modal), então "aplicar ícones" não é um passo único no boot: é uma função que toda
// tela nova precisa chamar depois de montar seu próprio HTML. Aceitar um `raiz` evita
// varrer o documento inteiro de novo a cada pequena atualização.
function aplicarIcones(raiz = document) {
  // Se o vendor não carregou (bloqueado, CDN fora do ar não se aplica aqui pois é
  // local, mas um <script> pode falhar por outros motivos) o painel não pode travar
  // por isso — os data-lucide ficam como <i> vazio, feio mas inofensivo.
  if (!window.lucide || typeof window.lucide.createIcons !== 'function') return;

  window.lucide.createIcons({
    // Traço fino e tamanho pequeno para casar com o resto do painel (ver ICON em
    // nucleo.js, que usa stroke-width 1.75); cor sempre herdada do texto ao redor,
    // nunca fixa, para funcionar em qualquer contexto (botão, título, alerta).
    attrs: {
      'stroke-width': 1.75,
      width: 18,
      height: 18,
      color: 'currentColor',
    },
    nameAttr: 'data-lucide',
    root: raiz,
  });
}

// Aplica os ícones que já nascem no HTML estático (admin.html) assim que a página
// carrega. Ícones injetados depois (render de lista, abertura de aba) são
// responsabilidade de quem monta aquele HTML — chamar aplicarIcones(trecho) no final.
document.addEventListener('DOMContentLoaded', () => aplicarIcones());

// Movimento da landing pública: a entrada do hero, e nada mais.
'use strict';

/* Todo o JS da landing vive aqui, em arquivo próprio, porque a CSP do servidor
   é `script-src 'self'` — não existe script inline em nenhuma página deste
   projeto, e essa é uma decisão de segurança, não de organização.

   O que este arquivo FAZIA e não faz mais: a deriva da aurora, três blobs
   radiais desfocados em 90px animados em loop infinito. Saiu junto com a
   aurora — era o efeito mais caro da página (blur grande é repintura constante)
   e não carregava informação nenhuma.

   Contrato com o CSS (`public/estilos/landing.css`):
   - sem este arquivo a página está completa: o conteúdo do hero é visível por
     padrão. Nada aqui é requisito de leitura;
   - quando o GSAP existe, marcamos `.esta-com-gsap` no hero. Só então o CSS
     zera a opacidade dos alvos, que a timeline revela em seguida. É essa ordem
     que garante que uma falha de carregamento do GSAP nunca deixe a primeira
     dobra em branco.

   O IIFE existe para não vazar nomes. */
(function () {
  var gsap = window.gsap;
  if (!gsap) return; // GSAP não carregou: o CSS já entrega a página inteira.

  var hero = document.getElementById('hero');
  if (!hero) return;

  var alvos = hero.querySelectorAll('[data-anim]');
  if (!alvos.length) return;

  var mm = gsap.matchMedia();

  /* `no-preference` e não `reduce`: quem não expressou preferência recebe o
     movimento; quem pediu menos movimento não entra aqui e a timeline sequer é
     construída — o custo é zero, não "animação de 0.01ms". */
  mm.add('(prefers-reduced-motion: no-preference)', function () {
    hero.classList.add('esta-com-gsap');

    var entrada = gsap.timeline({ defaults: { ease: 'power2.out' } });
    entrada.fromTo(
      alvos,
      { opacity: 0, y: 14 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.07, clearProps: 'transform' }
    );

    // Cleanup do matchMedia: se a preferência mudar no meio da sessão, os
    // tweens morrem e o hero volta ao estado legível do CSS.
    return function () {
      hero.classList.remove('esta-com-gsap');
      gsap.set(alvos, { clearProps: 'all' });
    };
  });

  /* Aba oculta = nada se move. Sobrou pouco movimento na página (os pulsos do
     trilho), mas mantê-lo rodando enquanto a pessoa está em outra aba é gastar
     a bateria dela para ninguém ver. O `.lp-pausado` cobre as animações CSS. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      gsap.globalTimeline.pause();
      document.body.classList.add('lp-pausado');
    } else {
      gsap.globalTimeline.resume();
      document.body.classList.remove('lp-pausado');
    }
  });
})();

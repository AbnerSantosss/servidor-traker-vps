// Dicionário central dos textos de ajuda contextual do painel. Cada chave alimenta um
// botão `<button class="ajuda" data-ajuda="chave">` (ver admin/tooltip.js). Textos em
// pt-BR, curtos, escritos para quem opera marketing — não para quem lê o código.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

const AJUDAS = {
  // ---------------- Identificadores de clique e navegador ----------------
  'fbclid': 'É o código que o Facebook/Instagram grava na URL quando alguém clica num anúncio. Sem ele o sistema não sabe de qual anúncio veio a venda — se sumir das URLs, confira se algum redirecionamento do site está cortando os parâmetros.',
  'fbc': 'Cookie que guarda o clique do anúncio da Meta de forma persistente no navegador do visitante. É um dos dados mais fortes para a Meta casar a venda com o anúncio certo; ele nasce a partir do fbclid, então se o fbclid está vazio o fbc também vai estar.',
  'fbp': 'Cookie de identificação do navegador colocado pelo Pixel da Meta, independente de ter vindo de anúncio. Ajuda a Meta a reconhecer que é a mesma pessoa entre a visita e a compra — se estiver ausente, o Pixel pode não estar instalado corretamente no site.',
  'gclid': 'Código que o Google Ads grava na URL quando alguém clica num anúncio do Google. É o principal identificador para o Google ligar a conversão ao anúncio; sem ele, a conversão aparece mas sem saber de qual campanha.',
  'gbraid/wbraid': 'Versões do identificador de clique do Google usadas em cenários com privacidade reforçada (gbraid em apps/iOS, wbraid quando o clique passa por redirecionamento). Servem para o mesmo propósito do gclid quando ele não está disponível.',
  'external_id': 'Identificador único do cliente no seu próprio sistema (ex.: ID do usuário, CPF hasheado). Ajuda a plataforma a reconhecer a mesma pessoa em compras diferentes mesmo sem e-mail ou telefone — quanto mais estável esse ID, melhor a correspondência ao longo do tempo.',
  'event_id': 'Identificador único de cada evento, usado para deduplicar. Se o mesmo evento chegar duas vezes (ex.: pelo navegador e pelo webhook) com o mesmo event_id, a plataforma conta só uma vez — sem ele, o mesmo evento pode ser contado em dobro.',

  // ---------------- Qualidade de correspondência e envio ----------------
  'deduplicacao': 'Processo pelo qual a plataforma reconhece que dois envios do mesmo evento (por exemplo, do navegador e do servidor) são a mesma conversão e não deve contá-la duas vezes. Depende do event_id ser idêntico nos dois envios — se os números de conversão parecerem dobrados, é o primeiro lugar para checar.',
  'emq': 'Nota da Meta (0 a 10, visível no Gerenciador de Eventos dela) para a qualidade dos dados de correspondência de cada evento — quanto mais campos como e-mail, telefone e fbc estiverem preenchidos, maior a nota. O diagnóstico deste painel é uma estimativa própria para achar o que falta antes do evento sair daqui; não é a nota oficial.',
  'action_source': 'Diz à Meta de onde o evento realmente aconteceu: "website" para o que ocorre no site, "system_generated" ou outros valores para eventos originados fora do navegador (ex.: webhook de backend). Usar o valor errado pode fazer a Meta descontar a qualidade do evento.',
  'test-event-code': 'Código que redireciona os eventos enviados para a aba "Eventos de teste" do Gerenciador de Eventos da Meta, em vez de entrar nos dados reais da conta. Sem ele, o modo Teste do console não funciona — pegue o código em Gerenciador de Eventos → Eventos de teste.',
  'pixel-id': 'Número de 15 dígitos que identifica o Pixel da Meta configurado para este projeto. Fica no topo da página da fonte de dados, no Gerenciador de Eventos — é ele que diz para qual conta de anúncios os eventos vão.',
  'access-token': 'Token que autoriza este servidor a enviar eventos em nome da sua conta de anúncios pela Conversions API da Meta. É um segredo: fica criptografado no banco e nunca é devolvido pela API, só a informação de que já existe um salvo.',
  'measurement-id': 'Identificador do fluxo de dados do GA4 (começa com "G-"), que diz para qual propriedade do Google Analytics os eventos são enviados. Fica em Admin → Fluxos de dados, dentro do Google Analytics.',
  'api-secret': 'Segredo gerado dentro do fluxo de dados do GA4, exigido pelo Measurement Protocol para autenticar o envio de eventos server-side. Fica criptografado no banco; se for revogado no Google, os envios passam a falhar até você gerar um novo e salvar aqui.',
  'customer-id': 'Número da conta do Google Ads para a qual as conversões serão enviadas (com ou sem traços, ex.: 123-456-7890). Uma conta MCC gestora usa o Login Customer ID além deste.',
  'conversion-action': 'A ação de conversão específica cadastrada dentro do Google Ads (ex.: "Compra") para a qual cada evento deve ser reportado. Cada evento do seu site precisa apontar para uma conversion action existente na conta, senão o envio falha.',

  // ---------------- Postback ----------------
  'macros-postback': 'Marcadores como {event_name} ou {value} dentro da URL do postback, substituídos pelos dados reais do evento no momento do envio. Use-os para montar a URL que a rede de afiliados, CRM ou outro sistema espera receber.',

  // ---------------- Instalação e domínio ----------------
  'token-ingestao': 'Segredo que autentica as chamadas do seu backend ao endpoint de webhook deste projeto (vai no cabeçalho Authorization: Bearer). Só deve estar em código server-to-server, nunca no navegador — cada vez que é revelado no painel, fica registrado em log.',
  'slug-ingestao': 'Trecho aleatório e único na URL de cada projeto (ex.: /e/ab12cd34) que identifica o projeto sem depender do nome dele. Pode ser regenerado se, por algum motivo, esse caminho for descoberto por alguém que não deveria tê-lo.',
  'dominio-first-party': 'Subdomínio próprio do cliente (ex.: t.loja.com.br) apontado para este servidor, para que os cookies de rastreamento sejam tratados como first-party pelo navegador. Reduz bastante o bloqueio por ad-blockers e por proteções de navegador contra cookies de terceiros.',
  'cname-vs-a': 'Duas formas de apontar o DNS para este servidor: CNAME aponta para um nome de host (mais simples de manter se o IP mudar), Registro A aponta direto para um IP fixo. Use o que a instrução exata da tela indicar para o seu domínio.',
  'consentimento-lgpd': 'Sinal (enviado no evento) que diz se o titular autorizou o uso dos dados dele para publicidade. Quando o consentimento é negado, o servidor remove os dados pessoais (e-mail, telefone) antes mesmo de gravar o evento no banco — não é uma regra que se aplica depois, é uma barreira antes de guardar qualquer coisa.',
  'propagacao-dns': 'Tempo que os servidores de DNS do mundo todo levam para "aprender" o registro novo que você acabou de criar. Costuma levar minutos, mas pode chegar a algumas horas dependendo do provedor — clicar em Verificar de novo depois de um tempo não tem custo nenhum.',
  'certificado-tls': 'O cadeado do navegador (HTTPS) para o seu subdomínio. Este servidor emite o certificado sozinho, de graça, assim que o DNS estiver apontando corretamente — não precisa comprar nem instalar nada; é automático.',

  // ---------------- Instalação sem GTM (tag única) ----------------
  'metodo-instalacao': 'Google Tag Manager reaproveita um container que o site já usa e não exige tocar no código do site. Código no próprio site é uma linha só no <head> — mais direto quando não há GTM instalado, ou quando é mais simples editar o HTML do que publicar um container. As duas trilhas fazem a mesma coisa por baixo; a diferença é só onde o código roda.',
  'tag-unica': 'A mesma tag da trilha GTM (identidade + page_view), só que instalada direto no <head> do site em vez de publicada por um container. Não depende de dataLayer: descobre o user_id em variável global e expõe window.trkIdentify(...) para o site informar quem é o visitante. Dispara o page_view sozinha (inclusive em SPA, ao trocar de rota) e expõe window.trk(...) para o resto dos eventos.',
  'trk-queue': 'Como a tag carrega com async, o navegador pode tentar chamar trk(...) antes do arquivo terminar de baixar. Acumule as chamadas em window.trkQueue = window.trkQueue || [] e dê push([\'nome_do_evento\', opções]) — a tag drena essa fila assim que carrega, então nada se perde mesmo chamando cedo.',
  'trk-identify': 'Amarra a identidade do visitante (user_id) aos identificadores de clique já capturados, sem depender de dataLayer. Use quando o site só descobre quem é o visitante depois do carregamento da página — login, checkout assíncrono, área logada carregada via JavaScript.',
  'params-globais': 'Configuração lida de window.trkConfig (definido antes da tag) ou dos atributos data-* da própria tag — o atributo da tag tem prioridade. Cobre onde procurar o user_id (userIdKeys), valores fixos somados a todo evento (paramsGlobais) e identificadores extras de outras plataformas de anúncio a capturar da URL (clickIds).',
  'click-ids-extra': 'Identificadores de clique de plataformas sem campo fixo no sistema (ex.: uma rede de afiliados nova) — liste as chaves da query string a capturar em clickIds. Cada uma vira uma entrada em user_data.click_ids, disponível para o postback e para o Webhook Studio; é uma allowlist de propósito, para não virar coleta de qualquer parâmetro da URL.',

  // ---------------- Console de testes ----------------
  'modo-simular': 'Nada sai deste servidor: o console só mostra como o payload seria interpretado e o que seria enviado. Use para conferir o formato antes de arriscar qualquer envio de verdade.',
  'modo-teste': 'O evento é enviado de verdade, mas cai só na aba "Eventos de teste" da plataforma (exige o Test Event Code configurado) — não entra nos dados reais da conta nem afeta relatórios de campanha.',
  'modo-real': 'O evento é enviado e entra nos dados reais da conta de anúncios, exatamente como uma conversão de produção. Use com cuidado: pode distorcer métricas de campanha se for um evento de teste disfarçado de venda real.',
  // Chave combinada (em vez das três acima) para o botão único ao lado do passo "1 · O
  // que fazer com o evento" — três ícones de ajuda lado a lado nos próprios botões de
  // modo confundiriam mais do que ajudariam, já que o rótulo de cada modo já é curto.
  'modos-console-teste': 'Simular não envia nada — só mostra como o evento seria interpretado. Teste envia de verdade, mas só para a aba "Eventos de teste" da plataforma. Real envia para os dados de produção da conta, como uma venda de verdade. Comece sempre por Simular.',
  'destino-console-teste': 'Escolha para qual plataforma este teste vai (Meta, Google ou Postback). Só aparecem como opção os destinos já configurados e habilitados para este projeto.',
  'payload-console-teste': 'Cole aqui o JSON do evento a testar, no formato que o seu site ou backend realmente envia. Use um dos modelos prontos acima para começar rápido — inclusive o formato do checkout, reconhecido automaticamente.',

  // ---------------- Logs / status de entrega ----------------
  'status-pending': 'O evento está na fila, aguardando o worker processá-lo e enviá-lo ao destino. Se ficar pending por muito tempo, o worker pode estar parado — vale checar se o processo dele está rodando.',
  'status-success': 'O destino recebeu o evento e confirmou o recebimento com sucesso. Não precisa de nenhuma ação.',
  'status-error': 'O envio falhou por um motivo que pode se resolver sozinho (ex.: instabilidade momentânea do destino) e será tentado novamente automaticamente, com espera crescente entre as tentativas.',
  'status-dead': 'O envio falhou por um motivo que não se resolve tentando de novo (ex.: credencial inválida, pixel errado) e parou de ser retentado. Corrija a causa (geralmente nas credenciais) e reenvie manualmente pela ação de reenvio.',
  'status-skipped-consent': 'O evento não foi enviado porque o titular negou o consentimento — é o comportamento esperado quando não há autorização, não um erro para investigar.',
  'status-skipped-unmapped': 'O evento não foi enviado porque o nome dele não tem correspondência configurada no mapeamento de eventos daquele destino. Adicione uma linha no mapeamento (aba Meta ou Google) se esse evento deveria ser enviado.',
  // Chave combinada para o botão único ao lado de cada coluna de destino na tabela de
  // logs (Meta/Google/Postback) — as seis chaves de status acima seguem existindo
  // para reaproveitamento futuro em telas que mostrem UM status por vez.
  'colunas-status-logs': 'Cada coluna mostra o status do envio para aquele destino: sucesso (verde), falha temporária que será tentada de novo (dourado), falha definitiva que parou de tentar (vermelho), ou vazio quando o destino não estava habilitado para esse evento.',

  // ---------------- Usuários ----------------
  'papel-admin': 'Acesso total ao painel: cria e edita projetos, altera credenciais (Meta, Google, Postback) e gerencia os usuários que entram no painel.',
  'papel-operador': 'Acompanha dashboard, instalação, domínios e logs, mas não vê nem altera credenciais e não gerencia usuários — é o papel indicado para quem só precisa monitorar o que está acontecendo.',
  // Chave combinada para o botão único ao lado do seletor de papel — evita dois ícones
  // idênticos (um para admin, um para operador) que só se distinguiriam pelo texto do
  // balão, sem nenhuma pista visual de qual é qual.
  'papeis-usuario': 'Administrador tem acesso total: credenciais (Meta, Google, Postback) e gestão de usuários inclusas. Operador acompanha dashboard, instalação, domínios e logs, mas não vê nem altera credenciais e não gerencia usuários.',

  // ---------------- Dashboard — KPIs (faixa 1) ----------------
  'kpi-eventos': 'Total de eventos recebidos no período, de todos os tipos. Uma queda brusca costuma indicar que a tag do Passo 2 (identidade + page_view) ou o webhook do backend pararam de disparar — confira a aba Instalação.',
  'kpi-conversoes': 'Quantidade de eventos de compra (purchase) no período. É o número que a operação acompanha para saber se as campanhas estão convertendo.',
  'kpi-receita': 'Soma do valor de todas as compras do período. Se parecer baixa demais, confira se o campo de valor está mesmo vindo preenchido no payload do webhook de purchase.',
  'kpi-cadastros': 'Quantidade de eventos de cadastro/lead (sign_up, lead) no período — mede o topo do funil antes da compra.',
  'kpi-ticket-medio': 'Receita total dividida pelo número de compras do período. Uma queda repentina pode ser produto de menor valor vendendo mais, ou um erro no valor enviado pelo webhook.',
  'kpi-taxa-sucesso': 'Percentual das entregas aos destinos (Meta, Google, Postback) que terminaram em sucesso no período. Se cair, veja o cartão "Entregas por destino", mais abaixo, para achar o destino e o erro.',
  'kpi-pct-atribuicao': 'Percentual das compras do período que chegaram com pelo menos um identificador de clique (fbc ou gclid), permitindo à plataforma de anúncio ligar a venda à campanha certa. Se estiver baixo, confira se a tag do Passo 2 (identidade + page_view) está publicada no GTM e disparando antes da compra.',
  'kpi-sem-fbc': 'Eventos do período que chegaram sem o cookie de clique da Meta (fbc) nem o parâmetro fbclid na URL — não dá para saber de qual anúncio vieram. Acima de 20% costuma indicar a tag do Passo 2 ausente no GTM, bloqueada por consentimento, ou publicada depois do primeiro clique.',

  // ---------------- Hub Meta/Google (F2/F3) — visão geral e falhas explicadas ----------------
  'destino-ligado-desligado': 'Quando ligado, o servidor tenta entregar cada evento a este destino assim que ele chega. Quando desligado, os eventos continuam sendo recebidos e gravados normalmente — só não saem daqui, e voltam a sair assim que você ligar de novo (sem precisar reenviar o histórico).',
  'ultima-entrega-sucesso': 'Dia da entrega mais recente que este destino confirmou com sucesso. Se estiver muito atrás da data de hoje, é sinal de que algo está impedindo o envio há um tempo — veja a aba Falhas.',
  'falhas-taxa-sucesso-destino': 'Percentual de entregas bem-sucedidas a este destino. A granularidade é diária (não uma janela rolante de 24h) — "hoje" soma as entregas do dia corrente, "7d" soma os últimos 7 dias corridos.',
  'falhas-gravidade': 'Crítica: nada será entregue até corrigir. Atenção: parte dos eventos falha, mas o destino segue funcionando. Informativa: não é um erro — é um comportamento esperado do sistema (ex.: consentimento negado), por isso aparece em verde, não em vermelho.',
  'falhas-incluir-pulados': 'Por padrão a lista mostra só falhas de verdade (erro/morto). Marque para incluir também os eventos que o sistema decidiu não enviar de propósito (consentimento negado, sem mapeamento) — útil para auditoria, mas raramente exige ação.',
  'falhas-reenviar-todos': 'Reenvia, em sequência, todos os eventos deste grupo pela mesma fila usada no reenvio manual da aba Logs. Se o grupo tiver mais entregas do que o teto de um lote, um aviso explica que só as carregadas nesta tela foram reenviadas — repita a ação depois para tratar o restante.',
  'google-rota': 'GA4 Measurement Protocol envia eventos para o Google Analytics (mais simples, só precisa de Measurement ID e API Secret). Google Ads API envia direto para a conta de anúncios como conversão, com Enhanced Conversions — exige OAuth2 completo e developer token aprovado.',
  'google-oauth-completo': 'Conjunto de credenciais que autoriza este servidor a enviar conversões pela API do Google Ads: OAuth Client ID, Client Secret, Refresh Token e Developer Token. Falta qualquer um deles e o envio falha na troca de token, antes mesmo de tentar a conversão.',

  // ---------------- Dashboard — faixas 2 a 5 ----------------
  'dash-serie-temporal': 'Quantidade de eventos por dia, empilhados por tipo, com a receita de compras do dia na linha do eixo direito. Use o controle deslizante embaixo do gráfico para recortar um trecho do período sem mudar o filtro.',
  'dash-receita-utm': 'Receita de compras somada por origem de campanha (utm_source). Clique numa barra para abrir as campanhas (utm_campaign) daquela origem — é o gráfico para achar qual campanha de fato está vendendo, não só gerando clique.',
  'dash-qualidade-atribuicao': 'Quantos eventos do dia chegaram com o cookie/parâmetro de clique da Meta (fbc/fbclid) contra quantos chegaram sem. O donut ao lado, dentro do cartão de EMQ, resume a cobertura média de todos os campos de correspondência.',
  'dash-funil': 'Quantos eventos passaram por cada etapa configurada e qual fração chegou vindo da etapa anterior. Uma queda grande entre duas etapas é o primeiro lugar a olhar quando a conversão cai.',
  'dash-entregas-destino': 'Status das tentativas de entrega a cada destino por dia: sucesso, erro (será tentado de novo) e morto (parou de tentar). A latência média e os erros mais comuns de cada destino aparecem em texto abaixo do gráfico.',
  'dash-sem-atribuicao': 'Compras que fecharam sem nenhum identificador de clique (fbc/fbclid nem gclid) — chegam à plataforma de anúncio sem chance de serem ligadas a uma campanha específica. Esta lista é sempre sobre compras, mesmo que o filtro de evento no topo da tela esteja em outro tipo de evento.',

  // ---------------- Ao vivo (F6) ----------------
  'aovivo-indicador': '"● ao vivo" é a conexão de tempo real funcionando de verdade. "○ reconectando" é uma queda temporária — o navegador está tentando religar sozinho. "polling" é o modo de reserva: depois de algumas falhas seguidas, o painel passa a buscar eventos novos a cada 10 segundos em vez de recebê-los na hora.',
  'aovivo-selos-identificadores': 'Mostra, para este evento específico, se o cookie/parâmetro de clique chegou junto: fbc e fbp são da Meta, gclid é do Google Ads. "?" aparece só no modo polling, quando o painel não tem acesso ao payload completo do evento.',
  'aovivo-destinos-card': 'Status da entrega deste evento para cada destino, atualizado assim que a fila processa: enviando, entregue, ou falhou (tentando de novo ou já parou de tentar). Um destino sem nenhuma marca ainda não teve nenhuma tentativa registrada.',
  'aovivo-pausar-feed': 'Pausa a rolagem automática do feed sem perder nenhum evento — os que chegarem enquanto estiver pausado ficam contados no botão "N novos" e aparecem assim que você clicar nele ou retomar.',
  'cfg-avatar-upload': 'A foto é recortada ao quadrado, redimensionada para 256×256 e comprimida no seu próprio navegador antes de ser enviada — sem esse processamento, uma foto de celular moderno passaria fácil dos 128 KB que o servidor aceita.',
  'cfg-trocar-senha': 'Envia para o seu e-mail cadastrado um link de redefinição de senha (o mesmo fluxo de "esqueci minha senha" da tela de login). Nenhuma senha nova é definida aqui diretamente — é preciso abrir o link recebido.',
  'notif-destinatario-externo': 'Uma pessoa externa recebe e-mails deste sistema (falhas, resumos, alertas) sem nunca ganhar acesso ao painel — não existe login nem senha para ela, só um endereço de e-mail cadastrado e as notificações escolhidas.',
  'notif-tipo-entrega_morta': 'Avisa quando conversões esgotam as tentativas de envio e vão para a fila morta de um projeto. Chega agrupado — no máximo um e-mail por projeto a cada 30 minutos, listando tudo que morreu na janela.',
  'notif-tipo-falha_recorrente': 'Avisa quando um destino (Meta, Google ou postback) acumula muitos erros seguidos em pouco tempo, e manda um segundo e-mail quando o destino volta ao normal.',
  'notif-tipo-fila_acumulada': 'Avisa quando a fila de entrega represa por mais de 15 minutos — sinal de que o worker parou ou um destino está fora do ar. É um alerta de sistema, não de um projeto específico, por isso não tem seletor de projeto.',
  'notif-tipo-dominio_problema': 'Avisa quando um domínio ativo do painel para de resolver no DNS ou o certificado TLS falha ao emitir ou renovar.',
  'notif-tipo-resumo_diario': 'Todo dia às 08h, um resumo por e-mail com eventos, compras, receita e taxa de entrega do dia anterior.',
  'notif-tipo-resumo_semanal': 'Toda segunda às 08h, o mesmo resumo da semana anterior, comparado com a semana retrasada.',

  // ---------------- Webhook Studio (F4/F5) — inbox, editor de mapeamento e modo IA ----------------
  'studio-amostra-webhook': 'Um webhook chegou num formato que nenhum adaptador (nativo ou configurado aqui) reconheceu. O corpo fica guardado, com e-mail/telefone/nome já mascarados, só para servir de base ao mapeamento — ele nunca vira evento nem sai para nenhum destino sozinho.',
  'studio-deteccao': 'Como o servidor decide, sozinho, que um webhook futuro pertence a este formato: todas as chaves "obrigatórias" precisam estar presentes (E), e se houver alguma em "qualquer uma" basta uma delas aparecer (OU). Poucas chaves (menos de 2 no total) fazem este adaptador "roubar" webhooks que na verdade são de outro formato.',
  'studio-evento-bloco': 'Como o nome do evento canônico (o mesmo que Meta/Google recebem, ex.: "purchase", "lead") é decidido a partir do valor bruto que o webhook manda. O dicionário faz a tradução; a condição de pagamento (abaixo) é o único outro jeito de chegar a "purchase" sem uma entrada literal do dicionário.',
  'studio-regra-dura-purchase': 'Trava que o servidor aplica sempre, não só nesta tela: nenhum mapeamento consegue produzir o evento "purchase" sem uma confirmação explícita — uma entrada do dicionário que mapeia literalmente para "purchase", ou a condição de pagamento batendo. Um mapeamento que tente contornar isso (ex.: "purchase" no lado "se NÃO pago") é recusado ao salvar, com a explicação exata do que está errado.',
  'studio-transf-texto': 'Copia o valor de origem como veio, só convertendo para texto (número/booleano viram string). É a transformação padrão quando o campo não precisa de nenhum tratamento.',
  'studio-transf-numero': 'Converte o valor de origem para número. Se não for um número válido, o campo de destino fica vazio em vez de gravar um valor quebrado.',
  'studio-transf-centavos-para-reais': 'Divide o valor por 100 — para quando a origem manda o valor em centavos (ex.: 19990) e o destino espera reais (199.90). Errar essa transformação é a causa mais comum de "receita" 100x maior ou menor que o real.',
  'studio-transf-separar-nome': 'Recebe um nome completo (ex.: "Maria Silva") e separa em primeiro nome/sobrenome, gravando os dois de uma vez. Por isso não tem um "para" único: o destino é a base (ex.: "user_data"), e "first_name"/"last_name" são acrescentados por baixo dele automaticamente.',
  'studio-transf-unix-de-iso': 'Converte uma data em texto (ISO 8601, ex.: "2026-08-13T10:00:00Z") para timestamp Unix (segundos desde 1970) — é o formato que event_time e datas de evento esperam.',
  'studio-transf-booleano': 'Interpreta valores como "sim"/"não", "true"/"false" ou "1"/"0" e grava um booleano de verdade. Um valor que não bate com nenhum desses formatos fica vazio em vez de virar um booleano adivinhado.',
  'studio-transf-constante': 'Grava sempre o MESMO valor fixo, independente do que veio na amostra — não lê nenhum campo de origem (por isso esta é a única transformação sem "de"). Útil para um valor que a origem nunca manda mas que você sabe que é sempre o mesmo (ex.: currency = "BRL").',
  'studio-transf-mapear-valores': 'Traduz um valor de origem para outro usando um dicionário (chave = valor bruto, valor = o que deve ser gravado). Um valor "padrão" opcional cobre o que não estiver no dicionário — sem ele, um valor não mapeado fica vazio.',
  'studio-transf-primeiro-preenchido': 'Tenta, em ordem, uma lista de caminhos de origem e usa o primeiro que não estiver vazio (ex.: "sessionId" se existir, senão "customerReference"). O campo "de" aqui é uma lista, um caminho por linha — não um único caminho.',
  'studio-transf-ip-publico': 'Copia o IP só se ele for um IP PÚBLICO — descarta automaticamente IPs de rede privada (ex.: 10.x, 192.168.x, 127.0.0.1), que não servem para geolocalização nem correspondência e não devem ser enviados como IP do visitante.',
  'studio-transf-minusculo': 'Converte o texto para minúsculo, sem espaços nas pontas. A Meta e o Google exigem e-mail em minúsculo antes de hashear — use aqui quando a origem manda o e-mail com maiúsculas.',
  'studio-transf-apenas-digitos': 'Remove tudo que não for dígito (mantém só 0-9) — útil para telefone/CPF/CNPJ que a origem manda formatado (com parênteses, traço, espaço).',
  'studio-transf-ga-client-id': 'Extrai o Client ID do GA4 de dentro do cookie bruto "_ga" (formato "GA1.1.<id>.<timestamp>"), descartando o resto. Use quando a origem manda o cookie inteiro em vez de só o ID.',
  'studio-transf-marcador-presenca': 'Grava um valor fixo SE o campo de origem não estiver vazio (e outro valor fixo, opcional, se estiver vazio) — não copia o conteúdo do campo, só marca a presença dele. Ex.: content_type = "product" apenas quando a lista de produtos não é vazia.',
  'studio-transf-contagem': 'Grava o TAMANHO de uma lista de origem (ex.: quantos itens tem em "produtos") em vez do conteúdo dela — útil para campos como num_items.',
  'studio-modo-sombra': 'Um adaptador em modo Sombra roda por 24h só OBSERVANDO: calcula o que teria feito com cada webhook real, mas não altera nada nem envia nada a nenhum destino. Use antes de marcar "Ativo" de verdade, para confirmar que o mapeamento se comporta como esperado com tráfego real.',
  'studio-modo-ia-por-evento': 'Modo avançado em que CADA webhook real (não só a configuração) passa pela IA para ser traduzido, em vez de usar um mapeamento salvo e fixo. Tem custo por evento, latência adicional, envia dados a um terceiro (PII já hasheada antes) e o resultado não é determinístico — por isso exige aceite explícito antes de ser habilitado.',
  'studio-chave-openrouter': 'Chave de API da OpenRouter (openrouter.ai), usada só pelo SERVIDOR para chamar a IA — o navegador nunca fala com a OpenRouter. Fica cifrada em repouso e nunca é reexibida no painel; deixe o campo em branco para manter a chave já salva.',
  'studio-custo-ia': 'Cada chamada à IA (para rascunhar um mapeamento, ou para cada evento no modo "IA por evento") é cobrada pela OpenRouter e sai no seu saldo lá. O custo de cada chamada aparece junto com o resultado, e o total do mês corrente fica sempre visível nesta tela.',

  // ---- Dashboard: funil de dinheiro ----
  // O texto de 'kpi-pix-abandonado' é reescrito a cada render por
  // dashFunilAjudaPix(), conforme o método que o servidor conseguiu usar.
  'kpi-vendas': 'Compras confirmadas no período (evento purchase): a quantidade e a soma dos valores. É a única métrica desta tela que representa dinheiro que entrou de fato — todas as outras medem o caminho até ela.',
  'kpi-page-views': 'Visualizações de página recebidas no período (evento page_view). É o topo do funil: uma queda brusca aqui costuma ser problema de instalação da tag, não de campanha.',
  'kpi-checkouts-iniciados': 'Quantas vezes alguém começou o checkout no período (evento begin_checkout). Comparado com as vendas, mostra quanta gente chegou a tirar a carteira do bolso.',
  'kpi-checkouts-abandonados': 'Derivado: checkouts iniciados menos compras, dentro do MESMO período do filtro, com piso zero. Não usa janela por sessão — se o checkout começou antes do período e a compra fechou dentro dele, a conta chega a zero em vez de negativo. Para uma leitura mais justa, amplie o período no filtro.',
  'kpi-pix-gerados': 'Cobranças pix criadas no período (evento pix_gerado): quantidade e soma dos valores. Pix gerado não é dinheiro em caixa — é intenção de pagar, que só vira venda quando o purchase chega.',
  // Reescrito a cada render pelo método realmente usado (ver dashFunilAjudaPix).
  'kpi-pix-abandonado': 'Soma do valor dos pix gerados que não viraram compra no período.',
};

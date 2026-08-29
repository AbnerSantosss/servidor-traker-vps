---
title: Mensagem para o Rauny — pedidos de infra
tags: [infra, comunicacao, oracle-cloud, dns, git, servidor-traker]
created: 2026-08-12
updated: 2026-08-12
---

# Mensagem para o Rauny — pedidos de infra

Textos prontos para copiar e colar. Escolha o cenário, copie o bloco, ajuste o que estiver
`ASSIM` e mande.

**Contexto:** o Rauny é quem cuida da infra da Código Vencedor. Ele já definiu que o serviço
fica na **Oracle (OCI)** e já respondeu sobre o DNS: *"Sim, só me manda para onde essa entrada
vai apontar"*. Ou seja, ele cria o registro — falta a gente dizer o alvo.

**A ordem importa.** O IP só existe depois de a instância ser criada, então não dá para pedir
o DNS junto. A sequência real é:

```
1. Instância criada + IP reservado   →  2. Abner recebe o IP  →  3. Rauny cria o A record
```

Por isso os cenários A e B abaixo pedem tudo menos o DNS, e o **cenário C** é a mensagem de
follow-up com o IP em mãos.

---

## Cenário A — pedido completo (o Rauny cria tudo)

Use quando o Rauny for provisionar a instância. É o caminho mais provável.

> Rauny, beleza? Sobre o servidor de tracking (o "servidor Traker") — como você falou que o
> que é serviço da empresa fica na Oracle, montei o pedido já nesse formato. São 4 coisas:
>
> **1) Instância de Compute na OCI**
> - Shape: **VM.Standard.A1.Flex (Ampere/ARM)** — está no Always Free
> - **2 OCPU / 8 GB de RAM**
> - Imagem: **Ubuntu 22.04 ou 24.04 LTS**
> - Boot volume: **100 GB**
> - Subnet pública, com IP público
>
> Se a A1 der "out of host capacity" e não rolar insistir, pode ir de **VM.Standard.E5.Flex
> (x86) 2 OCPU / 8 GB** — nesse caso é paga, então me avisa antes que eu confirmo aqui. A app
> roda igual nas duas, é só uma questão de a imagem Docker precisar ser buildada na própria
> máquina no caso do ARM (o que eu faço).
>
> **2) IP público RESERVADO (não efêmero)**
> Precisa ser reservado mesmo, porque o DNS vai apontar direto pro IP. Se for efêmero e o IP
> mudar, o domínio quebra, os eventos param de chegar e o certificado SSL para de renovar —
> e a gente só descobre quando alguém reclamar de conversão sumida.
>
> **3) Portas 80 e 443 liberadas — nas duas camadas**
> - Na **Security List / NSG da VCN**: ingress TCP 80 e 443, source `0.0.0.0/0`
> - No **firewall do próprio Ubuntu**: as imagens da Oracle vêm com iptables persistente
>   liberando só a 22, e o `ufw` não mostra essas regras. Se quiser, eu faço essa parte por
>   SSH — é só me passar o acesso. Só sinalizo porque é o erro clássico: fica tudo aberto na
>   console e o serviço não responde mesmo assim.
>
> (A 80 é obrigatória, não é só redirect — é por ela que o Let's Encrypt valida o domínio pra
> emitir o certificado.)
>
> **4) Repositório git**
> Um repo privado pro projeto, pode chamar `servidor-traker`. Me dá acesso de escrita. Se
> preferir que o servidor puxe o código com **deploy key read-only** em vez de credencial de
> usuário, eu gero a chave na máquina e te mando a pública.
>
> **O que eu preciso de volta:**
> - o **IP público reservado**
> - **acesso SSH** (te mando minha chave pública, ou me diz o usuário se você já cadastrou)
> - a **URL do repositório**
>
> Assim que eu tiver o IP eu te mando a entrada de DNS pra criar — vai ser um registro **A**
> de `traker.codigovencedor.com` apontando pra ele. Valeu!

---

## Cenário B — versão curta

Quando já rolou conversa e ele só quer o resumo do pedido.

> Rauny, pro servidor Traker na Oracle:
>
> - Instância **Ampere A1 (ARM), 2 OCPU / 8 GB, Ubuntu 24.04 LTS**, disco 100 GB — se a A1
>   não tiver capacidade, E5.Flex x86 2/8 (paga, me avisa antes)
> - **IP público reservado** (não efêmero — o DNS vai apontar pra ele)
> - **Portas 80 e 443** liberadas na Security List/NSG **e** no iptables do Ubuntu (a imagem
>   da Oracle bloqueia tudo menos a 22 por padrão — se quiser eu faço essa parte por SSH)
> - Repo git privado `servidor-traker` com acesso pra mim
>
> Me manda de volta: **IP + acesso SSH + URL do repo**. Com o IP em mãos eu te passo a
> entrada de DNS (registro **A** de `traker.codigovencedor.com`).

---

## Cenário C — pedido do DNS (mandar DEPOIS, com o IP em mãos)

Esta é a resposta ao *"só me manda para onde essa entrada vai apontar"*.

> Rauny, o IP saiu. A entrada de DNS é essa:
>
> ```
> Nome:  traker
> Zona:  codigovencedor.com
> Tipo:  A
> Valor: COLOQUE_AQUI_O_IP_RESERVADO
> TTL:   300
> ```
>
> (Ou seja: `traker.codigovencedor.com` → `COLOQUE_AQUI_O_IP_RESERVADO`.)
>
> Só isso, não precisa de CNAME nem TXT. Deixei TTL 300 pra facilitar caso precise ajustar
> nos primeiros dias; depois pode subir pra 3600.
>
> **Se o DNS estiver na Cloudflare, deixa o proxy DESLIGADO** (nuvem cinza / "DNS only"). Com
> o proxy ligado, quem termina o SSL é a Cloudflare e o certificado do nosso servidor não
> consegue ser emitido — além de o IP real do visitante não chegar direito, que é justamente
> o dado que preciso preservar.
>
> Me avisa quando criar que eu já subo o serviço e valido o certificado. Valeu!

---

## Cenário D — o Abner cria a instância, o Rauny só dá acesso

Se a empresa preferir que quem monta seja você.

> Rauny, consegue me dar acesso na console da OCI pra eu subir o servidor Traker? Precisaria
> de:
>
> - permissão pra **criar instância de Compute** e **reservar IP público** no compartimento
>   `NOME_DO_COMPARTIMENTO`
> - permissão pra **editar Security List / NSG** da VCN (só as portas 80 e 443)
> - saber qual VCN/subnet eu devo usar, e se vocês usam **Security List ou NSG** como padrão
>   (pra eu não configurar no lugar errado)
>
> Também vou precisar de um **bucket no Object Storage** (`traker-backups`, privado) pros
> backups do banco. O jeito certo de autorizar é por *instance principal*, que precisa de IAM
> — aí depende de você:
>
> ```
> Dynamic Group: ALL {instance.id = 'OCID_DA_INSTANCIA'}
> Policy: Allow dynamic-group traker-servers to manage objects in compartment COMPARTIMENTO
>         where target.bucket.name='traker-backups'
> ```
>
> Assim o servidor sobe os backups sozinho sem eu guardar chave nenhuma no disco dele.
>
> E o repo git privado `servidor-traker` com acesso pra mim, quando der. Valeu!

---

## Checklist — o que preciso receber de volta

Marque conforme for chegando. **Enquanto os três primeiros não estiverem completos, não dá
para subir nada.**

- [ ] **IP público reservado** — `___.___.___.___`
      → confirmar que é *reservado*, não efêmero (console: Networking → IP Management)
- [ ] **Acesso SSH** — usuário (normalmente `ubuntu`) + minha chave pública cadastrada
      → testar: `ssh ubuntu@IP` deve entrar sem pedir senha
- [ ] **URL do repositório git** — `___________________`
      → testar: `git clone URL` funciona
- [ ] **Confirmação de que a instância é ARM ou x86**
      → conferir na VM: `uname -m` (`aarch64` = ARM, `x86_64` = Intel/AMD)
- [ ] **Portas 80/443 abertas na Security List/NSG**
      → testar do meu computador: `nc -vz IP 80` e `nc -vz IP 443`
- [ ] **Firewall do SO liberado** (eu faço, se tiver SSH)
      → conferir na VM: `sudo iptables -L INPUT -n --line-numbers`
- [ ] **Registro DNS A criado** (depois de mandar o cenário C)
      → testar: `dig +short traker.codigovencedor.com` devolve o IP
- [ ] *(opcional)* bucket `traker-backups` + dynamic group/policy para os backups

---

## Perguntas que ele provavelmente vai fazer

Respostas curtas para você mandar na hora, sem precisar voltar aqui para estudar.

**"Por que ARM e não x86?"**
> Porque a Ampere A1 está no Always Free da Oracle (até 4 OCPU / 24 GB) e dá conta de sobra.
> A app é Node + Postgres + Caddy, todas com imagem oficial multi-arch, então roda igual. O
> único cuidado é buildar a imagem na própria máquina, que é o que eu vou fazer. Se der
> problema de capacidade, a gente vai de x86 sem drama.

**"Por que precisa de IP reservado?"**
> Porque o DNS aponta direto pro IP. Se ele for efêmero e mudar, o domínio quebra, os eventos
> param de chegar e o certificado para de renovar — e ainda vira pedido de mudança de DNS pra
> você toda vez. Reservado custa nada e resolve de vez.

**"Por que a porta 80 se o site é HTTPS?"**
> O Let's Encrypt valida o domínio pela porta 80 (desafio HTTP-01) antes de emitir e a cada
> renovação. Sem ela, não sai certificado. A 80 em si só faz redirect pra 443.

**"Precisa de banco gerenciado / Redis / load balancer?"**
> Não. Postgres roda em container na mesma máquina, a fila é feita dentro do próprio Postgres
> (sem Redis) e o Caddy faz o papel de proxy e SSL. Uma VM só, quatro containers. Se um dia
> escalar, a gente separa o banco — mas hoje é overkill.

**"Quanto de recurso isso consome?"**
> 2 OCPU / 8 GB com folga confortável pro volume atual. O que cresce com o tempo é disco
> (histórico de eventos), e por isso pedi 100 GB — tem expurgo automático configurado em 90
> dias.

**"O acesso vai ser só seu?"**
> Por enquanto sim, mas o acesso é por chave SSH e o painel tem login próprio. Se quiser sua
> chave cadastrada também, é só mandar a pública.

---

## Ver também

- `02-deploy-oracle-cloud.md` — o que fazer depois que ele responder.
- `03-dns-tls-subdominio.md` — detalhe técnico do DNS e do certificado.

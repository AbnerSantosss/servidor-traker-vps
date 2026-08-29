# Índice da documentação

Esta pasta veio inteira do monorepo de desenvolvimento. Nem todo documento se
aplica a este repositório, que existe só para o deploy no homelab atrás de
Cloudflare Tunnel. A coluna abaixo diz em que estado cada um está.

| Documento | Vale aqui? |
|---|---|
| [00-visao-geral.md](00-visao-geral.md) | ✅ sim |
| [01-arquitetura.md](01-arquitetura.md) | ✅ sim — a arquitetura da aplicação não mudou |
| [02-deploy-oracle-cloud.md](02-deploy-oracle-cloud.md) | ⚠️ histórico — descreve VM com IP público e Let's Encrypt. Substituído pelo 17 |
| [03-dns-tls-subdominio.md](03-dns-tls-subdominio.md) | ⚠️ histórico — pressupõe TLS sob demanda, que não opera atrás do túnel |
| [04-tagueamento-meta.md](04-tagueamento-meta.md) | ✅ sim |
| [05-tagueamento-google-ads.md](05-tagueamento-google-ads.md) | ✅ sim |
| [06-operacao-runbook.md](06-operacao-runbook.md) | ⚠️ parcial — a operação da aplicação vale; os comandos de VM/SSH viram Portainer |
| [07-referencia-api.md](07-referencia-api.md) | ✅ sim |
| [08-mensagem-para-o-rauny.md](08-mensagem-para-o-rauny.md) | ❌ histórico — pedido de infra para a Oracle Cloud da empresa |
| [09-usuarios-e-email.md](09-usuarios-e-email.md) | ✅ sim |
| [10-separacao-front-back.md](10-separacao-front-back.md) | ⚠️ histórico — a separação em dois repos era para as pipelines do Azure DevOps |
| [11-onde-colocar-cada-coisa.md](11-onde-colocar-cada-coisa.md) | ✅ sim |
| [12-deploy-zyraflow.md](12-deploy-zyraflow.md) | ⚠️ parcial — a decisão webhook-first e o domínio valem; a parte de OCI não |
| [13-plano-admin-master.md](13-plano-admin-master.md) | ✅ sim |
| [14-repos-azure.md](14-repos-azure.md) | ❌ histórico — dois repositórios no Azure DevOps, substituído por este repo único |
| [15-convencoes-do-painel.md](15-convencoes-do-painel.md) | ✅ sim |
| [16-catalogo-xwinner-e-n8n.md](16-catalogo-xwinner-e-n8n.md) | ✅ sim |
| [17-deploy-homelab-cloudflare.md](17-deploy-homelab-cloudflare.md) | ✅ **é o guia de deploy deste repositório** |

Onde um documento histórico contradisser o 17, o **17 vence**. Eles foram mantidos
porque explicam decisões de produto e de tagueamento que continuam válidas — e
porque apagar contexto costuma custar mais caro do que marcá-lo como histórico.

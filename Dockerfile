# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Servidor Traker — imagem de producao
#
# Build multi-stage: o estagio "deps" resolve as dependencias e o estagio final
# so recebe a pasta node_modules pronta. Isso evita levar cache do npm, toolchain
# de compilacao e arquivos de lock para a imagem final.
#
# Nao ha nada especifico de arquitetura aqui (sem binarios baixados a mao, sem
# --platform fixo), entao a mesma receita compila em x86_64 e em ARM64 (Ampere
# da Oracle Cloud). O driver `pg` e JavaScript puro, entao nao exige toolchain
# nativo em nenhuma das duas.
# ---------------------------------------------------------------------------

# ------------------------- Estagio 1: dependencias -------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Copiamos apenas os manifests antes de instalar: enquanto package.json e o lock
# nao mudarem, o Docker reaproveita a camada de node_modules e o build fica quase
# instantaneo mesmo depois de alterar codigo em src/.
# O `package-lock.json*` usa curinga para o COPY nao falhar enquanto o lock ainda
# nao foi commitado no repositorio.
COPY package.json package-lock.json* ./

# `npm ci` e o comando correto para producao: instala exatamente o que esta no
# lock (build reproduzivel) e apaga node_modules antes, evitando estado sujo.
# Ele exige o lockfile; o fallback para `npm install` existe apenas para o
# periodo em que o package-lock.json ainda nao foi versionado. Assim que o lock
# entrar no git, este if sempre cai no ramo do `npm ci`.
RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev; \
    else \
        echo "AVISO: package-lock.json ausente — usando npm install (build nao reproduzivel)"; \
        npm install --omit=dev; \
    fi \
    && npm cache clean --force

# --------------------------- Estagio 2: runtime ----------------------------
FROM node:22-alpine AS runtime

# NODE_ENV=production muda o comportamento do Express (view cache ligado, stack
# traces fora das respostas de erro) e e lido pelo src/config/env.js para exigir
# o APP_SECRET. PORT fica explicito para o HEALTHCHECK ter um padrao coerente.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# A imagem oficial do Node ja traz o usuario nao-root `node` (uid 1000). Rodar
# como root dentro do container e desnecessario aqui — a aplicacao so precisa ler
# os proprios arquivos e abrir uma porta alta (3000, acima de 1024).
# O --chown no COPY evita um `chown -R` extra, que duplicaria o tamanho da camada.
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=deps /app/node_modules ./node_modules

# Copiamos so o que a aplicacao precisa em runtime. docs/, test/ e afins ficam de
# fora tanto por este COPY seletivo quanto pelo .dockerignore.
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node gtm ./gtm

USER node

EXPOSE 3000

# Healthcheck via `fetch` global do Node 22 em vez de curl/wget: nao adiciona
# pacote nenhum a imagem e funciona igual nas duas arquiteturas. Bate em 127.0.0.1
# de proposito (o teste e do processo, nao da rede externa) e le PORT em tempo de
# execucao, entao continua correto mesmo se a porta for sobrescrita no compose.
# O start-period da folga para a primeira conexao com o Postgres antes de comecar
# a contar falhas.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]

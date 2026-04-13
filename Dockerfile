FROM node:20-bookworm
WORKDIR /app

SHELL ["/bin/bash", "-c"]

RUN sed -i 's/deb.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list.d/debian.sources \
  && sed -i 's/security.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 make g++ bash dash ca-certificates cmake git \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /bin/dash /bin/sh

RUN npm config set registry https://registry.npmmirror.com

ENV ONNXRUNTIME_NODE_SKIP_DOWNLOAD=1
ENV npm_config_python=python3

RUN git config --global url."https://github.com/".insteadOf git@github.com:

COPY docker/start.sh /app/docker/start.sh
COPY gitnexus-shared /app/gitnexus-shared
COPY gitnexus /app/gitnexus
COPY gitnexus-web /app/gitnexus-web

RUN chmod +x /app/docker/start.sh \
  && cd /app/gitnexus-shared \
  && npm ci \
  && npm run build \
  && cd /app/gitnexus \
  && npm ci --omit=optional --ignore-scripts \
  && echo "console.log('skipped')" > /app/gitnexus/node_modules/@ladybugdb/core/install.js \
  && echo "console.log('skipped')" > /app/gitnexus/node_modules/onnxruntime-node/script/install \
  && npm rebuild --prefix /app/gitnexus \
  && cd /app/gitnexus-web \
  && npm ci --ignore-scripts

EXPOSE 4747 5173
CMD ["/app/docker/start.sh"]

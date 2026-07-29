FROM node:22-bookworm-slim

ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ENV DEBIAN_FRONTEND=noninteractive
RUN sed -i "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git libgl1 libglib2.0-0 python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN python3 -m pip install --break-system-packages --no-cache-dir --no-deps --index-url "${PYTORCH_INDEX_URL}" torch==2.4.1+cpu torchvision==0.19.1+cpu
COPY worker/requirements-cpu.txt ./worker/requirements-cpu.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir --index-url "${PYPI_INDEX_URL}" -r worker/requirements-cpu.txt
COPY tsconfig*.json ./
COPY server ./server
COPY shared ./shared
COPY worker ./worker
CMD ["npm", "run", "start:worker"]

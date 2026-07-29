FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git libgl1 libglib2.0-0 python3 python3-pip && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY worker/requirements.txt ./worker/requirements.txt
RUN python3 -m pip install --no-cache-dir -r worker/requirements.txt
COPY tsconfig*.json ./
COPY server ./server
COPY shared ./shared
COPY worker ./worker
CMD ["npm", "run", "start:worker"]

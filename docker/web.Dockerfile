FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=http://localhost:4000/api/v1
ENV VITE_API_ENABLED=true
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 5173
CMD ["./node_modules/.bin/vite", "preview", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

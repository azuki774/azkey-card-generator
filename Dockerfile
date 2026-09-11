FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS fonts

RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk fontconfig \
  && rm -rf /var/lib/apt/lists/*

FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM gcr.io/distroless/nodejs24-debian13:nonroot

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV FONTCONFIG_FILE=/app/fontconfig/fonts.conf
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY templates ./templates
COPY public ./public
COPY fontconfig ./fontconfig
COPY --from=fonts /usr/share/doc/fonts-noto-cjk/copyright /usr/share/doc/fonts-noto-cjk/copyright
COPY --from=fonts /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
COPY --from=fonts /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc
COPY assets ./assets
COPY package.json ./

USER nonroot
EXPOSE 3000
CMD ["dist/server.js"]

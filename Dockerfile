FROM node:22-bookworm-slim
RUN npx -y playwright install-deps chromium
WORKDIR /app
COPY package*.json ./
RUN npm install grammy sharp mathjax-full playwright markdown-it katex mermaid highlight.js texlyre-busytex pdfjs-dist
RUN npx playwright install chromium
COPY . .
CMD ["node", "--enable-source-maps", "/app/main.js"]
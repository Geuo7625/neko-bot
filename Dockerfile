FROM node:22-bookworm-slim 

# 1. 安装系统依赖、构建编译工具（支持原生 Node 插件编译）和 Playwright 浏览器依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    && npx -y playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# 设置 Transformers.js 的模型缓存路径（默认在 /app/.cache/huggingface）
ENV HF_HOME=/app/.cache/huggingface

WORKDIR /app 

# 2. 先复制依赖清单
COPY package*.json ./ 

# 3. 安装 NPM 依赖（已加入 @huggingface/transformers）
RUN npm install grammy sharp mathjax-full playwright markdown-it katex mermaid highlight.js texlyre-busytex pdfjs-dist @lancedb/lancedb @huggingface/transformers

RUN npx playwright install chromium 

# 4. 复制业务代码
COPY . . 

CMD ["node", "--enable-source-maps", "/app/main.js"]

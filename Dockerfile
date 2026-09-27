FROM node:22-bookworm-slim 

# 1. 安装系统依赖和 Playwright 浏览器
RUN npx -y playwright install-deps chromium 

WORKDIR /app 

# 2. 先只复制依赖文件
COPY package*.json ./ 

# 3. 执行安装（只要 package.json 没改，这一步以后构建直接命中缓存，0秒跳过！）
RUN npm install grammy sharp mathjax-full playwright markdown-it katex mermaid highlight.js texlyre-busytex pdfjs-dist @lancedb/lancedb 

RUN npx playwright install chromium 

# 4. 最后才复制业务代码（修改代码不会触发重新 npm install）
COPY . . 

CMD ["node", "--enable-source-maps", "/app/main.js"] 

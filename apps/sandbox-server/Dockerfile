# ── 构建阶段 ──
FROM node:20-slim AS builder

WORKDIR /build
COPY package.json ./
# 跳过浏览器下载，运行时使用 Playwright 镜像自带的浏览器
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx tsc

# ── 运行阶段 ──
FROM mcr.microsoft.com/playwright:v1.52.0-noble

# 浏览器路径环境变量（Playwright 镜像预装浏览器在此目录）
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 允许在构建时覆盖 pip 源，默认使用国内镜像以避免构建阶段长时间卡在依赖下载。
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10

# 安装 Python 运行时
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 文件处理库（Excel / Word / PPT / PDF / 图片）
RUN python3 -m pip install --break-system-packages --no-cache-dir --prefer-binary \
    --index-url ${PIP_INDEX_URL} \
    --trusted-host ${PIP_TRUSTED_HOST} \
    openpyxl \
    python-pptx \
    python-docx \
    pdfplumber \
    Pillow \
    requests \
    beautifulsoup4

# 复制构建产物和依赖
WORKDIR /sandbox
COPY --from=builder /build/dist ./dist/
COPY --from=builder /build/node_modules ./node_modules/
COPY package.json ./

# 复用 Playwright 基础镜像自带的非 root 用户，避免额外的用户创建步骤在不同环境下失败。
USER pwuser
WORKDIR /home/pwuser

EXPOSE 3100

CMD ["node", "/sandbox/dist/index.js"]

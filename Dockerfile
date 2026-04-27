FROM node:20-bookworm-slim

# Системные зависимости
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p storage/jobs storage/temp storage/output storage/fonts

# ── Inter (GitHub rsms/inter — статические TTF) ───────────────────────────────
RUN curl -sL "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip" -o /tmp/inter.zip \
    && unzip -q /tmp/inter.zip -d /tmp/inter \
    && find /tmp/inter -name "Inter-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Inter.ttf \
    && find /tmp/inter -name "Inter-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Inter-Bold.ttf \
    && rm -rf /tmp/inter.zip /tmp/inter

# ── Google Fonts — скачиваем файлы напрямую (variable fonts, работают как обычные TTF) ──
# Roboto
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf" \
        -o storage/fonts/Roboto.ttf \
    && cp storage/fonts/Roboto.ttf storage/fonts/Roboto-Bold.ttf

# Montserrat
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" \
        -o storage/fonts/Montserrat.ttf \
    && cp storage/fonts/Montserrat.ttf storage/fonts/Montserrat-Bold.ttf

# Oswald
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf" \
        -o storage/fonts/Oswald.ttf \
    && cp storage/fonts/Oswald.ttf storage/fonts/Oswald-Bold.ttf

# Raleway
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/raleway/Raleway%5Bwght%5D.ttf" \
        -o storage/fonts/Raleway.ttf \
    && cp storage/fonts/Raleway.ttf storage/fonts/Raleway-Bold.ttf

# Nunito
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito%5Bwght%5D.ttf" \
        -o storage/fonts/Nunito.ttf \
    && cp storage/fonts/Nunito.ttf storage/fonts/Nunito-Bold.ttf

# Bebas Neue (только Regular)
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf" \
        -o storage/fonts/BebasNeue.ttf \
    && cp storage/fonts/BebasNeue.ttf storage/fonts/BebasNeue-Bold.ttf

# Ubuntu (ufl лицензия, отдельные файлы Regular и Bold)
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntu/Ubuntu-Regular.ttf" \
        -o storage/fonts/Ubuntu.ttf \
    && curl -sL "https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntu/Ubuntu-Bold.ttf" \
        -o storage/fonts/Ubuntu-Bold.ttf
# ──────────────────────────────────────────────────────────────────────────────

EXPOSE 3000

CMD ["npm", "start"]

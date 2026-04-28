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

# ── Inter (статические TTF из rsms/inter v4.0, папка extras/ttf/) ────────────
# Family name: "Inter" — libass найдёт по имени "Inter" в ASS файле
RUN curl -sL "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip" -o /tmp/inter.zip \
    && unzip -q /tmp/inter.zip -d /tmp/inter \
    && cp /tmp/inter/extras/ttf/Inter-Regular.ttf storage/fonts/Inter.ttf \
    && cp /tmp/inter/extras/ttf/Inter-Bold.ttf    storage/fonts/Inter-Bold.ttf \
    && rm -rf /tmp/inter.zip /tmp/inter

# ── Google Fonts — СТАТИЧНЫЕ TTF (не variable) ───────────────────────────────
# Статичные файлы имеют корректный family name без осей [wdth,wght]
# libass ищет шрифт по family name внутри TTF, а не по имени файла

# Roboto — статичные файлы (family: "Roboto")
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/static/Roboto-Regular.ttf" \
        -o storage/fonts/Roboto.ttf \
    && curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/static/Roboto-Bold.ttf" \
        -o storage/fonts/Roboto-Bold.ttf

# Montserrat — статичные файлы из оригинального репозитория (family: "Montserrat")
# Файлы google/fonts содержат variable font с family "Montserrat Thin" — libass их не найдёт
RUN curl -sL "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Regular.ttf" \
        -o storage/fonts/Montserrat.ttf \
    && curl -sL "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Bold.ttf" \
        -o storage/fonts/Montserrat-Bold.ttf

# Oswald — статичные файлы (family: "Oswald")
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/static/Oswald-Regular.ttf" \
        -o storage/fonts/Oswald.ttf \
    && curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/static/Oswald-Bold.ttf" \
        -o storage/fonts/Oswald-Bold.ttf

# Raleway — статичные файлы через Google Fonts CDN (family: "Raleway")
# Файлы google/fonts содержат только variable font с family "Raleway Thin"
RUN curl -sL "https://fonts.gstatic.com/s/raleway/v37/1Ptxg8zYS_SKggPN4iEgvnHyvveLxVvaooCP.ttf" \
        -o storage/fonts/Raleway.ttf \
    && curl -sL "https://fonts.gstatic.com/s/raleway/v37/1Ptxg8zYS_SKggPN4iEgvnHyvveLxVs9pYCP.ttf" \
        -o storage/fonts/Raleway-Bold.ttf

# Nunito — статичные файлы через Google Fonts CDN (family: "Nunito")
# Файлы google/fonts содержат только variable font с family "Nunito ExtraLight"
RUN curl -sL "https://fonts.gstatic.com/s/nunito/v32/XRXI3I6Li01BKofiOc5wtlZ2di8HDLshRTM.ttf" \
        -o storage/fonts/Nunito.ttf \
    && curl -sL "https://fonts.gstatic.com/s/nunito/v32/XRXI3I6Li01BKofiOc5wtlZ2di8HDFwmRTM.ttf" \
        -o storage/fonts/Nunito-Bold.ttf

# Bebas Neue — только Regular (нет Bold варианта)
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf" \
        -o storage/fonts/BebasNeue.ttf \
    && cp storage/fonts/BebasNeue.ttf storage/fonts/BebasNeue-Bold.ttf

# Ubuntu — статичные файлы (ufl лицензия)
RUN curl -sL "https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntu/Ubuntu-Regular.ttf" \
        -o storage/fonts/Ubuntu.ttf \
    && curl -sL "https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntu/Ubuntu-Bold.ttf" \
        -o storage/fonts/Ubuntu-Bold.ttf
# ──────────────────────────────────────────────────────────────────────────────

EXPOSE 3000

CMD ["npm", "start"]

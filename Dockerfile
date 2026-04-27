FROM node:20-bookworm-slim

# Системные зависимости + curl + unzip для скачивания шрифтов
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

# ── Установка шрифтов ──────────────────────────────────────────────────────────
# Inter (extras/ttf/ внутри zip)
RUN curl -sL "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip" -o /tmp/inter.zip \
    && unzip -q /tmp/inter.zip -d /tmp/inter \
    && find /tmp/inter -name "Inter-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Inter.ttf \
    && find /tmp/inter -name "Inter-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Inter-Bold.ttf \
    && rm -rf /tmp/inter.zip /tmp/inter

# Roboto
RUN curl -sL "https://fonts.google.com/download?family=Roboto" -o /tmp/roboto.zip \
    && unzip -q /tmp/roboto.zip -d /tmp/roboto \
    && find /tmp/roboto -name "Roboto-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Roboto.ttf \
    && find /tmp/roboto -name "Roboto-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Roboto-Bold.ttf \
    && rm -rf /tmp/roboto.zip /tmp/roboto

# Montserrat
RUN curl -sL "https://fonts.google.com/download?family=Montserrat" -o /tmp/montserrat.zip \
    && unzip -q /tmp/montserrat.zip -d /tmp/montserrat \
    && find /tmp/montserrat -name "Montserrat-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Montserrat.ttf \
    && find /tmp/montserrat -name "Montserrat-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Montserrat-Bold.ttf \
    && rm -rf /tmp/montserrat.zip /tmp/montserrat

# Oswald
RUN curl -sL "https://fonts.google.com/download?family=Oswald" -o /tmp/oswald.zip \
    && unzip -q /tmp/oswald.zip -d /tmp/oswald \
    && find /tmp/oswald -name "Oswald-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Oswald.ttf \
    && find /tmp/oswald -name "Oswald-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Oswald-Bold.ttf \
    && rm -rf /tmp/oswald.zip /tmp/oswald

# Raleway
RUN curl -sL "https://fonts.google.com/download?family=Raleway" -o /tmp/raleway.zip \
    && unzip -q /tmp/raleway.zip -d /tmp/raleway \
    && find /tmp/raleway -name "Raleway-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Raleway.ttf \
    && find /tmp/raleway -name "Raleway-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Raleway-Bold.ttf \
    && rm -rf /tmp/raleway.zip /tmp/raleway

# Nunito
RUN curl -sL "https://fonts.google.com/download?family=Nunito" -o /tmp/nunito.zip \
    && unzip -q /tmp/nunito.zip -d /tmp/nunito \
    && find /tmp/nunito -name "Nunito-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Nunito.ttf \
    && find /tmp/nunito -name "Nunito-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Nunito-Bold.ttf \
    && rm -rf /tmp/nunito.zip /tmp/nunito

# Bebas Neue (только Regular — капсульный шрифт без Bold)
RUN curl -sL "https://fonts.google.com/download?family=Bebas+Neue" -o /tmp/bebas.zip \
    && unzip -q /tmp/bebas.zip -d /tmp/bebas \
    && find /tmp/bebas -name "BebasNeue-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/BebasNeue.ttf \
    && cp storage/fonts/BebasNeue.ttf storage/fonts/BebasNeue-Bold.ttf \
    && rm -rf /tmp/bebas.zip /tmp/bebas

# Ubuntu
RUN curl -sL "https://fonts.google.com/download?family=Ubuntu" -o /tmp/ubuntu.zip \
    && unzip -q /tmp/ubuntu.zip -d /tmp/ubuntu \
    && find /tmp/ubuntu -name "Ubuntu-Regular.ttf" | head -1 | xargs -I{} cp {} storage/fonts/Ubuntu.ttf \
    && find /tmp/ubuntu -name "Ubuntu-Bold.ttf"    | head -1 | xargs -I{} cp {} storage/fonts/Ubuntu-Bold.ttf \
    && rm -rf /tmp/ubuntu.zip /tmp/ubuntu
# ──────────────────────────────────────────────────────────────────────────────

EXPOSE 3000

CMD ["npm", "start"]

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p storage/jobs storage/temp storage/output storage/fonts

EXPOSE 3000

CMD ["npm", "start"]

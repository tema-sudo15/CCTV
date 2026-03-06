FROM node:18-slim

# Устанавливаем FFmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимости
COPY package*.json ./
RUN npm install --production

# Копируем всё
COPY . .

# Создаём директории
RUN mkdir -p hls recordings

EXPOSE 3000

CMD ["node", "server.js"]

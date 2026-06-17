FROM node:22-bookworm-slim

# Install Python 3, pip, compiler headers, and postgres dev libraries
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Link python3 to python
RUN ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /usr/src/app

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --break-system-packages -r requirements.txt

# Install Playwright Chromium dependencies and browser
RUN python -m playwright install chromium

# Copy backend source code
COPY . .

EXPOSE 4000

CMD ["node", "index.js"]

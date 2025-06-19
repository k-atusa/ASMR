# ASMR

## Docker Usage

### 1. Build the Image

```bash
docker build -t asmr-radio .
```

### 2. Run the Container

```bash
docker run -p 3001:3001 \
  -v $(pwd)/channels:/app/channels \
  asmr-radio
```

- `-p 3001:3001`: Maps port 3001 of your host to port 3001 in the container.
- `-v $(pwd)/channels:/app/channels`: Mounts your local `channels` folder to `/app/channels` in the container to persist audio files.

### 3. Access the Web Interface

Open your browser and go to [http://localhost:3001](http://localhost:3001)

---

## Local Run (without Docker)

```bash
npm install
node index.js
```
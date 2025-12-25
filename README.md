# ASMR

ASMR is a React + TypeScript single-page UI that monitors an Icecast server, shows the currently playing track metadata, and lets listeners jump directly into the live MP3 stream. The app periodically polls the Icecast `status-json.xsl` endpoint, displays stream-start timestamps and uptime in a dashboard-style layout, and exposes playback controls backed by the Icecast stream.

---

## Icecast Installation & Streaming Setup

The frontend expects a running Icecast + Liquidsoap stack. You can reproduce the stack outlined in [devleo.us/posts/icecast](https://devleo.us/posts/icecast/) with the following steps.

### 1. Project tree

```
.
├── config
│   ├── icecast.xml
│   └── liquidsoap.liq
├── docker-compose.yml
├── logs
└── music
		└── *.mp3
```

- `config/icecast.xml`: Icecast server configuration, authentication, and limits.
- `config/liquidsoap.liq`: Liquidsoap AutoDJ script.
- `music/`: Folder of MP3 assets that Liquidsoap will rotate through.
- `logs/`: Captures Liquidsoap run logs.

### 2. Compose stack

Create `docker-compose.yml`:

```yaml
services:
	icecast2:
		image: pltnk/icecast2
		container_name: icecast2
		restart: always
		ports:
			- 7000:8000
		volumes:
			- ./config/icecast.xml:/etc/icecast2/icecast.xml

	liquidsoap:
		image: savonet/liquidsoap:v2.2.3
		container_name: liquidsoap-player
		command: liquidsoap /config/liquidsoap.liq
		restart: unless-stopped
		depends_on:
			- icecast2
		volumes:
			- ./config/liquidsoap.liq:/config/liquidsoap.liq
			- ./music:/music
			- ./logs:/var/log/liquidsoap
```

### 3. Icecast config

`config/icecast.xml` closely follows the blog article. Customize the highlighted areas for your deployment:

- `<location>` / `<admin>`: Informational metadata.
- `<limits>`: Max clients, sources, and buffer sizes.
- `<authentication>`: Set unique credentials for `admin-user`, `admin-password`, `source-password`, and `relay-password`. Liquidsoap will use `source-password`.
- `<listen-socket>` / `<hostname>`: Ensure host/port match your networking needs (compose uses internal 8000, exposed on 7000).
- `<paths>` / `<logging>`: Keep defaults unless you need custom directories.

### 4. Liquidsoap script

Use this baseline for `config/liquidsoap.liq`:

```liquidsoap
set("log.file", "/var/log/liquidsoap/liquidsoap.log")
set("log.level", 3)

def silence()
	blank(duration=10.)
end

radio = playlist(mode="random", reload=3600, "/music")
radio = fallback(track_sensitive=false, [radio, silence()])

output.icecast(
	%mp3,
	host = "icecast2",
	port = 8000,
	password = "<source-password>",
	mount = "stream",
	name = "example radio",
	description = "An example radio station",
	genre = "Various",
	radio
)
```

Update `password`, `mount`, `name`, `description`, and `genre` to suit your station brand. Copy a few MP3 files into `music/`.

### 5. Launch & verify

```bash
docker compose up -d
```

- Visit `http://<server>:7000` → Icecast admin UI (`admin-user`/`admin-password`).
- Confirm `/stream` mount appears under **Mounts**.
- Test playback at `http://<server>:7000/stream`.

Once the stream is reachable, the ASMR frontend can proxy `/api/icecast-status` and `/api/icecast-stream` against this origin.

---

## Running the ASMR Frontend (Docker Compose)

1. **Environment variable**
	 - Duplicate `.env.example` as `.env` for local development, and set `ICECAST_BASE_URL` to the public origin of your Icecast server (e.g., `https://radio.example.com:7000`). During `npm run dev` this powers the Vite proxy; inside Docker it is injected at runtime and also configures the reverse proxy.

2. **Start the published image**

	 ```bash
	 docker compose up -d
	 ```

	 The compose file pulls `d3vle0/asmr:latest`. On launch the entrypoint writes `/usr/share/nginx/html/env.js` and regenerates the Nginx config so `/api/icecast-status` and `/api/icecast-stream` (plus the legacy `/icecast-*` paths) are proxied to your Icecast host—no CORS issues, no need to rebuild.

3. **Use the dashboard**
	 - Browse to http://localhost:4173.
	 - The UI polls `/api/icecast-status` for metadata and plays audio from `/api/icecast-stream`, both proxied to `ICECAST_BASE_URL`.

4. **Shutdown**

	 ```bash
	 docker compose down
	 ```

For local development outside Docker, you can still run `npm install` followed by `npm run dev`, but `ICECAST_BASE_URL` must be present in your shell environment so the Vite dev server proxies resolve correctly.


## Deploying to Vercel

1. Set `ICECAST_BASE_URL` in the Vercel dashboard (Project Settings → Environment Variables). This is the only variable the Serverless Functions need.
2. The build output stays static, but `/api/icecast-status` and `/api/icecast-stream` are handled by the Vercel Functions in `/api`. They proxy your Icecast server using the environment variable, so no `vercel.json` rewrites are required.
3. The frontend already calls the `/api` paths, so once the deployment finishes, visiting your Vercel URL will show live metadata and playback without CORS errors.


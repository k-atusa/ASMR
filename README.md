# ASMR

ASMR is a React + TypeScript single-page UI that monitors an Icecast server, shows the currently playing track metadata, and lets listeners jump directly into the live MP3 stream. The app periodically polls the Icecast `status-json.xsl` endpoint, displays stream-start timestamps and uptime in a dashboard-style layout, and exposes playback controls backed by the Icecast stream.

---

## Prerequisites

The frontend expects a running Icecast + Liquidsoap stack. For details on setting up your streaming server, you can refer to the guide at [devleo.us/posts/icecast](https://devleo.us/posts/icecast/).

---

## Local Development

To run the frontend locally:

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   Create a `.env` file in the root directory (you can duplicate `.env.example`):
   ```env
   ICECAST_BASE_URL=https://radio.katusa.space
   ICECAST_CHANNELS=club.mp3:Club,china.mp3:China,car.mp3:Car,edm.mp3:EDM,jpop.mp3:J-Pop,kpop.mp3:K-Pop,pop.mp3:Pop
   ```
   *Note: `ICECAST_BASE_URL` is the public origin of your Icecast server. `ICECAST_CHANNELS` defines the available mounts and their display names (format: `mount:DisplayName`, comma-separated).*

3. **Start the Development Server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Deploying to Vercel

The application is optimized for deployment on Vercel:

1. **Set Environment Variables**
   Configure both `ICECAST_BASE_URL` and `ICECAST_CHANNELS` in the Vercel dashboard (**Project Settings** → **Environment Variables**).

2. **Serverless Functions API**
   The frontend requests are handled by serverless functions in the `api/` directory. They proxy your Icecast server using the environment variable, preventing any CORS issues. No custom `vercel.json` rewrite configuration is required.

3. **Deployment**
   Once deployment is complete, visiting your Vercel URL will automatically show live metadata and support stream playback.

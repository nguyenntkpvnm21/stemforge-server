# StemForge Server

Backend API for the StemForge group project, built with Node.js,
Express, Mongoose, and MongoDB Atlas.

## Current functionality

- Health endpoint: `GET /api/health`
- MongoDB Atlas connection before API startup
- Environment configuration validation
- Configurable frontend origin for CORS
- Optional DNS resolver configuration

Authentication, track management, audio uploads, likes, and real-time
features are planned for later development.

## Requirements

- Node.js 24
- npm
- A MongoDB Atlas database user and an allowed network address

## Local setup

```powershell
git clone https://github.com/nguyenntkpvnm21/stemforge-server.git
cd stemforge-server
npm.cmd ci
Copy-Item .env.example .env
```

Fill in `.env` before starting the server:

| Variable | Purpose |
|---|---|
| `PORT` | Local API port, normally `5000` |
| `FRONTEND_URL` | Allowed frontend origin |
| `MONGO_URI` | MongoDB URI with database name and no embedded credentials |
| `MONGO_USERNAME` | Database username |
| `MONGO_PASSWORD` | Database password |
| `DNS_SERVERS` | Optional comma-separated DNS server addresses |

Atlas must allow the development machine's public IP address.
The database user needs `readWrite` access to the `stemforge` database.

```powershell
npm.cmd run dev
```

Open `http://localhost:5000/api/health`.

Expected response:

```json
{"status":"ok","service":"stemforge-server"}
```

Keep `.env` private. Commit only `.env.example` with empty credential fields.

## Render deployment

| Setting | Value |
|---|---|
| Service type | Web Service |
| Branch | `main` |
| Region | Singapore |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Node version | `NODE_VERSION=24` |
| Runtime mode | `NODE_ENV=production` |

Set the MongoDB credentials and `FRONTEND_URL` in Render's environment
settings. Render provides `PORT` automatically.

Allow the service's outbound IP ranges in MongoDB Atlas.
Leave `DNS_SERVERS` unset unless the deployment environment needs it.

API URL: https://stemforge-server.onrender.com

Health endpoint: https://stemforge-server.onrender.com/api/health

## Git workflow

- `main`: stable versions used for deployment
- `dev`: integration branch
- `feature/*`: feature development
- `docs/*`: documentation changes

Create pull requests into `dev`. Promote verified versions from
`dev` to `main`.
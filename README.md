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

## Cloudinary configuration and upload check

Set these variables in your local `.env`:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Keep real credentials out of `.env.example` and Git.

To verify audio upload, run from the repository root:

```powershell
node .\scripts\check-cloudinary-upload.js "C:\path\audio.mp3"
```

The script accepts a local MP3 or WAV file up to 5 MiB.
This limit applies only to the diagnostic script.

Each run uploads a new test asset and prints its public ID,
HTTPS URL, duration in seconds, and size in bytes.
Open the returned URL to check playback.

The initial audio delivery check confirmed HTTP Range support:
the CDN returned `206 Partial Content` for a partial file request.

## API documentation

Swagger UI is available at `/api-docs/`.

For local development:
1. Run `npm run dev`.
2. Open http://localhost:5000/api-docs/.
3. Expand `GET /api/health`, select **Try it out**, then **Execute**.

For the deployed service, append `/api-docs/` to the Render base URL.

The documentation covers health and account authentication endpoints.
The health endpoint returns the API status and does not actively check
external services.

## Authentication

Set `JWT_SECRET` in the local `.env` file to a cryptographically random
secret. Keep its value blank in `.env.example` and configure the real
secret separately on Render.

| Method | Endpoint | Authentication |
| --- | --- | --- |
| POST | `/api/auth/register` | Public |
| POST | `/api/auth/login` | Public |
| GET | `/api/auth/me` | Bearer access token |

Registration and login return `{ data: { user, accessToken } }`.
The current-account endpoint returns `{ data: { user } }`.
Responses do not include `passwordHash`.

Access tokens expire after one hour. Log in again to obtain a new token.
For protected requests, send `Authorization: Bearer <accessToken>`.

Registration always creates a `user` account. Client-supplied role
values are ignored.

Registration and login share a limit of 20 requests per IP within
15 minutes, including successful and unsuccessful requests.
Exceeding the limit returns HTTP 429 with a `Retry-After` header.
Counters are stored in process memory and reset when the server restarts.

To test authentication in Swagger UI:
1. Execute `POST /api/auth/login` with an existing account.
2. Copy the returned access token.
3. Select **Authorize** and paste only the token.
4. Execute `GET /api/auth/me`.

### Proxy configuration

Set `TRUST_PROXY_HOPS=0` when running the API directly on your local machine.

When deploying behind a reverse proxy, configure the number of trusted
proxy hops for the hosting environment and verify that the API identifies
the correct client IP.

The API logs the client IP when an authentication request exceeds the
rate limit.
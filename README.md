# Pulse

A lightweight, self-hosted classroom response tool for Biochemistry 395 at Rutgers. Students scan a QR code, submit a text response, professor sees it live.

## Stack

- **Backend:** Node.js + Express + TypeScript
- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **Database:** PostgreSQL + Prisma ORM
- **Realtime:** Socket.io
- **Hosting:** Railway

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database (local or Railway)

### Setup

```bash
# Install dependencies
npm install

# Copy env file and fill in your values
cp backend/.env.example backend/.env

# Run database migrations
npm run db:migrate

# Start dev servers (backend :3001, frontend :5173)
npm run dev
```

### Environment Variables

See `backend/.env.example` for all required variables. Key ones:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random 256-bit secret (`openssl rand -hex 32`) |
| `BASE_URL` | Public URL of the app (for QR code generation) |

## Usage

1. Professor registers at `/professor/register`, creates a class, shares the join code with students
2. Students register at `/student/register` and join the class with the join code
3. Professor creates a session (title + questions) — a QR code and 4-digit access code are generated
4. Students scan the QR or enter the code to submit responses
5. Professor watches responses live, closes the session, exports CSV

## Deployment

Configured for Railway. Add a PostgreSQL plugin and set the environment variables — the `railway.toml` handles the rest.

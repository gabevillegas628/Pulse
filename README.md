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

1. Professor registers at `/register?role=professor` and creates a class
2. Professor creates a session (title + questions) — a QR code and 4-digit access code are generated
3. Students scan the QR or enter the 4-digit code, register if they haven't, and answer. Answering enrolls them — there is no separate registration step
4. Professor watches responses live, closes the session, exports CSV

### Stragglers

A student who makes an account outside class has no question code to scan, so answering
cannot enroll them. For them the class has a **join code** — six characters, on the class
page and the dashboard card — and `/student` shows nothing but a box to type it into until
they are in a class.

Once a class has sections, hand out the **section** join code rather than the class one.
Joining by the class code leaves a student unassigned, and section-targeted runs refuse
unassigned students; the server rejects the class code for a sectioned class for that
reason. Sections and their codes are on the class page.

Professors can remove a student from a class on the Roster tab. Answers are kept, so a
student removed by mistake gets their history back by rejoining.

## Deployment

Configured for Railway. Add a PostgreSQL plugin and set the environment variables — the `railway.toml` handles the rest.

<div align="center">

<br/>

# 🔥 Flare

### AI-Powered Deadline Rescue Companion

*Because missing a deadline should never sneak up on you.*

<br/>

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Gemini AI](https://img.shields.io/badge/Gemini-2.5_Flash-8E75B2?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev/)
[![Firebase](https://img.shields.io/badge/Firebase-12-FFCA28?style=flat-square&logo=firebase&logoColor=black)](https://firebase.google.com/)
[![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)

</div>

---

## What is Flare?

Flare is an **AI-native task management system** that doesn't just track your deadlines — it actively fights to save them. When you're heading toward a missed deadline, Flare's autonomous agent pipeline triggers: it reads your calendar, finds an open slot, books a focus session for you, and sends you a confirmation email — all without you lifting a finger.

It's built around a core philosophy: **deadlines shouldn't require manual vigilance**. The system continuously evaluates every active task against real calendar data, classifies risk using a deterministic scheduling algorithm, and escalates automatically when a task crosses into `Critical` territory.

---

## The Core Idea: Risk-Aware Autonomous Scheduling

Every task in Flare carries a live **Risk Score** — `Stable`, `Urgent`, or `Critical`. This score is not a label you manually assign. It is computed from a precise mathematical model:

```
Available Hours = (Total hours until deadline) - (Google Calendar busy block hours)
Buffer          = Available Hours - Estimated Effort (hours)

If Buffer < 0          → Critical  (schedule deficit)
If deadline ≤ 12h away → Critical  (no reaction time)
If deadline ≤ 36h      → Urgent
If buffer < 6h         → Urgent
Otherwise              → Stable
```

The algorithm runs against **real-time Google Calendar free/busy data**, so your meeting-heavy weeks are automatically factored in. A task with 48 hours left but 40 hours of meetings in between will correctly flag as `Critical`.

---

## Agents

Flare's server-side intelligence is composed of two cooperating agents:

### 🤖 Rescue Agent (`server/rescueAgent.ts`)

The **Rescue Agent** is Flare's autonomous executor. It runs as a background sweep triggered by a cron endpoint (`POST /api/agent/sweep`) and operates on all connected users in parallel.

**What it does on each sweep:**

1. **Token refresh** — Retrieves stored OAuth refresh tokens from Firestore and exchanges them for fresh access tokens via the Google OAuth2 API, keeping the integration alive silently.
2. **Calendar ingestion** — Fetches the full free/busy intervals from Google Calendar for each user, bounded to the furthest task deadline plus a 2-day margin.
3. **Risk re-evaluation** — Calls the Risk Scorer agent on every active task, incorporating real calendar data into the buffer calculation.
4. **Autonomous scheduling** — If a task crosses into `Critical` and has no existing calendar block:
   - Calls `findNextFreeSlot()` to locate the earliest gap that fits the task's estimated effort within waking hours (8am–10pm).
   - If a slot exists before the deadline → creates a `[Flare Block]` Google Calendar event and records the event ID in Firestore.
   - If no slot exists before the deadline → drafts a professional extension-request email using **Gemini 2.5 Flash** and saves it as a ready-to-send draft on the task.
5. **Gmail notification** — Sends an HTML email to the user's Gmail via the Gmail Send API confirming the scheduled block.
6. **Quiet hours guard** — If the sweep runs between 10pm–7am (Pacific), email delivery is suppressed and queued for morning to avoid disturbing the user.

```
Cron Trigger
     │
     ▼
Fetch all users with connected Google accounts (Firestore Admin)
     │
     ├─► Refresh OAuth tokens
     │
     ├─► Fetch Calendar free/busy intervals
     │
     ├─► For each active task:
     │       ├─► Re-score risk (Risk Scorer Agent)
     │       ├─► If newly Critical → find free slot
     │       │       ├─► Slot found → book Calendar event + send Gmail alert
     │       │       └─► No slot → generate extension email draft (Gemini)
     │       └─► Persist updates to Firestore
     │
     └─► Return sweep logs
```

### 📊 Risk Scorer Agent (`server/riskScorer.ts`)

The **Risk Scorer** is a stateless evaluation engine that determines a task's risk level. It uses a **deterministic mathematical algorithm** as its primary strategy (zero latency, zero API cost, always reliable), with an optional **Gemini 2.5 Flash** refinement pass available if needed.

The deterministic path is always used in production because it is:
- **Instant** — no network round-trip
- **Precise** — exact buffer arithmetic
- **Zero-cost** — no API quota consumption
- **Predictable** — same inputs always produce the same output

Gemini's role here is architectural: it can add semantic nuance to the reasoning phrase (e.g. understanding that "final interview" is higher-stakes than "read chapter 3") without affecting the core classification logic.

---

## Voice Assistant

Flare includes a **voice-first task creation interface** powered by Gemini's multimodal audio API. Record your task verbally ("add a task: finish the project report by Friday, 4 hours of work"), and the server transcribes, parses, and pre-fills a task form — deadline, effort estimate, and all.

**Endpoint:** `POST /api/voice`  
**Model:** `gemini-2.5-flash` with structured JSON output schema

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, TypeScript, Vite, Lucide Icons, Recharts, Framer Motion |
| **Backend** | Node.js + Express (TypeScript, served via `tsx`) |
| **AI / LLM** | Google Gemini 2.5 Flash (`@google/genai`) |
| **Auth** | Firebase Authentication (email/password + Google OAuth2) |
| **Database** | Cloud Firestore (via Firebase SDK + Firebase Admin SDK) |
| **Calendar** | Google Calendar API (free/busy + event creation) |
| **Email** | Gmail API (send on behalf of user) |
| **Deployment** | Firebase Hosting + Cloud Run (via `firebase.json`) |

---

## Project Structure

```
flare/
├── server.ts                  # Express server — all API routes & OAuth handlers
│
├── server/
│   ├── rescueAgent.ts         # Autonomous sweep agent — scheduling, email, cron logic
│   ├── riskScorer.ts          # Task risk evaluation engine (deterministic + Gemini)
│   └── firebaseAdmin.ts       # Firebase Admin SDK initialization
│
├── src/
│   ├── App.tsx                # Root React application — state, views, drag-drop
│   ├── main.tsx               # React entry point
│   ├── types.ts               # Shared TypeScript types (Task, Habit, UserProfile)
│   ├── sharedUtils.ts         # Calendar math: free slot finder, interval merger
│   │
│   ├── firebase.ts            # Firebase client SDK initialization
│   ├── taskService.ts         # Firestore CRUD for tasks + batch risk evaluation
│   ├── calendarService.ts     # Google Calendar OAuth + free/busy proxy calls
│   ├── habitService.ts        # Firestore CRUD for habits
│   │
│   ├── index.css              # Global styles
│   │
│   └── components/
│       ├── AuthScreen.tsx     # Login / sign-up UI
│       ├── TaskCard.tsx       # Task card with risk badge, scheduling, email draft
│       ├── TaskFormModal.tsx  # Create / edit task form
│       ├── HabitsTracker.tsx  # Habit tracking UI with streak visualization
│       ├── VoiceAssistant.tsx # Voice recording + Gemini audio task creation
│       └── EffortChart.tsx    # Recharts effort visualization
│
├── firestore.rules            # Firestore security rules
├── firebase.json              # Firebase project config (hosting + functions)
├── vite.config.ts             # Vite bundler configuration
├── tsconfig.json              # TypeScript compiler options
├── package.json               # Dependencies and scripts
└── .env.example               # Environment variable template
```

---

## Key Features

- **Live Risk Dashboard** — Tasks displayed as cards sorted by risk level with color-coded urgency badges (`Critical` / `Urgent` / `Stable`).
- **Autonomous Agent Sweeps** — Background cron triggers run the Rescue Agent across all users on a schedule.
- **Google Calendar Integration** — Connects via OAuth2. Reads busy blocks. Writes focus session events with `[Flare Block]` prefix.
- **AI Draft Emails** — When no calendar slot exists before a deadline, Gemini drafts a professional extension-request email, personalized to the task context.
- **Voice Task Creation** — Speak a task naturally; Gemini parses intent and pre-fills the form.
- **Habits Tracker** — Lightweight habit system with daily/weekly frequency tracking and streak visualization.
- **Effort Chart** — Visual breakdown of time committed across active tasks.
- **Quiet Hours** — Agent suppresses notifications between 10pm–7am to protect user focus.
- **Guest Mode** — Try the UI without creating an account.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- A [Google Cloud project](https://console.cloud.google.com/) with Calendar API, Gmail API, and OAuth 2.0 credentials enabled
- A [Firebase project](https://console.firebase.google.com/) with Authentication and Firestore enabled
- A [Gemini API key](https://aistudio.google.com/app/apikey)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/your-username/flare.git
cd flare

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Fill in GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL
# Add Firebase config to src/firebase.ts

# 4. Start the development server
npm run dev
```

The Express server and Vite dev server run together on `http://localhost:3000`.

### API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/evaluate` | None | Evaluate a single task's risk |
| `POST` | `/api/evaluate-batch` | None | Batch-evaluate multiple tasks |
| `GET` | `/api/auth/google/url` | Firebase JWT | Get Google OAuth2 consent URL |
| `GET` | `/api/auth/google/callback` | None | OAuth2 callback handler |
| `POST` | `/api/auth/google/revoke` | Firebase JWT | Revoke Google OAuth token |
| `POST` | `/api/agent/sweep` | Secret key | Trigger autonomous rescue sweep |
| `POST` | `/api/dev/sweep` | Firebase JWT | Manual sweep trigger (dev/preview) |
| `POST` | `/api/calendar/freebusy` | Firebase JWT | Proxy: Google Calendar free/busy |
| `POST` | `/api/calendar/event` | Firebase JWT | Proxy: Create Google Calendar event |
| `POST` | `/api/tasks/send-draft` | Firebase JWT | Send extension draft via Gmail API |
| `POST` | `/api/voice` | None | Transcribe & parse voice task input |
| `POST` | `/api/account/delete` | Firebase JWT | Delete account and revoke tokens |

### Environment Variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Gemini API key for AI features |
| `APP_URL` | Public URL for OAuth redirect (e.g. `https://your-app.run.app`) |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `RESCUE_AGENT_KEY` | Secret header token protecting the `/api/agent/sweep` endpoint |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      Browser / Client                    │
│  React 19 + Vite  ·  Firebase Auth  ·  Firestore SDK   │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP (Firebase JWT)
┌───────────────────────────▼─────────────────────────────┐
│                     Express Server                       │
│                                                          │
│  /api/evaluate         → Risk Scorer Agent               │
│  /api/agent/sweep      → Rescue Agent (cron)             │
│  /api/auth/google/*    → OAuth2 flow                     │
│  /api/calendar/*       → Google Calendar proxy           │
│  /api/voice            → Gemini audio → task             │
│  /api/tasks/send-draft → Gmail API proxy                 │
└───┬──────────┬──────────┬──────────────────┬────────────┘
    │          │          │                  │
    ▼          ▼          ▼                  ▼
Gemini     Firestore  Google Calendar    Gmail API
2.5 Flash   Admin SDK  (free/busy +     (send email)
                        events)
```

---

## License

MIT

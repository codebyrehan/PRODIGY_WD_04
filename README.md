# PulseChat — Real-Time Chat Application

**Connect. Chat. In Real Time.**

PulseChat is a modern WebSocket-based messaging application built for Prodigy InfoTech Task 04, with a production-minded security and UX foundation.

## Task 04 coverage
- Account creation and authentication
- WebSocket-powered instant messaging
- Public chat rooms
- Private conversations
- Real-time text messages

## Optional enhancements
- Chat history
- Notifications and unread notifications
- Online/offline presence
- Typing indicators
- Image/PDF/text file sharing
- Responsive mobile-first interface
- Secure HTTP-only authentication cookies
- Password hashing with bcrypt
- Helmet security headers and API rate limiting
- Input validation and file-size/type restrictions

## Run locally
1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set a strong `JWT_SECRET`.
4. Run `npm start`.
5. Open `http://localhost:10000`.

## Architecture
The app uses an Express HTTP server and a native `ws` WebSocket server. Authentication is shared between HTTP and WebSocket connections through an HTTP-only cookie. The current internship build keeps application data in process memory; for a long-term public deployment, PostgreSQL/Redis (or another durable database/session layer) should replace the in-memory stores.

## Security notes
Never commit `.env` or production secrets. Use HTTPS/WSS in production, set a strong random `JWT_SECRET`, restrict origins when the frontend is hosted separately, and add durable storage/backups before using the app for important personal conversations.

## Internship
Built as **Task 04 — Real-Time Chat Application** for the Prodigy InfoTech Full-Stack Web Development Internship.

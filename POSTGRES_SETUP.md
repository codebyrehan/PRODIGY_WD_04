# PulseChat PostgreSQL Setup

PulseChat supports PostgreSQL persistence through the `DATABASE_URL` environment variable.

## Render

1. Open the `pulsechat-db` PostgreSQL instance in Render.
2. Open **Connect** and copy the **Internal Database URL**.
3. Open the `pulsechat-task-04` web service → **Environment**.
4. Add:
   - `DATABASE_URL` = the copied internal database URL
5. Keep `JWT_SECRET` set to a strong generated secret.
6. Save and deploy.

The application automatically creates the `users` table on startup and loads persisted accounts before accepting authentication requests.

## Important

The current database is a Render Free PostgreSQL instance and expires on September 14, 2026. Before that date, move to a persistent paid plan or migrate the database if PulseChat will remain in daily use.

## Security

Never commit `DATABASE_URL`, database passwords, or `JWT_SECRET` to GitHub. Keep them in Render environment variables only.

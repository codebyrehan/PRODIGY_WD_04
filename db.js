import pg from 'pg';

const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined })
  : null;

export const databaseEnabled = Boolean(pool);

export async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username VARCHAR(24) UNIQUE NOT NULL,
      display_name VARCHAR(32) NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
}

export async function loadUsers(users, notifications) {
  if (!pool) return;
  const { rows } = await pool.query('SELECT id, username, display_name, avatar, password_hash, created_at FROM users');
  for (const row of rows) {
    const user = { id: row.id, username: row.username, displayName: row.display_name, avatar: row.avatar || '', passwordHash: row.password_hash, createdAt: Number(row.created_at) };
    users.set(user.id, user);
    notifications.set(user.id, []);
  }
}

export async function insertUser(user) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO users (id, username, display_name, avatar, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [user.id, user.username, user.displayName, user.avatar, user.passwordHash, user.createdAt]
  );
}

export async function findUserByUsername(username) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT id, username, display_name, avatar, password_hash, created_at FROM users WHERE username = $1 LIMIT 1', [username]);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, avatar: row.avatar || '', passwordHash: row.password_hash, createdAt: Number(row.created_at) };
}

export async function closeDb() {
  if (pool) await pool.end();
}

import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: { rejectUnauthorized: false }
    })
  : null;

export const databaseEnabled = Boolean(pool);

const ROOM_SEEDS = [
  ['general', 'General', 'The main PulseChat room'],
  ['random', 'Random', 'Off-topic conversations'],
  ['tech', 'Tech Talk', 'Build, learn and share']
];

export async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username VARCHAR(24) UNIQUE NOT NULL,
      display_name VARCHAR(32) NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ,
      status VARCHAR(16) NOT NULL DEFAULT 'offline'
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id UUID PRIMARY KEY,
      slug VARCHAR(40) UNIQUE NOT NULL,
      name VARCHAR(40) NOT NULL,
      description VARCHAR(160) NOT NULL DEFAULT '',
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
      conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      message_type VARCHAR(16) NOT NULL DEFAULT 'text',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      CHECK ((room_id IS NOT NULL) <> (conversation_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id UUID PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      original_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes BIGINT NOT NULL,
      storage_key TEXT NOT NULL,
      data_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
      type VARCHAR(32) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slug VARCHAR(40);
    ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS data_url TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_slug ON rooms(slug);
    CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
  `);

  for (const [slug, name, description] of ROOM_SEEDS) {
    await pool.query(
      `INSERT INTO rooms (id, slug, name, description)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [slug, name, description]
    );
  }
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar || '',
    passwordHash: row.password_hash,
    createdAt: new Date(row.created_at).getTime()
  };
}

export async function loadUsers(users, notifications) {
  if (!pool) return;
  const { rows } = await pool.query(
    'SELECT id, username, display_name, avatar, password_hash, created_at FROM users'
  );
  for (const row of rows) {
    const user = mapUser(row);
    users.set(user.id, user);
    notifications.set(user.id, []);
  }
}

export async function insertUser(user) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO users (id, username, display_name, avatar, password_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), NOW())`,
    [user.id, user.username, user.displayName, user.avatar, user.passwordHash, user.createdAt]
  );
}

export async function findUserByUsername(username) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, username, display_name, avatar, password_hash, created_at
     FROM users WHERE username = $1 LIMIT 1`,
    [username]
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function listRooms() {
  if (!pool) return ROOM_SEEDS.map(([id, name, description]) => ({ id, name, description, members: 0 }));
  const { rows } = await pool.query(`
    SELECT r.slug AS id, r.name, r.description, COUNT(rm.user_id)::int AS members
    FROM rooms r
    LEFT JOIN room_members rm ON rm.room_id = r.id
    GROUP BY r.id
    ORDER BY r.created_at ASC
  `);
  return rows;
}

export async function ensureRoomMember(roomSlug, userId) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO room_members (room_id, user_id)
    SELECT id, $2 FROM rooms WHERE slug = $1
    ON CONFLICT DO NOTHING
  `, [roomSlug, userId]);
}

export async function getRoomHistory(roomSlug, limit = 100) {
  if (!pool) return [];
  const { rows } = await pool.query(`
    SELECT m.id, r.slug AS room_id, m.content, m.message_type, m.created_at,
           u.id AS sender_id, u.username, u.display_name, u.avatar,
           a.original_name, a.mime_type, a.size_bytes, a.data_url
    FROM messages m
    JOIN rooms r ON r.id = m.room_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN message_attachments a ON a.message_id = m.id
    WHERE r.slug = $1 AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT $2
  `, [roomSlug, limit]);
  return rows.reverse().map(mapMessageRow);
}

async function getOrCreateConversationId(client, userA, userB) {
  const existing = await client.query(`
    SELECT c.id
    FROM conversations c
    JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
    JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
    GROUP BY c.id
    HAVING COUNT(*) = 2
    LIMIT 1
  `, [userA, userB]);
  if (existing.rows[0]) return existing.rows[0].id;

  const id = crypto.randomUUID();
  await client.query('INSERT INTO conversations (id) VALUES ($1)', [id]);
  await client.query(
    'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
    [id, userA, userB]
  );
  return id;
}

export async function getConversationId(userA, userB) {
  if (!pool) return [userA, userB].sort().join(':');
  const client = await pool.connect();
  try {
    return await getOrCreateConversationId(client, userA, userB);
  } finally {
    client.release();
  }
}

function mapMessageRow(row) {
  const message = {
    id: row.id,
    roomId: row.room_id || undefined,
    conversationId: row.conversation_id || undefined,
    sender: {
      id: row.sender_id,
      username: row.username,
      displayName: row.display_name,
      avatar: row.avatar || ''
    },
    text: row.content || '',
    createdAt: new Date(row.created_at).getTime(),
    kind: row.message_type
  };
  if (row.original_name) {
    message.file = {
      name: row.original_name,
      type: row.mime_type,
      size: Number(row.size_bytes),
      dataUrl: row.data_url || ''
    };
  }
  return message;
}

export async function getDmHistory(userA, userB, limit = 100) {
  if (!pool) return [];
  const conversationId = await getConversationId(userA, userB);
  const { rows } = await pool.query(`
    SELECT m.id, m.conversation_id, m.content, m.message_type, m.created_at,
           u.id AS sender_id, u.username, u.display_name, u.avatar,
           a.original_name, a.mime_type, a.size_bytes, a.data_url
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN message_attachments a ON a.message_id = m.id
    WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT $2
  `, [conversationId, limit]);
  return rows.reverse().map(mapMessageRow);
}

export async function saveMessage(message, { roomId = null, recipientId = null, file = null } = {}) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let conversationId = null;
    let roomUuid = null;
    if (roomId) {
      const room = await client.query('SELECT id FROM rooms WHERE slug = $1 LIMIT 1', [roomId]);
      if (!room.rows[0]) throw new Error('Room not found');
      roomUuid = room.rows[0].id;
    } else {
      if (!recipientId) throw new Error('Message recipient is required');
      conversationId = await getOrCreateConversationId(client, message.sender.id, recipientId);
    }

    await client.query(
      `INSERT INTO messages (id, room_id, conversation_id, sender_id, content, message_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
      [message.id, roomUuid, conversationId, message.sender.id, message.text || '', message.kind, message.createdAt]
    );

    if (file) {
      await client.query(
        `INSERT INTO message_attachments
         (id, message_id, original_name, mime_type, size_bytes, storage_key, data_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [crypto.randomUUID(), message.id, file.name, file.type, file.size, `inline:${message.id}`, file.dataUrl]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveNotification(userId, actorId, notification) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO notifications (id, user_id, actor_id, type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [crypto.randomUUID(), userId, actorId || null, notification.type || 'message', JSON.stringify(notification.payload || {})]
  );
}

export async function listNotifications(userId, limit = 50) {
  if (!pool) return [];
  const { rows } = await pool.query(`
    SELECT id, type, payload, created_at, read_at
    FROM notifications WHERE user_id = $1
    ORDER BY created_at DESC LIMIT $2
  `, [userId, limit]);
  return rows.map(row => ({
    id: row.id,
    type: row.type,
    ...(row.payload || {}),
    createdAt: new Date(row.created_at).getTime(),
    readAt: row.read_at ? new Date(row.read_at).getTime() : null
  }));
}

export async function closeDb() {
  if (pool) await pool.end();
}

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import {
  databaseEnabled,
  initDb,
  loadUsers,
  insertUser,
  findUserByUsername,
  listRooms,
  ensureRoomMember,
  getRoomHistory,
  getDmHistory,
  saveMessage,
  saveNotification,
  listNotifications,
  closeDb
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && (!JWT_SECRET || JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters in production.');
}
if (!JWT_SECRET) console.warn('JWT_SECRET is not configured; development-only fallback is being used.');
const signingSecret = JWT_SECRET || 'dev-only-change-me-please-32-chars';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

const users = new Map();
const rooms = new Map([
  ['general', { id: 'general', name: 'General', description: 'The main PulseChat room', members: new Set() }],
  ['random', { id: 'random', name: 'Random', description: 'Off-topic conversations', members: new Set() }],
  ['tech', { id: 'tech', name: 'Tech Talk', description: 'Build, learn and share', members: new Set() }]
]);
const messages = new Map();
const sockets = new Map();
const dmMessages = new Map();
const notifications = new Map();
for (const id of rooms.keys()) messages.set(id, []);

async function bootstrap() {
  if (isProduction && !databaseEnabled) throw new Error('DATABASE_URL must be configured in production.');
  await initDb();
  await loadUsers(users, notifications);
}
await bootstrap();

app.disable('x-powered-by');
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1h' : 0 }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: true, legacyHeaders: false }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'];
    cb(null, allowed.includes(file.mimetype));
  }
});

const safeUser = u => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, createdAt: u.createdAt });
const makeToken = u => jwt.sign({ sub: u.id }, signingSecret, { expiresIn: '7d', issuer: 'pulsechat' });
const getAuth = req => {
  try {
    const token = req.cookies.pulsechat;
    if (!token) return null;
    const payload = jwt.verify(token, signingSecret, { issuer: 'pulsechat' });
    return users.get(payload.sub) || null;
  } catch { return null; }
};
const requireAuth = (req, res, next) => {
  const user = getAuth(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = user;
  next();
};
const cleanText = (value, max = 1000) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const publicUsers = () => [...users.values()].map(safeUser);
const broadcast = (payload, filter = () => true) => {
  const data = JSON.stringify(payload);
  for (const [uid, ws] of sockets) if (ws.readyState === 1 && filter(uid)) ws.send(data);
};
const broadcastPresence = () => broadcast({ type: 'presence', users: publicUsers().map(u => ({ ...u, online: sockets.has(u.id) })) });
const roomHistory = roomId => messages.get(roomId) || [];
function dmKey(a, b) { return [a, b].sort().join(':'); }
function sendToUser(uid, payload) { const ws = sockets.get(uid); if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); }

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'PulseChat', database: databaseEnabled ? 'neon-postgres' : 'memory-dev', time: new Date().toISOString() }));
app.get('/api/me', (req, res) => { const user = getAuth(req); res.json({ user: user ? safeUser(user) : null }); });

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 24).toLowerCase();
    const displayName = cleanText(req.body.displayName || username, 32);
    const password = String(req.body.password || '');
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 characters: letters, numbers or underscore.' });
    if (displayName.length < 1) return res.status(400).json({ error: 'Display name is required.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
    if ([...users.values()].some(u => u.username === username)) return res.status(409).json({ error: 'That username is already taken.' });

    const user = {
      id: crypto.randomUUID(),
      username,
      displayName,
      avatar: '',
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: Date.now()
    };
    await insertUser(user);
    users.set(user.id, user);
    notifications.set(user.id, []);
    res.cookie('pulsechat', makeToken(user), { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 7 * 864e5 });
    res.status(201).json({ user: safeUser(user) });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 24).toLowerCase();
    const password = String(req.body.password || '');
    let user = [...users.values()].find(u => u.username === username);
    if (!user) user = await findUserByUsername(username);
    if (user) users.set(user.id, user);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid username or password.' });
    res.cookie('pulsechat', makeToken(user), { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 7 * 864e5 });
    res.json({ user: safeUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('pulsechat', { httpOnly: true, sameSite: 'lax', secure: isProduction });
  res.status(204).end();
});

app.get('/api/rooms', requireAuth, async (_req, res, next) => {
  try {
    const data = await listRooms();
    res.json(data);
  } catch (error) { next(error); }
});

app.get('/api/users', requireAuth, (_req, res) => res.json(publicUsers().map(u => ({ ...u, online: sockets.has(u.id) }))));

app.get('/api/rooms/:roomId/messages', requireAuth, async (req, res, next) => {
  try {
    if (!rooms.has(req.params.roomId)) return res.status(404).json({ error: 'Room not found.' });
    const history = databaseEnabled ? await getRoomHistory(req.params.roomId) : roomHistory(req.params.roomId).slice(-100);
    res.json(history);
  } catch (error) { next(error); }
});

app.get('/api/dm/:userId/messages', requireAuth, async (req, res, next) => {
  try {
    const target = users.get(req.params.userId) || null;
    if (!target || target.id === req.user.id) return res.status(404).json({ error: 'User not found.' });
    const history = databaseEnabled
      ? await getDmHistory(req.user.id, target.id)
      : (dmMessages.get(dmKey(req.user.id, target.id)) || []).slice(-100);
    res.json(history);
  } catch (error) { next(error); }
});

app.get('/api/notifications', requireAuth, async (req, res, next) => {
  try {
    const data = databaseEnabled ? await listNotifications(req.user.id) : (notifications.get(req.user.id) || []);
    res.json(data);
  } catch (error) { next(error); }
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Unsupported or missing file.' });
  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  if (dataUrl.length > 7_200_000) return res.status(413).json({ error: 'File is too large after encoding.' });
  res.json({
    name: req.file.originalname.replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 80) || 'file',
    type: req.file.mimetype,
    size: req.file.size,
    dataUrl
  });
});

async function addNotification(uid, notification, actorId = null) {
  const item = { id: crypto.randomUUID(), ...notification, createdAt: Date.now() };
  const list = notifications.get(uid) || [];
  list.unshift(item);
  notifications.set(uid, list.slice(0, 50));
  if (databaseEnabled) await saveNotification(uid, actorId, { type: notification.type || 'message', payload: notification });
  return item;
}

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return socket.destroy();
  let user = null;
  try {
    const cookie = req.headers.cookie || '';
    const token = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('pulsechat='))?.slice('pulsechat='.length);
    if (token) user = users.get(jwt.verify(token, signingSecret, { issuer: 'pulsechat' }).sub);
  } catch {}
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, user));
});

wss.on('connection', async (ws, user) => {
  const previous = sockets.get(user.id);
  if (previous && previous.readyState === 1) previous.close(1000, 'New session connected');
  sockets.set(user.id, ws);

  for (const room of rooms.values()) {
    room.members.add(user.id);
    if (databaseEnabled) await ensureRoomMember(room.id, user.id);
  }

  ws.send(JSON.stringify({ type: 'ready', user: safeUser(user), rooms: [...rooms.values()].map(r => ({ id: r.id, name: r.name, description: r.description })) }));
  broadcastPresence();

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'join_room') {
        const roomId = cleanText(msg.roomId, 40);
        if (!rooms.has(roomId)) return;
        rooms.get(roomId).members.add(user.id);
        if (databaseEnabled) await ensureRoomMember(roomId, user.id);
        const history = databaseEnabled ? await getRoomHistory(roomId) : roomHistory(roomId).slice(-100);
        ws.send(JSON.stringify({ type: 'room_history', roomId, messages: history }));
        return;
      }

      if (msg.type === 'typing') {
        const roomId = cleanText(msg.roomId, 40);
        if (!rooms.has(roomId) || !rooms.get(roomId).members.has(user.id)) return;
        broadcast({ type: 'typing', roomId, user: safeUser(user) }, uid => uid !== user.id && rooms.get(roomId).members.has(uid));
        return;
      }

      if (msg.type === 'room_message') {
        const roomId = cleanText(msg.roomId, 40);
        const text = cleanText(msg.text, 2000);
        if (!rooms.has(roomId) || !text || !rooms.get(roomId).members.has(user.id)) return;
        const message = { id: crypto.randomUUID(), roomId, sender: safeUser(user), text, createdAt: Date.now(), kind: 'text' };
        if (databaseEnabled) await saveMessage(message, { roomId });
        const history = messages.get(roomId) || [];
        history.push(message);
        messages.set(roomId, history.slice(-500));
        broadcast({ type: 'message', message }, uid => rooms.get(roomId).members.has(uid));
        return;
      }

      if (msg.type === 'dm_message') {
        const to = users.get(cleanText(msg.to, 80));
        const text = cleanText(msg.text, 2000);
        if (!to || !text || to.id === user.id) return;
        const key = dmKey(user.id, to.id);
        const message = { id: crypto.randomUUID(), conversationId: key, sender: safeUser(user), recipient: safeUser(to), text, createdAt: Date.now(), kind: 'text' };
        if (databaseEnabled) await saveMessage(message, { recipientId: to.id });
        const history = dmMessages.get(key) || [];
        history.push(message);
        dmMessages.set(key, history.slice(-500));
        sendToUser(user.id, { type: 'dm_message', message });
        sendToUser(to.id, { type: 'dm_message', message });
        if (!sockets.has(to.id)) {
          const notification = await addNotification(to.id, { title: `${user.displayName} sent you a message`, body: text.slice(0, 100), type: 'message' }, user.id);
          if (notification) sendToUser(to.id, { type: 'notification', notification });
        }
        return;
      }

      if (msg.type === 'file_message') {
        const to = msg.to ? users.get(cleanText(msg.to, 80)) : null;
        const file = msg.file || {};
        const roomId = msg.roomId && rooms.has(msg.roomId) ? cleanText(msg.roomId, 40) : null;
        const name = cleanText(file.name, 80);
        const type = cleanText(file.type, 80);
        const dataUrl = String(file.dataUrl || '');
        const size = Number(file.size || 0);
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'];
        if (!name || !allowed.includes(type) || size < 1 || size > 5 * 1024 * 1024 || !dataUrl || dataUrl.length > 7_200_000) return;
        if (roomId && !rooms.get(roomId).members.has(user.id)) return;
        if (!roomId && (!to || to.id === user.id)) return;

        const message = {
          id: crypto.randomUUID(),
          sender: safeUser(user),
          recipient: to ? safeUser(to) : null,
          roomId,
          file: { name, type, size, dataUrl },
          createdAt: Date.now(),
          kind: 'file'
        };

        if (databaseEnabled) await saveMessage(message, { roomId, recipientId: to?.id || null, file: message.file });
        if (roomId) {
          const history = messages.get(roomId) || [];
          history.push(message);
          messages.set(roomId, history.slice(-500));
          broadcast({ type: 'message', message }, uid => rooms.get(roomId).members.has(uid));
        } else {
          const key = dmKey(user.id, to.id);
          const history = dmMessages.get(key) || [];
          history.push(message);
          dmMessages.set(key, history.slice(-500));
          sendToUser(user.id, { type: 'dm_message', message });
          sendToUser(to.id, { type: 'dm_message', message });
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error.message);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', error: 'Unable to process that message.' }));
    }
  });

  ws.on('error', error => console.error('WebSocket error:', error.message));
  ws.on('close', () => {
    if (sockets.get(user.id) === ws) sockets.delete(user.id);
    for (const room of rooms.values()) room.members.delete(user.id);
    broadcastPresence();
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  res.status(error?.statusCode || 500).json({ error: 'Internal server error.' });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const shutdown = async signal => {
  console.log(`${signal}: shutting down PulseChat`);
  wss.close();
  server.close(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => console.log(`PulseChat listening on ${PORT} (${databaseEnabled ? 'Neon PostgreSQL' : 'memory-dev'})`));

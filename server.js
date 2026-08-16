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
import { databaseEnabled, initDb, loadUsers, insertUser, findUserByUsername } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && JWT_SECRET === 'dev-only-change-me') throw new Error('JWT_SECRET must be configured in production.');

const app = express();
const server = http.createServer(app);
// File messages are capped at 5 MB; the WebSocket envelope is allowed up to 8 MB.
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

// If DATABASE_URL is configured, accounts survive application restarts/redeploys.
// Without it, local/demo mode remains available with the existing in-process store.
const dbReady = initDb().then(() => loadUsers(users, notifications));

dbReady.catch(error => {
  console.error('Database initialization failed:', error.message);
  if (databaseEnabled && isProduction) process.exit(1);
});

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

const safeUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, createdAt: u.createdAt });
const makeToken = (u) => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '7d', issuer: 'pulsechat' });
const getAuth = (req) => {
  try {
    const token = req.cookies.pulsechat;
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'pulsechat' });
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
const broadcastPresence = () => broadcast({ type: 'presence', users: publicUsers().map(u => ({ ...u, online: sockets.has(u.id) })) });
const broadcast = (payload, filter = () => true) => {
  const data = JSON.stringify(payload);
  for (const [uid, ws] of sockets) if (ws.readyState === 1 && filter(uid)) ws.send(data);
};
const roomHistory = (roomId) => (messages.get(roomId) || []).slice(-100);

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'PulseChat', database: databaseEnabled ? 'connected' : 'memory-mode', time: new Date().toISOString() }));
app.get('/api/me', (req, res) => { const user = getAuth(req); res.json({ user: user ? safeUser(user) : null }); });

app.post('/api/auth/register', async (req, res) => {
  await dbReady;
  const username = cleanText(req.body.username, 24).toLowerCase();
  const displayName = cleanText(req.body.displayName || username, 32);
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 characters: letters, numbers or underscore.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  if ([...users.values()].some(u => u.username === username)) return res.status(409).json({ error: 'That username is already taken.' });
  const user = { id: crypto.randomUUID(), username, displayName, avatar: '', passwordHash: await bcrypt.hash(password, 12), createdAt: Date.now() };
  try {
    await insertUser(user);
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    throw error;
  }
  users.set(user.id, user);
  notifications.set(user.id, []);
  res.cookie('pulsechat', makeToken(user), { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 7 * 864e5 });
  res.status(201).json({ user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  await dbReady;
  const username = cleanText(req.body.username, 24).toLowerCase();
  const password = String(req.body.password || '');
  let user = [...users.values()].find(u => u.username === username);
  if (!user && databaseEnabled) {
    user = await findUserByUsername(username);
    if (user) { users.set(user.id, user); notifications.set(user.id, []); }
  }
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid username or password.' });
  res.cookie('pulsechat', makeToken(user), { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 7 * 864e5 });
  res.json({ user: safeUser(user) });
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('pulsechat', { httpOnly: true, sameSite: 'lax', secure: isProduction }); res.status(204).end(); });

app.get('/api/rooms', requireAuth, (_req, res) => res.json([...rooms.values()].map(r => ({ id: r.id, name: r.name, description: r.description, members: [...r.members].length }))));
app.get('/api/users', requireAuth, (_req, res) => res.json(publicUsers().map(u => ({ ...u, online: sockets.has(u.id) }))));
app.get('/api/rooms/:roomId/messages', requireAuth, (req, res) => {
  if (!rooms.has(req.params.roomId)) return res.status(404).json({ error: 'Room not found.' });
  res.json(roomHistory(req.params.roomId));
});
app.get('/api/dm/:userId/messages', requireAuth, (req, res) => res.json((dmMessages.get(dmKey(req.user.id, req.params.userId)) || []).slice(-100)));
app.get('/api/notifications', requireAuth, (req, res) => res.json(notifications.get(req.user.id) || []));

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Unsupported or missing file.' });
  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  res.json({ name: req.file.originalname.replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 80) || 'file', type: req.file.mimetype, size: req.file.size, dataUrl });
});

function dmKey(a, b) { return [a, b].sort().join(':'); }
function sendToUser(uid, payload) { const ws = sockets.get(uid); if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); }
function addNotification(uid, notification) { const list = notifications.get(uid) || []; list.unshift({ id: crypto.randomUUID(), ...notification, createdAt: Date.now() }); notifications.set(uid, list.slice(0, 50)); }

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return socket.destroy();
  let user = null;
  try {
    const cookie = req.headers.cookie || '';
    const token = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('pulsechat='))?.split('=')[1];
    if (token) user = users.get(jwt.verify(token, JWT_SECRET, { issuer: 'pulsechat' }).sub);
  } catch {}
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, user));
});

wss.on('connection', (ws, user) => {
  sockets.set(user.id, ws);
  for (const room of rooms.values()) room.members.add(user.id);
  ws.send(JSON.stringify({ type: 'ready', user: safeUser(user), rooms: [...rooms.values()].map(r => ({ id: r.id, name: r.name, description: r.description })) }));
  broadcastPresence();

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'join_room') {
        if (!rooms.has(msg.roomId)) return;
        rooms.get(msg.roomId).members.add(user.id);
        ws.send(JSON.stringify({ type: 'room_history', roomId: msg.roomId, messages: roomHistory(msg.roomId) }));
        return;
      }
      if (msg.type === 'typing') {
        const target = cleanText(msg.roomId, 40);
        if (!rooms.has(target)) return;
        broadcast({ type: 'typing', roomId: target, user: safeUser(user) }, uid => uid !== user.id && rooms.get(target).members.has(uid));
        return;
      }
      if (msg.type === 'room_message') {
        const roomId = cleanText(msg.roomId, 40); const text = cleanText(msg.text, 2000);
        if (!rooms.has(roomId) || !text || !rooms.get(roomId).members.has(user.id)) return;
        const message = { id: crypto.randomUUID(), roomId, sender: safeUser(user), text, createdAt: Date.now(), kind: 'text' };
        const history = messages.get(roomId) || []; history.push(message); messages.set(roomId, history.slice(-500));
        broadcast({ type: 'message', message }, uid => rooms.get(roomId).members.has(uid));
        return;
      }
      if (msg.type === 'dm_message') {
        const to = users.get(cleanText(msg.to, 80)); const text = cleanText(msg.text, 2000);
        if (!to || !text || to.id === user.id) return;
        const key = dmKey(user.id, to.id); const message = { id: crypto.randomUUID(), conversationId: key, sender: safeUser(user), recipient: safeUser(to), text, createdAt: Date.now(), kind: 'text' };
        const history = dmMessages.get(key) || []; history.push(message); dmMessages.set(key, history.slice(-500));
        sendToUser(user.id, { type: 'dm_message', message }); sendToUser(to.id, { type: 'dm_message', message });
        if (!sockets.has(to.id)) addNotification(to.id, { title: `${user.displayName} sent you a message`, body: text.slice(0, 100) });
        return;
      }
      if (msg.type === 'file_message') {
        const to = msg.to ? users.get(cleanText(msg.to, 80)) : null;
        const file = msg.file || {};
        if (!file.dataUrl || String(file.dataUrl).length > 7_000_000 || !cleanText(file.name, 80)) return;
        const recipientId = to?.id || null; const roomId = msg.roomId && rooms.has(msg.roomId) ? msg.roomId : null;
        const message = { id: crypto.randomUUID(), sender: safeUser(user), recipient: to ? safeUser(to) : null, roomId, file: { name: cleanText(file.name, 80), type: cleanText(file.type, 80), dataUrl: file.dataUrl }, createdAt: Date.now(), kind: 'file' };
        if (roomId) { const history = messages.get(roomId) || []; history.push(message); messages.set(roomId, history.slice(-500)); broadcast({ type: 'message', message }, uid => rooms.get(roomId).members.has(uid)); }
        else if (recipientId) { const key = dmKey(user.id, recipientId); const history = dmMessages.get(key) || []; history.push(message); dmMessages.set(key, history.slice(-500)); sendToUser(user.id, { type: 'dm_message', message }); sendToUser(recipientId, { type: 'dm_message', message }); }
      }
    } catch { /* malformed websocket payloads are ignored */ }
  });
  ws.on('close', () => { if (sockets.get(user.id) === ws) sockets.delete(user.id); for (const room of rooms.values()) room.members.delete(user.id); broadcastPresence(); });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`PulseChat listening on ${PORT} (${databaseEnabled ? 'PostgreSQL' : 'memory-mode'})`));

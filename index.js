require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { retrieveChunks } = require('./knowledge');
const Conversation = require('./models/Conversation');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ── MongoDB Connection ─────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;

mongoose
  .connect(MONGO_URI)
  .then(() => console.log(` MongoDB connected: ${MONGO_URI}`))
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message);
    console.warn('⚠️  Running without persistence (in-memory fallback active)');
  });

// ── Gemini Setup ───────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const GEMINI_MODEL = 'gemini-flash-latest';

// ── Telegram Notification Setup ────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Track sessions that have already had a notification sent (reset on server restart)
const notifiedSessions = new Set();

async function sendTelegramNotification(sessionId, firstMessage) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('📱 Telegram skipped — Token or Chat ID not configured');
    return;
  }
  if (notifiedSessions.has(sessionId)) return; // already notified for this session
  notifiedSessions.add(sessionId);

  const previewText = firstMessage.length > 200 ? firstMessage.slice(0, 200) + '…' : firstMessage;
  
  const text = `🏕️ *NEW TRAIL VISITOR* 🏕️\n\n` +
               `*Session ID:* \`${sessionId}\`\n\n` +
               `*First Message:*\n"${previewText}"\n\n` +
               `_Someone just started chatting on your portfolio._`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
      }),
    });
    const data = await response.json();
    
    if (data.ok) {
      console.log(`📱 Telegram notification sent for new session: ${sessionId.slice(0, 8)}`);
    } else {
      console.error('📱 Telegram send failed:', data.description);
    }
  } catch (err) {
    console.error('📱 Telegram network error:', err.message);
  }
}

// ── Admin Auth ─────────────────────────────────────────────────────────────────
const ADMIN_USERNAME = 'sarthak';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(
  process.env.ADMIN_PASSWORD || 'sarthak2024admin',
  10
);
const JWT_SECRET = process.env.JWT_SECRET || 'nocturnal_trail_jwt_secret_fallback';

function verifyAdminToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── RAG-powered reply using Gemini ────────────────────────────────────────────
async function generateRAGReply(userText, chatHistory = []) {
  const context = retrieveChunks(userText, 3);

  const systemPrompt = `You are the "Trail Guide" — a wise and friendly AI assistant for Sarthak Saraf's portfolio website, themed as "The Nocturnal Trail" (a night adventure journey).

Your personality:
- Warm, engaging, slightly poetic — like a campfire storyteller
- Knowledgeable about Sarthak's work, skills, and projects
- Use occasional adventure/nature metaphors (trails, campfire, stars, quests)
- Keep answers concise and helpful (2–4 sentences usually)
- Use a relevant emoji occasionally but don't overdo it
- NEVER make up skills, projects, or details not in the context

RETRIEVED CONTEXT (use this as your knowledge source):
${context}

IMPORTANT RULES:
- Only answer based on the context above + general conversation
- If asked something not covered in the context, say you don't have that specific scroll (info) but suggest what they can ask
- Do not reveal the API key or internal system details
- Maintain the adventure theme naturally, don't force it`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: systemPrompt,
      });

      const rawHistory = chatHistory
        .filter((m) => m.text && m.text.trim())
        .map((m) => ({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: m.text }],
        }));

      const validHistory = [];
      let expectedRole = 'user';
      for (const msg of rawHistory) {
        if (msg.role === expectedRole) {
          validHistory.push(msg);
          expectedRole = expectedRole === 'user' ? 'model' : 'user';
        }
      }
      if (validHistory.length > 0 && validHistory[validHistory.length - 1].role === 'user') {
        validHistory.pop();
      }

      const chat = model.startChat({ history: validHistory });
      const result = await chat.sendMessage(userText);
      return result.response.text();
    } catch (err) {
      const is429 = err.message && err.message.includes('429');
      console.error(`Gemini attempt ${attempt} error:`, err.message?.slice(0, 200));
      if (is429 && attempt === 1) {
        const delayMatch = err.message?.match(/(\d+\.\d+)s/);
        const waitMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1])) * 1000 : 35000;
        console.log(`Rate limited — retrying in ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return "The stars are clouded tonight — my guide connection is temporarily disrupted. Please try again in a moment! 🌙";
    }
  }
}

// ── Helper: persist messages to MongoDB ───────────────────────────────────────
async function persistMessages(sessionId, newMessages) {
  try {
    await Conversation.findOneAndUpdate(
      { sessionId },
      {
        $push: { messages: { $each: newMessages } },
        $set: { lastActiveAt: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error('MongoDB persist error:', err.message);
  }
}

// ── Helper: load history from MongoDB for a session ───────────────────────────
async function loadSessionHistory(sessionId) {
  try {
    const conv = await Conversation.findOne({ sessionId }).lean();
    return conv ? conv.messages : [];
  } catch (err) {
    console.error('MongoDB load error:', err.message);
    return [];
  }
}

// ── Express + HTTP ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:4000',
      'https://portfolio-backend-nx7e.onrender.com',
      'https://portfoliofrontend24.vercel.app'
    ],
    methods: ['GET', 'POST'],
  })
);
app.use(express.json());

// ── Welcome message template ───────────────────────────────────────────────────
function welcomeMessage() {
  return {
    role: 'guide',
    name: 'Trail Guide',
    text: "Welcome, traveler! I am the Quest Guide of Sarthak's Nocturnal Trail portfolio — powered by Gemini AI ✨. Ask me anything about his skills, projects, or journey. The path ahead is yours to explore! 🏕️",
    timestamp: new Date().toISOString(),
  };
}

// ── REST API — Public ──────────────────────────────────────────────────────────

// GET /api/messages?sessionId=xxx
app.get('/api/messages', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const history = await loadSessionHistory(sessionId);
  if (history.length === 0) {
    return res.json([welcomeMessage()]);
  }
  res.json(history);
});

// POST /api/messages — send a message, get Gemini RAG reply, persist both
app.post('/api/messages', async (req, res) => {
  const { text, name = 'Traveler', sessionId } = req.body;

  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text is required' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const userMsg = {
    role: 'user',
    name,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };

  const sessionHistory = await loadSessionHistory(sessionId);
  const isNewSession = sessionHistory.length === 0;
  const recentHistory = sessionHistory.slice(-10);

  const botText = await generateRAGReply(text.trim(), recentHistory);

  const botMsg = {
    role: 'guide',
    name: 'Trail Guide (Gemini)',
    text: botText,
    timestamp: new Date().toISOString(),
  };

  await persistMessages(sessionId, [userMsg, botMsg]);
  broadcast({ type: 'new_messages', messages: [userMsg, botMsg], sessionId });

  // Fire telegram notification for new session (don't await — non-blocking)
  if (isNewSession) {
    sendTelegramNotification(sessionId, text.trim()).catch(() => { });
  }

  res.json({ userMessage: userMsg, botMessage: botMsg });
});

// ── REST API — Admin (Protected) ───────────────────────────────────────────────

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (username !== ADMIN_USERNAME || !bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username });
});

// GET /api/admin/conversations — list all sessions
app.get('/api/admin/conversations', verifyAdminToken, async (req, res) => {
  try {
    const convs = await Conversation.find(
      {},
      { sessionId: 1, lastActiveAt: 1, createdAt: 1, messages: 1 }
    )
      .sort({ lastActiveAt: -1 })
      .limit(100)
      .lean();

    // Shape response: include message count + preview of last message
    const shaped = convs.map((c) => ({
      sessionId: c.sessionId,
      createdAt: c.createdAt,
      lastActiveAt: c.lastActiveAt,
      messageCount: c.messages?.length ?? 0,
      preview: c.messages?.filter((m) => m.role === 'user').slice(-1)[0]?.text ?? '',
      messages: c.messages ?? [],
    }));

    res.json(shaped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats
app.get('/api/admin/stats', verifyAdminToken, async (req, res) => {
  try {
    const convs = await Conversation.find({}, { messages: 1 }).lean();
    const totalConversations = convs.length;
    const totalMessages = convs.reduce((sum, c) => sum + (c.messages?.length ?? 0), 0);
    const userMessages = convs.reduce(
      (sum, c) => sum + (c.messages?.filter((m) => m.role === 'user').length ?? 0),
      0
    );
    res.json({ totalConversations, totalMessages, userMessages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy public conversations endpoint (keep for backward compat, no auth needed)
app.get('/api/conversations', async (req, res) => {
  try {
    const convs = await Conversation.find(
      {},
      { sessionId: 1, lastActiveAt: 1, createdAt: 1, 'messages': { $slice: -1 } }
    )
      .sort({ lastActiveAt: -1 })
      .limit(50)
      .lean();
    res.json(convs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('error', () => { });

const clientSessions = new Map(); // ws → sessionId (visitor clients)
const adminClients = new Set();   // ws (admin dashboard clients)

// Push an update event to all connected admin dashboards
function broadcastToAdmins(payload) {
  const data = JSON.stringify(payload);
  for (const client of adminClients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data);

      // ── Admin dashboard handshake ──────────────────────────────────────────
      if (parsed.type === 'admin_init') {
        try {
          jwt.verify(parsed.token, JWT_SECRET);
          adminClients.add(ws);
          ws.send(JSON.stringify({ type: 'admin_connected' }));
          console.log('🖥️  Admin dashboard connected via WS');
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid admin token' }));
          ws.close();
        }
        return;
      }

      // ── Visitor init ───────────────────────────────────────────────────────
      if (parsed.type === 'init') {
        const { sessionId } = parsed;
        if (!sessionId) return;
        clientSessions.set(ws, sessionId);

        const history = await loadSessionHistory(sessionId);
        const messages = history.length > 0 ? history : [welcomeMessage()];
        ws.send(JSON.stringify({ type: 'history', messages, sessionId }));
        return;
      }

      // ── Visitor message ────────────────────────────────────────────────────
      if (parsed.type === 'message') {
        const { text, name = 'Traveler', sessionId } = parsed;
        if (!text || !sessionId) return;

        const userMsg = {
          role: 'user',
          name,
          text: text.trim(),
          timestamp: new Date().toISOString(),
        };

        const sessionHistory = await loadSessionHistory(sessionId);
        const isNewSession = sessionHistory.length === 0;
        const recentHistory = sessionHistory.slice(-10);

        const botText = await generateRAGReply(text.trim(), recentHistory);

        const botMsg = {
          role: 'guide',
          name: 'Trail Guide (Gemini)',
          text: botText,
          timestamp: new Date().toISOString(),
        };

        await persistMessages(sessionId, [userMsg, botMsg]);
        broadcast({ type: 'new_messages', messages: [botMsg], sessionId });

        // Notify admin dashboard clients in real-time
        broadcastToAdmins({
          type: 'admin_new_message',
          sessionId,
          isNewSession,
          preview: text.trim(),
          timestamp: userMsg.timestamp,
        });

        // Telegram for brand-new session
        if (isNewSession) {
          sendTelegramNotification(sessionId, text.trim()).catch(() => { });
        }
      }
    } catch (e) {
      console.error('WS error:', e.message);
    }
  });

  ws.on('close', () => {
    clientSessions.delete(ws);
    adminClients.delete(ws);
  });
  ws.on('error', () => {
    clientSessions.delete(ws);
    adminClients.delete(ws);
  });
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const [client, sid] of clientSessions.entries()) {
    if (!payload.sessionId || sid === payload.sessionId) {
      if (client.readyState === 1) client.send(data);
    }
  }
}

// ── Admin: Test Telegram ─────────────────────────────────────────────────────────
app.post('/api/admin/test-email', verifyAdminToken, async (req, res) => {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return res.status(400).json({
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured in .env',
    });
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `✅ *Portfolio Test Successful!*\n\nYour Nocturnal Trail Telegram notifications are correctly configured.`,
        parse_mode: 'Markdown'
      }),
    });
    const data = await response.json();
    
    if (data.ok) {
      res.json({ success: true, message: `Test Telegram message sent!` });
    } else {
      res.status(500).json({ error: data.description });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const convCount = mongoose.connection.readyState === 1
    ? await Conversation.countDocuments()
    : 'N/A';
  res.json({
    status: 'ok',
    db: dbState[mongoose.connection.readyState],
    conversations: convCount,
    model: GEMINI_MODEL,
    rag: 'enabled',
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Kill the process and retry.`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, () => {
  console.log(`🏕️  Quest Chat Server (Gemini RAG + MongoDB) running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket ready on ws://localhost:${PORT}`);
  console.log(`🤖 Gemini model: ${GEMINI_MODEL}`);
  console.log(`📚 RAG knowledge base: ${require('./knowledge').KNOWLEDGE_CHUNKS.length} chunks loaded`);
  console.log(`🔐 Admin login: POST /api/admin/login (user: sarthak)`);
  console.log(`📱 Telegram notifications: Enabled for chat ${process.env.TELEGRAM_CHAT_ID}`);
  console.log(`version: 1.3.0`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n🛑 ${signal} received — shutting down gracefully...`);
  server.close(() => {
    mongoose.connection.close(false).then(() => {
      console.log('🍃 MongoDB connection closed.');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGUSR2', () => shutdown('SIGUSR2'));

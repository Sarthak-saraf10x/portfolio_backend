require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { retrieveChunks } = require('./knowledge');
const Conversation = require('./models/Conversation');

// ── MongoDB Connection ─────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI

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

/**
 * RAG-powered reply using Gemini.
 * Retrieves relevant knowledge chunks and calls Gemini with context.
 */
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

      // Build valid strictly-alternating history for Gemini
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
      // Must end on 'model' — drop trailing user msg if present
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
  if (mongoose.connection.readyState !== 1) return; // skip if not connected
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
  if (mongoose.connection.readyState !== 1) return [];
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
    origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:4000'],
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

// ── REST API ───────────────────────────────────────────────────────────────────

// GET /api/messages?sessionId=xxx — load conversation history for this session
app.get('/api/messages', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const history = await loadSessionHistory(sessionId);

  // If no history yet, return just the welcome message
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

  // Build user message
  const userMsg = {
    role: 'user',
    name,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };

  // Load recent session history from DB for Gemini context
  const sessionHistory = await loadSessionHistory(sessionId);
  const recentHistory = sessionHistory.slice(-10);

  // Call Gemini RAG
  const botText = await generateRAGReply(text.trim(), recentHistory);

  const botMsg = {
    role: 'guide',
    name: 'Trail Guide (Gemini)',
    text: botText,
    timestamp: new Date().toISOString(),
  };

  // Persist both messages to MongoDB
  await persistMessages(sessionId, [userMsg, botMsg]);

  // Broadcast to WebSocket clients in the same session
  broadcast({ type: 'new_messages', messages: [userMsg, botMsg], sessionId });

  res.json({ userMessage: userMsg, botMessage: botMsg });
});

// GET /api/conversations — list all sessions (admin overview)
app.get('/api/conversations', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.json({ error: 'MongoDB not connected', conversations: [] });
  }
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

// Suppress WSS re-emitting server errors (e.g. EADDRINUSE) as unhandled exceptions
// The server.on('error') handler below takes care of it
wss.on('error', () => { });

// Map: ws → sessionId for targeted broadcasting
const clientSessions = new Map();

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data);

      // Initial handshake — client sends sessionId to register
      if (parsed.type === 'init') {
        const { sessionId } = parsed;
        if (!sessionId) return;
        clientSessions.set(ws, sessionId);

        // Send history for this session
        const history = await loadSessionHistory(sessionId);
        const messages = history.length > 0 ? history : [welcomeMessage()];
        ws.send(JSON.stringify({ type: 'history', messages, sessionId }));
        return;
      }

      // Handle incoming chat message
      if (parsed.type === 'message') {
        const { text, name = 'Traveler', sessionId } = parsed;
        if (!text || !sessionId) return;

        const userMsg = {
          role: 'user',
          name,
          text: text.trim(),
          timestamp: new Date().toISOString(),
        };

        // NOTE: we do NOT echo userMsg back to sender — client shows it optimistically

        // Load recent history for Gemini context
        const sessionHistory = await loadSessionHistory(sessionId);
        const recentHistory = sessionHistory.slice(-10);

        // Call Gemini RAG
        const botText = await generateRAGReply(text.trim(), recentHistory);

        const botMsg = {
          role: 'guide',
          name: 'Trail Guide (Gemini)',
          text: botText,
          timestamp: new Date().toISOString(),
        };

        // Persist to MongoDB
        await persistMessages(sessionId, [userMsg, botMsg]);

        // Send bot reply to all clients with the same sessionId
        broadcast({ type: 'new_messages', messages: [botMsg], sessionId });
      }
    } catch (e) {
      console.error('WS error:', e.message);
    }
  });

  ws.on('close', () => clientSessions.delete(ws));
  ws.on('error', () => clientSessions.delete(ws));
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const [client, sid] of clientSessions.entries()) {
    // Only send to clients in the same session (or all if no sessionId filter)
    if (!payload.sessionId || sid === payload.sessionId) {
      if (client.readyState === 1) client.send(data);
    }
  }
}

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

// Handle port-in-use gracefully instead of crashing
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Kill the process and retry.`);
    process.exit(1); // Exit cleanly so nodemon can restart
  } else {
    throw err;
  }
});

server.listen(PORT, () => {
  console.log(`🏕️  Quest Chat Server (Gemini RAG + MongoDB) running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket ready on ws://localhost:${PORT}`);
  console.log(`🤖 Gemini model: ${GEMINI_MODEL}`);
  console.log(`📚 RAG knowledge base: ${require('./knowledge').KNOWLEDGE_CHUNKS.length} chunks loaded`);
});

// ── Graceful shutdown (nodemon sends SIGUSR2, systemd sends SIGTERM) ─────────
function shutdown(signal) {
  console.log(`\n🛑 ${signal} received — shutting down gracefully...`);
  server.close(() => {
    mongoose.connection.close(false).then(() => {
      console.log('🍃 MongoDB connection closed.');
      process.exit(0);
    });
  });
  // Force exit if shutdown takes > 5s
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart signal

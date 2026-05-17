const mongoose = require('mongoose');
const Conversation = require('./models/Conversation');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const stats = await Conversation.find({}, { sessionId: 1, _id: 0, messages: 1 }).lean();
  console.log("Conversations count:", stats.length);
  console.log(stats.map(c => ({ id: c.sessionId, messagesCount: c.messages.length })));
  process.exit(0);
});

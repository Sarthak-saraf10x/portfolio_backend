const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'guide'],
    required: true,
  },
  name: {
    type: String,
    default: 'Traveler',
  },
  text: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const ConversationSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    messages: [MessageSchema],
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Update lastActiveAt whenever messages are added
ConversationSchema.pre('save', function (next) {
  this.lastActiveAt = new Date();
  next();
});

module.exports = mongoose.model('Conversation', ConversationSchema);

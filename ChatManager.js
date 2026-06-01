const EventEmitter = require('events');

class ChatManager extends EventEmitter {
  constructor() {
    super();
    this.messages = []; // Unified message log (last 200)
    this.maxMessages = 200;
  }

  addMessage(msg) {
    const unified = {
      id: msg.messageId || `${msg.platform}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      platform: msg.platform, // 'blaze' or 'arena'
      username: msg.username,
      userId: msg.userId,
      text: msg.text,
      avatar: msg.avatar || null,
      role: msg.role || null,
      timestamp: msg.timestamp || Date.now(),
    };

    this.messages.push(unified);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    this.emit('message', unified);
    return unified;
  }

  getMessages(since = 0) {
    if (since) {
      return this.messages.filter((m) => m.timestamp > since);
    }
    return this.messages.slice(-50);
  }
}

module.exports = ChatManager;

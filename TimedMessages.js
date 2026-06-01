const fs = require('fs');
const path = require('path');

const MESSAGES_FILE = path.join(__dirname, 'timed_messages.json');

class TimedMessages {
  constructor(senders) {
    // senders: array of { send: fn(message), name: string }
    this.senders = Array.isArray(senders) ? senders : [{ send: senders, name: 'default' }];
    this.messages = [];
    this.intervalSeconds = 600;
    this.currentIndex = 0;
    this.randomize = false;
    this.timerHandle = null;
    this.isRunning = false;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(MESSAGES_FILE)) {
        const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
        this.messages = data.messages || [];
        this.intervalSeconds = data.intervalSeconds || 600;
        this.currentIndex = data.currentIndex || 0;
        this.randomize = data.randomize === true;
        console.log(`Loaded ${this.messages.length} timed messages (interval: ${this.intervalSeconds}s)`);
      }
    } catch (error) {
      console.error('Error loading timed messages:', error.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(MESSAGES_FILE, JSON.stringify({
        messages: this.messages,
        intervalSeconds: this.intervalSeconds,
        currentIndex: this.currentIndex,
        randomize: this.randomize,
      }, null, 2));
    } catch (error) {
      console.error('Error saving timed messages:', error.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const enabled = this.messages.filter((m) => m.enabled);
    if (enabled.length > 0) {
      console.log(`Timed messages active - sending every ${this.intervalSeconds}s (${enabled.length} messages)`);
      this.scheduleNext();
    }
  }

  stop() {
    this.isRunning = false;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  scheduleNext() {
    if (!this.isRunning) return;
    if (this.timerHandle) clearTimeout(this.timerHandle);
    this.timerHandle = setTimeout(() => this.sendNext(), this.intervalSeconds * 1000);
  }

  async sendNext() {
    if (!this.isRunning) return;

    const enabled = this.messages.filter((m) => m.enabled);
    if (enabled.length === 0) return;

    let pickIndex;
    if (this.randomize) {
      pickIndex = Math.floor(Math.random() * enabled.length);
    } else {
      if (this.currentIndex >= enabled.length) this.currentIndex = 0;
      pickIndex = this.currentIndex;
    }

    const msg = enabled[pickIndex];
    console.log(`Timed message: "${msg.message.substring(0, 50)}..."`);
    for (const sender of this.senders) {
      try {
        await sender.send(msg.message);
      } catch (err) {
        console.error(`Timed message send failed (${sender.name}):`, err.message);
      }
    }

    if (!this.randomize) {
      this.currentIndex = (pickIndex + 1) % enabled.length;
    }
    this.save();
    this.scheduleNext();
  }

  getState() {
    return {
      messages: this.messages,
      intervalSeconds: this.intervalSeconds,
      isRunning: this.isRunning,
      randomize: this.randomize,
    };
  }

  addMessage(message) {
    const maxId = this.messages.reduce((max, m) => Math.max(max, m.id), 0);
    const entry = { id: maxId + 1, message, enabled: true };
    this.messages.push(entry);
    this.save();
    return entry;
  }

  updateMessage(id, updates) {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (updates.message !== undefined) msg.message = updates.message;
    if (updates.enabled !== undefined) msg.enabled = updates.enabled;
    this.save();
    return msg;
  }

  deleteMessage(id) {
    const index = this.messages.findIndex((m) => m.id === id);
    if (index === -1) return false;
    this.messages.splice(index, 1);
    const enabled = this.messages.filter((m) => m.enabled).length;
    if (this.currentIndex >= enabled) this.currentIndex = 0;
    this.save();
    return true;
  }

  setInterval(seconds) {
    this.intervalSeconds = Math.max(10, Math.min(7200, seconds));
    this.save();
    if (this.isRunning) this.scheduleNext();
    return this.intervalSeconds;
  }

  setRandomize(enabled) {
    this.randomize = enabled;
    this.save();
  }
}

module.exports = TimedMessages;

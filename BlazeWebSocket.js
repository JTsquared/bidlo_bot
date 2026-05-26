const io = require('socket.io-client');
const EventEmitter = require('events');

class BlazeWebSocket extends EventEmitter {
  constructor(config, blazeAPI = null) {
    super();
    this.config = config;
    this.blazeAPI = blazeAPI;
    this.socket = null;
    this.isConnected = false;
    this.sessionId = this.generateUUID();
    this.lastActivityTime = Date.now();
    this.healthCheckInterval = null;
    this.healthCheckIntervalMs = 30000;
    this.maxInactivityMs = 120000;
    this.recentMessages = new Map();
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async connect() {
    console.log('Connecting to Blaze WebSocket...');
    const { authToken, visitorId, channelId } = this.config;
    if (!authToken || !visitorId || !channelId) {
      throw new Error('Missing required config: authToken, visitorId, or channelId');
    }

    this.socket = io('https://blaze.stream', {
      path: '/socket.io/',
      transports: ['websocket'],
      upgrade: false,
      extraHeaders: {
        Cookie: `visitorId=${visitorId}; token=${authToken}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Visitor-Id': visitorId,
      },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    this.setupListeners();
    await this.waitForConnection();
    console.log('Connected to Blaze WebSocket');
    await this.joinRooms();
  }

  setupListeners() {
    this.socket.on('connect', () => {
      console.log('Socket connected, ID:', this.socket.id);
      this.isConnected = true;
      this.lastActivityTime = Date.now();
      this.startHealthMonitoring();
      this.emit('connected');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      this.isConnected = false;
      this.stopHealthMonitoring();
      this.emit('disconnected', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('Connection error:', error.message);
      this.emit('error', error);
    });

    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`Reconnected after ${attemptNumber} attempts`);
      this.lastActivityTime = Date.now();
    });

    this.socket.onAny((eventName, ...args) => {
      this.lastActivityTime = Date.now();
      this.handleEvent(eventName, ...args);
    });
  }

  waitForConnection() {
    return new Promise((resolve, reject) => {
      if (this.socket.connected) return resolve();
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      this.socket.once('connect', () => { clearTimeout(timeout); resolve(); });
      this.socket.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
    });
  }

  async joinRooms() {
    const { authToken, visitorId, channelId, targetChannelId } = this.config;
    // Join rooms for the target channel (the streamer's channel)
    // If no target is set, fall back to the bot's own channel
    const watchChannelId = targetChannelId || channelId;
    const roomConfigs = [
      { name: 'Channel + Stream', socketId: this.socket.id, externalId: watchChannelId, rooms: ['channel', 'stream'] },
      { name: 'Owner + Visitor', socketId: this.socket.id, rooms: ['owner', 'visitor'] },
      { name: 'Channel (chat)', socketId: this.socket.id, externalId: watchChannelId, rooms: ['channel'], source: 'chat' },
      { name: 'Activity', socketId: this.socket.id, externalId: watchChannelId, rooms: ['activity'] },
    ];

    let successCount = 0;
    for (const config of roomConfigs) {
      const configName = config.name;
      delete config.name;
      try {
        const response = await fetch('https://blaze.stream/bapi/auth/socket/enter-room', {
          method: 'POST',
          headers: {
            Accept: '*/*',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            Cookie: `visitorId=${visitorId}; token=${authToken}`,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Visitor-Id': visitorId,
          },
          body: JSON.stringify(config),
        });
        if (response.ok) successCount++;
        else console.log(`  Failed to join ${configName} (${response.status})`);
      } catch (error) {
        console.log(`  ERROR joining ${configName}:`, error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.log(`Joined ${successCount}/${roomConfigs.length} rooms`);
  }

  handleEvent(eventName, ...args) {
    const [data] = args;
    if (eventName && eventName.startsWith('channel_chat_')) {
      this.handleChannelChat(data);
    }
    // channel_is_live_{channelId} — primary stream status event
    if (eventName && eventName.startsWith('channel_is_live_')) {
      if (data?.isLive === true) {
        console.log(`Stream went live (event: ${eventName})`);
        this.emit('streamLive', data);
      } else if (data?.isLive === false) {
        console.log(`Stream went offline (event: ${eventName})`);
        this.emit('streamOffline', data);
      }
    }
    // owner_streaming_state — backup signal
    if (eventName === 'owner_streaming_state') {
      if (data?.streamingState === 'STREAMING') {
        console.log('Stream went live (event: owner_streaming_state)');
        this.emit('streamLive', data);
      } else if (data?.streamingState === 'STOPPED') {
        console.log('Stream went offline (event: owner_streaming_state)');
        this.emit('streamOffline', data);
      }
    }
  }

  handleChannelChat(data) {
    if (!data) return;
    const messageText = data.message || data.text || data.content;
    const channelId = data.channelId || data.channel_id || data.channel;
    const username = data.sender?.displayName || data.displayName || data.username || data.slug || data.name || 'Anonymous';
    const userChannelId = data.sender?.id || data.userId || data.user_id || data.id;

    if (messageText) {
      this.emit('chatMessage', {
        username,
        userId: data.userId || data.user_id || data.id,
        userChannelId,
        text: messageText,
        channelId,
        sender: data.sender,
      });
    }
  }

  async sendChatMessage(channelId, message) {
    const { authToken, visitorId } = this.config;
    const dedupeKey = `${channelId}:${message}`;
    const lastSent = this.recentMessages.get(dedupeKey);
    const now = Date.now();

    if (lastSent && now - lastSent < 3000) return true;
    this.recentMessages.set(dedupeKey, now);

    for (const [key, timestamp] of this.recentMessages.entries()) {
      if (now - timestamp > 10000) this.recentMessages.delete(key);
    }

    try {
      if (this.blazeAPI) {
        const isFollowing = await this.blazeAPI.isFollowingChannel(channelId);
        if (!isFollowing) {
          await this.blazeAPI.followChannel(channelId);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      const response = await fetch(`https://blaze.stream/bapi/chats/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          Cookie: `visitorId=${visitorId}; token=${authToken}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Visitor-Id': visitorId,
        },
        body: JSON.stringify({ message, sessionId: this.sessionId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to send message (${response.status}):`, errorText.substring(0, 100));
        return false;
      }
      return true;
    } catch (error) {
      console.error('Error sending chat message:', error.message);
      return false;
    }
  }

  startHealthMonitoring() {
    this.stopHealthMonitoring();
    this.healthCheckInterval = setInterval(() => this.checkConnectionHealth(), this.healthCheckIntervalMs);
  }

  stopHealthMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  checkConnectionHealth() {
    if (this.socket && this.socket.connected) {
      this.socket.emit('ping');
      this.lastActivityTime = Date.now();
    }
    const inactiveMs = Date.now() - this.lastActivityTime;
    if (inactiveMs > this.maxInactivityMs) {
      console.error(`Health check FAILED: No activity for ${Math.floor(inactiveMs / 1000)}s`);
      this.stopHealthMonitoring();
      this.isConnected = false;
      if (this.socket) this.socket.disconnect();
      this.emit('disconnected', 'health_check_failed');
    }
  }

  disconnect() {
    this.stopHealthMonitoring();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }
  }
}

module.exports = BlazeWebSocket;

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
    this.seenIncoming = new Set();
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
      // DEBUG: log all chat-related events to diagnose duplicates
      if (eventName.startsWith('channel_chat_') || (eventName === 'eventsub' && args[0]?.metadata?.subscriptionType?.includes('chat'))) {
        console.log(`[WS DEBUG] ${eventName}`, JSON.stringify(args[0]).substring(0, 150));
      }
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
    // channel_is_live_{channelId} — stream status from room subscription
    if (eventName && eventName.startsWith('channel_is_live_')) {
      if (data?.isLive === true) {
        console.log(`Stream went live (event: ${eventName})`);
        this.emit('streamLive', data);
      } else if (data?.isLive === false) {
        console.log(`Stream went offline (event: ${eventName})`);
        this.emit('streamOffline', data);
      }
    }
    // owner_streaming_state — only fires for own channel
    if (eventName === 'owner_streaming_state') {
      if (data?.streamingState === 'STREAMING') {
        console.log('Stream went live (event: owner_streaming_state)');
        this.emit('streamLive', data);
      } else if (data?.streamingState === 'STOPPED') {
        console.log('Stream went offline (event: owner_streaming_state)');
        this.emit('streamOffline', data);
      }
    }
    // Official Blaze EventSub — listener for stream.online/stream.offline
    if (eventName === 'eventsub') {
      // TODO: uncomment subscribeToStreamEvents() call below once we have
      // a proper App Access Token for the Blaze developer API.
      // The session_welcome event gives us the sessionId needed for subscriptions.
      // if (data?.metadata?.messageType === 'session_welcome') {
      //   this.eventSubSessionId = data.payload?.sessionId;
      //   this.subscribeToStreamEvents();
      // }
      const subType = data?.metadata?.subscriptionType;
      if (subType === 'stream.online' || subType === 'stream.offline') {
        const isLive = subType === 'stream.online';
        console.log(`Stream ${isLive ? 'went live' : 'went offline'} (event: eventsub/${subType})`);
        if (isLive) this.emit('streamLive', data.payload);
        else this.emit('streamOffline', data.payload);
      }
    }
  }

  // TODO: Enable once we have a Blaze App Access Token (register at dev.blaze.stream)
  // The internal /bapi auth token doesn't work with the developer API (api.blaze.stream).
  // Subscription endpoint: POST https://api.blaze.stream/v1/events/subscriptions
  // Required: { type: 'stream.online', version: '1', sessionId, condition: { channelId } }
  // Events: 'stream.online' and 'stream.offline' — delivered via 'eventsub' socket event
  // async subscribeToStreamEvents() {
  //   if (!this.eventSubSessionId) return;
  //   const { authToken, visitorId, targetChannelId, channelId } = this.config;
  //   const watchChannelId = targetChannelId || channelId;
  //   for (const type of ['stream.online', 'stream.offline']) {
  //     try {
  //       const response = await fetch('https://api.blaze.stream/v1/events/subscriptions', {
  //         method: 'POST',
  //         headers: {
  //           Accept: 'application/json',
  //           'Content-Type': 'application/json',
  //           Authorization: `Bearer ${authToken}`,  // Replace with App Access Token
  //           'Visitor-Id': visitorId,
  //         },
  //         body: JSON.stringify({ type, version: '1', sessionId: this.eventSubSessionId, condition: { channelId: watchChannelId } }),
  //       });
  //       if (response.ok) console.log(`EventSub subscribed: ${type}`);
  //       else console.log(`EventSub subscribe failed for ${type} (${response.status}): ${(await response.text()).substring(0, 100)}`);
  //     } catch (error) {
  //       console.log(`EventSub subscribe error for ${type}: ${error.message}`);
  //     }
  //   }
  // }

  handleChannelChat(data) {
    if (!data) return;
    const messageText = data.message || data.text || data.content;
    const channelId = data.channelId || data.channel_id || data.channel;
    const username = data.sender?.displayName || data.displayName || data.username || data.slug || data.name || 'Anonymous';
    const userChannelId = data.sender?.id || data.userId || data.user_id || data.id;
    const messageId = data.id || data.messageId;

    if (!messageText) return;

    // Deduplicate incoming messages
    const dedupeKey = messageId || `${username}:${messageText}:${Date.now() >> 10}`;
    if (this.seenIncoming.has(dedupeKey)) return;
    this.seenIncoming.add(dedupeKey);
    if (this.seenIncoming.size > 500) {
      const arr = Array.from(this.seenIncoming);
      this.seenIncoming = new Set(arr.slice(-250));
    }

    this.emit('chatMessage', {
      username,
      userId: data.userId || data.user_id || data.id,
      userChannelId,
      text: messageText,
      channelId,
      sender: data.sender,
      messageId,
    });
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

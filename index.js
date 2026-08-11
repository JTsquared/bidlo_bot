require('dotenv').config();

const BlazeTokenManager = require('./BlazeTokenManager.js');
const BlazeChatAPI = require('./BlazeChatAPI.js');
const BlazeChatPoller = require('./BlazeChatPoller.js');
const ArenaChat = require('./ArenaChat.js');
const ChatManager = require('./ChatManager.js');
const SongDatabase = require('./Database.js');
const RSPlaylist = require('./RSPlaylist.js');
const CommandHandler = require('./CommandHandler.js');
const SubscriberService = require('./SubscriberService.js');
const WebServer = require('./WebServer.js');
const TimedMessages = require('./TimedMessages.js');
const BlazeEventSub = require('./BlazeEventSub.js');

// --- Validate env ---
const streamerUsername = process.env.STREAMER_USERNAME;
if (!streamerUsername) {
  console.error('Please set STREAMER_USERNAME in .env');
  process.exit(1);
}

const targetChannelId = process.env.BIDLO_PERV_CHANNEL_ID || process.env.BLAZE_CHANNEL_ID;
const webPort = parseInt(process.env.WEB_PORT) || 3000;

// --- Blaze Token Manager ---
const blazeClientId = process.env.BLAZE_CLIENT_ID || '';
const blazeClientSecret = process.env.BLAZE_CLIENT_SECRET || '';
const tokenManager = new BlazeTokenManager(blazeClientId, blazeClientSecret);

if (process.env.BLAZE_BOT_ACCESS_TOKEN) {
  tokenManager.addToken('bot', process.env.BLAZE_BOT_ACCESS_TOKEN, process.env.BLAZE_BOT_REFRESH_TOKEN);
}
if (process.env.BLAZE_STREAMER_ACCESS_TOKEN) {
  tokenManager.addToken('streamer', process.env.BLAZE_STREAMER_ACCESS_TOKEN, process.env.BLAZE_STREAMER_REFRESH_TOKEN);
}

// --- Initialize ---
const db = new SongDatabase();
const rsChannel = process.env.RSPLAYLIST_CHANNEL || '';
const rs = new RSPlaylist(rsChannel);
const chatManager = new ChatManager();

// Blaze — official API for both sending and receiving chat
const blazeChatAPI = new BlazeChatAPI(tokenManager, blazeClientId, targetChannelId);
const blazeChatPoller = new BlazeChatPoller(tokenManager, blazeClientId, targetChannelId);
const blazeEventSub = new BlazeEventSub(tokenManager, blazeClientId);

// Arena
const arenaToken = process.env.ARENA_BEARER_TOKEN;
const arenaHandle = process.env.ARENA_STREAMER_HANDLE;
const arenaChat = (arenaToken && arenaHandle) ? new ArenaChat(arenaToken, arenaHandle) : null;

// Send functions
const sendBlaze = (channelId, message) => blazeChatAPI.sendMessage(channelId, message);

// Subscriber service using streamer's token
const subscriberService = new SubscriberService(tokenManager, blazeClientId, targetChannelId);

// Command handler
const commandHandler = new CommandHandler(db, rs, null, streamerUsername, subscriberService);

const timedSenders = [
  { send: (msg) => sendBlaze(targetChannelId, msg), name: 'blaze' },
];
if (arenaChat) {
  timedSenders.push({ send: (msg) => arenaChat.sendMessage(msg), name: 'arena' });
}
const timedMessages = new TimedMessages(timedSenders);
const webServer = new WebServer(db, timedMessages, rs, chatManager, webPort, {
  tokenManager,
  channelId: targetChannelId,
});

// --- Chat handlers ---

// Blaze chat (via official API polling)
blazeChatPoller.on('chatMessage', (data) => {
  if (!data.text) return;
  console.log(`[Blaze Chat] ${data.username}: ${data.text}`);

  chatManager.addMessage({
    platform: 'blaze',
    username: data.username,
    userId: data.userId || data.userChannelId,
    text: data.text,
    emotes: data.emotes || [],
  });

  commandHandler.sendMessage = (chId, msg) => sendBlaze(chId, msg);
  commandHandler.handle(data.username, data.userId || data.userChannelId, data.text, targetChannelId);
});

// Arena chat
if (arenaChat) {
  arenaChat.on('chatMessage', (data) => {
    console.log(`[Arena Chat] ${data.username}: ${data.text}`);
    chatManager.addMessage(data);

    commandHandler.sendMessage = (chId, msg) => arenaChat.sendMessage(msg);
    commandHandler.handle(data.username, data.userId, data.text, 'arena');
  });
}

// Raid events (via EventSub)
blazeEventSub.on('raid', (data) => {
  console.log(`[Raid] ${data.username} is raiding!${data.viewerCount ? ' (' + data.viewerCount + ' viewers)' : ''}`);
  chatManager.addMessage({
    platform: 'blaze',
    username: data.username,
    userId: data.userId,
    text: null,
    avatar: data.avatarUrl,
    type: 'raid',
    viewerCount: data.viewerCount,
  });
});

// --- Start ---
async function main() {
  console.log('Bidlo Bot starting...');

  const stats = db.getStats();
  console.log(`Database: ${stats.artists} artists, ${stats.titles} titles cached`);
  console.log('Song search: RS Playlist API (no auth required)');

  // Refresh OAuth tokens on startup
  if (process.env.BLAZE_BOT_ACCESS_TOKEN) {
    await tokenManager.refresh('bot');
  }
  if (process.env.BLAZE_STREAMER_ACCESS_TOKEN) {
    await tokenManager.refresh('streamer');
  }

  if (rsChannel) {
    await rs.loadOwnedSongs();
  }

  // Clean up old giveaway entries
  db.clearOldGiveawayEntries();

  // Load subscriber list and add daily base entries
  await subscriberService.refresh();
  async function addDailySubscriberEntries() {
    const subs = Array.from(subscriberService.subscribers.values());
    if (subs.length > 0) {
      db.addSubscriberBaseEntries(subs);
      console.log(`Giveaway: added base entries for ${subs.length} subscribers`);
    }
  }
  await addDailySubscriberEntries();

  // Schedule daily reset at midnight EDT (4:00 AM UTC)
  function scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(now.getUTCDate() + (now.getUTCHours() >= 4 ? 1 : 0));
    tomorrow.setUTCHours(4, 0, 0, 0);
    if (tomorrow.getTime() <= now.getTime()) {
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    }
    const msUntilReset = tomorrow.getTime() - now.getTime();
    console.log(`Giveaway resets in ${Math.round(msUntilReset / 3600000)}h (midnight EDT / 4am UTC)`);
    setTimeout(async () => {
      console.log('Giveaway: daily reset');
      db.clearOldGiveawayEntries();
      await subscriberService.refresh();
      await addDailySubscriberEntries();
      scheduleDailyReset();
    }, msUntilReset);
  }
  scheduleDailyReset();

  // Stream live status check
  const BLAZE_API = 'https://api.blaze.stream/v1';
  async function checkStreamLive() {
    try {
      const token = await tokenManager.getAppToken();
      if (!token) return;
      const res = await fetch(`${BLAZE_API}/channels/stream-info?channelId=${targetChannelId}`, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': blazeClientId },
      });
      if (res.ok) {
        const data = await res.json();
        const isLive = data.isLive === true || data.data?.isLive === true;
        if (isLive !== commandHandler.isStreamLive) {
          commandHandler.isStreamLive = isLive;
          console.log(`Stream is ${isLive ? 'LIVE' : 'OFFLINE'}`);
        }
      }
    } catch {}
  }
  await checkStreamLive();
  setInterval(checkStreamLive, 60000); // Check every minute

  webServer.start();

  // Start Blaze chat polling
  blazeChatPoller.start();
  console.log(`Blaze: listening to channel ${targetChannelId}`);

  // Start EventSub for raid events
  const eventSubConnected = await blazeEventSub.connect();
  if (eventSubConnected) {
    await blazeEventSub.subscribeChannel(targetChannelId, ['channel.raid']);
    console.log('EventSub: listening for raids');
  } else {
    console.log('EventSub: failed to connect (raids will not be detected)');
  }

  // Connect Arena — retry periodically if streamer isn't live yet
  if (arenaChat) {
    async function connectArena() {
      if (arenaChat.isConnected) return;
      const ok = await arenaChat.connect();
      if (ok) {
        console.log('Connected to Arena');
      }
    }
    await connectArena();
    setInterval(connectArena, 120000); // Retry every 2 minutes if not connected
  } else {
    console.log('Arena: not configured (set ARENA_BEARER_TOKEN and ARENA_STREAMER_HANDLE in .env)');
  }

  console.log(`Web UI: http://localhost:${webPort}`);
  console.log(`OBS Overlay: http://localhost:${webPort}/overlay`);
  console.log(`Chat Overlay: http://localhost:${webPort}/chat-overlay`);
}

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  timedMessages.stop();
  blazeChatPoller.stop();
  blazeEventSub.disconnect();
  if (arenaChat) arenaChat.disconnect();
  webServer.stop();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();

require('dotenv').config();

const BlazeAPI = require('./BlazeAPI.js');
const BlazeWebSocket = require('./BlazeWebSocket.js');
const ArenaChat = require('./ArenaChat.js');
const ChatManager = require('./ChatManager.js');
const SongDatabase = require('./Database.js');
const RSPlaylist = require('./RSPlaylist.js');
const CommandHandler = require('./CommandHandler.js');
const WebServer = require('./WebServer.js');
const TimedMessages = require('./TimedMessages.js');

// --- Validate env ---
const blazeConfig = {
  authToken: process.env.BLAZE_AUTH_TOKEN,
  visitorId: process.env.BLAZE_VISITOR_ID,
  channelId: process.env.BLAZE_CHANNEL_ID,
};

if (!blazeConfig.authToken || blazeConfig.authToken === 'your_auth_token_here') {
  console.error('Please set your Blaze credentials in .env (see .env.example)');
  process.exit(1);
}

const streamerUsername = process.env.STREAMER_USERNAME;
if (!streamerUsername) {
  console.error('Please set STREAMER_USERNAME in .env');
  process.exit(1);
}

const targetChannelId = process.env.BIDLO_PERV_CHANNEL_ID || blazeConfig.channelId;
const webPort = parseInt(process.env.WEB_PORT) || 3000;

// --- Initialize ---
const db = new SongDatabase();
const rsChannel = process.env.RSPLAYLIST_CHANNEL || '';
const rs = new RSPlaylist(rsChannel);
const chatManager = new ChatManager();

// Blaze
const blazeAPI = new BlazeAPI(blazeConfig);
const blazeWS = new BlazeWebSocket({ ...blazeConfig, targetChannelId }, blazeAPI);

// Arena
const arenaToken = process.env.ARENA_BEARER_TOKEN;
const arenaHandle = process.env.ARENA_STREAMER_HANDLE;
const arenaChat = (arenaToken && arenaHandle) ? new ArenaChat(arenaToken, arenaHandle) : null;

// Blaze send function
const sendBlaze = (channelId, message) => blazeWS.sendChatMessage(channelId, message);

// Command handler — responds on whichever platform the command came from
const commandHandler = new CommandHandler(db, rs, null, streamerUsername);

const timedSenders = [
  { send: (msg) => sendBlaze(targetChannelId, msg), name: 'blaze' },
];
if (arenaChat) {
  timedSenders.push({ send: (msg) => arenaChat.sendMessage(msg), name: 'arena' });
}
const timedMessages = new TimedMessages(timedSenders);
const webServer = new WebServer(db, timedMessages, rs, chatManager, webPort);

// --- Chat handlers ---

// Blaze chat
blazeWS.on('chatMessage', (data) => {
  if (!data.text || !data.channelId) return;
  console.log(`[Blaze Chat] ${data.username}: ${data.text}`);

  chatManager.addMessage({
    platform: 'blaze',
    username: data.username,
    userId: data.userId || data.userChannelId,
    text: data.text,
  });

  // Set reply function to Blaze
  commandHandler.sendMessage = (chId, msg) => sendBlaze(chId, msg);
  commandHandler.handle(data.username, data.userId || data.userChannelId, data.text, data.channelId);
});

// Arena chat
if (arenaChat) {
  arenaChat.on('chatMessage', (data) => {
    console.log(`[Arena Chat] ${data.username}: ${data.text}`);
    chatManager.addMessage(data);

    // Set reply function to Arena
    commandHandler.sendMessage = (chId, msg) => arenaChat.sendMessage(msg);
    commandHandler.handle(data.username, data.userId, data.text, 'arena');
  });
}

// --- Reconnection ---
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;
let isReconnecting = false;

async function attemptReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;

  while (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * reconnectAttempts;
    console.log(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await blazeWS.connect();
      reconnectAttempts = 0;
      isReconnecting = false;
      console.log('Reconnected successfully');
      return;
    } catch (error) {
      console.error(`Reconnect attempt ${reconnectAttempts} failed:`, error.message);
    }
  }

  isReconnecting = false;
  console.error(`Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
}

// --- Events ---
blazeWS.on('connected', () => {
  console.log('Blaze connected - bot ready');
  timedMessages.start();
});

blazeWS.on('disconnected', (reason) => {
  console.log('Blaze disconnected:', reason);
  timedMessages.stop();
  attemptReconnect();
});

// --- Start ---
async function main() {
  console.log('Bidlo Bot starting...');

  const stats = db.getStats();
  console.log(`Database: ${stats.artists} artists, ${stats.titles} titles cached`);
  console.log('Song search: RS Playlist API (no auth required)');

  if (rsChannel) {
    await rs.loadOwnedSongs();
  }

  webServer.start();

  // Connect Blaze
  try {
    await blazeWS.connect();
    console.log(`Connected to Blaze — streamer: ${streamerUsername}`);
  } catch (error) {
    console.error('Blaze connection failed:', error.message);
    attemptReconnect();
  }

  // Connect Arena
  if (arenaChat) {
    const arenaOk = await arenaChat.connect();
    if (arenaOk) {
      console.log('Connected to Arena');
    } else {
      console.warn('Arena: connection failed (streamer may not be live)');
    }
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
  blazeWS.disconnect();
  if (arenaChat) arenaChat.disconnect();
  webServer.stop();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();

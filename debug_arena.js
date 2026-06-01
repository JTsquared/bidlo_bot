require('dotenv').config();
const ArenaChat = require('./ArenaChat.js');

async function main() {
  const streamerHandle = process.argv[2] || 'BidloPerv';

  const arena = new ArenaChat(
    process.env.ARENA_BEARER_TOKEN,
    streamerHandle,
  );

  arena.on('chatMessage', (msg) => {
    const roleTag = msg.role === 'HOST' ? ' [HOST]' : '';
    console.log(`[Arena] ${msg.username}${roleTag}: ${msg.text}`);
  });

  arena.on('connected', () => {
    console.log('Listening for chat messages... (Ctrl+C to exit)');
    console.log('Type a message and press Enter to send.\n');
  });

  const ok = await arena.connect();
  if (!ok) {
    console.error('Failed to connect');
    process.exit(1);
  }

  // Send chat from stdin
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    const sent = await arena.sendMessage(line.trim());
    console.log(sent ? '[Sent]' : '[Send failed]');
  });

  process.on('SIGINT', () => {
    arena.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);

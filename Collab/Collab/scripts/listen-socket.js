#!/usr/bin/env node
// Usage: node scripts/listen-socket.js <BACKEND_URL> <TOKEN> <CONVERSATION_ID>
// Example: node scripts/listen-socket.js http://localhost:8000 "<token>" conv_emily

const [,, base, token, convId] = process.argv;
if (!base || !token || !convId) {
  console.error('Usage: node scripts/listen-socket.js <BACKEND_URL> <TOKEN> <CONVERSATION_ID>');
  process.exit(2);
}

(async () => {
  const { io } = await import('socket.io-client');
  const socket = io(base, { auth: { token }, transports: ['websocket'] });
  socket.on('connect', () => {
    console.log('connected, joining conversation', convId);
    socket.emit('CONVERSATION_JOIN', { conversationId: convId });
  });
  socket.on('connect_error', (e) => {
    console.error('connect_error', e);
    process.exit(1);
  });
  socket.on('MESSAGE_NEW', (m) => {
    console.log('MESSAGE_NEW', JSON.stringify(m, null, 2));
  });
  socket.on('disconnect', () => console.log('socket disconnected'));
})();

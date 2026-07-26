const { startEmulator } = require('./wa_emulator.cjs')
const P = require('./lib')
const pino = require('pino')
const events = []
startEmulator({ port: 8900, onEvent: e => { events.push(e); console.log('[emu]', e) } })
;(async () => {
  const { state } = await P.useMultiFileAuthState('/tmp/hsauth')
  const sock = P.makeWASocket({
    auth: state, logger: pino({level:'silent'}),
    waWebSocketUrl: 'ws://localhost:8900', printQRInTerminal: false, connectTimeoutMs: 8000
  })
  sock.ev.on('connection.update', u => {
    console.log('[lib] connection.update', JSON.stringify({
      connection: u.connection,
      hasQR: !!u.qr,
      err: u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.message,
      status: u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode,
      receivedPendingNotifications: u.receivedPendingNotifications,
      isOnline: u.isOnline
    }))
  })
  setTimeout(() => { console.log('EVENTS:', events.join(',')); process.exit(0) }, 9000)
})()

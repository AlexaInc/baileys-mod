const P = require('/home/user/baileys-mod/lib')
const pino = require('/home/user/baileys-mod/node_modules/pino')
const fs = require('fs')

const log = []
const rec = (...a) => { const s = a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '); console.log(s); log.push(s) }

;(async () => {
  const { state, saveCreds } = await P.useMultiFileAuthState('/home/user/baileys-mod/.livetest/auth')
  const { version, isLatest } = await P.fetchLatestBaileysVersion().catch(e => ({version:[2,3000,1030000000],isLatest:false,error:e.message}))
  rec('WA version:', JSON.stringify(version), 'isLatest:', String(isLatest))

  const sock = P.makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: P.Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 20000
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', u => {
    rec('EVENT connection.update keys=' + JSON.stringify(Object.keys(u)))
    if (u.qr) rec('  QR received, length=' + u.qr.length)
    if (u.connection) rec('  connection=' + u.connection)
    if (u.lastDisconnect) {
      const e = u.lastDisconnect.error
      rec('  lastDisconnect.error=' + (e && e.message))
      rec('  statusCode=' + (e && e.output && e.output.statusCode))
      rec('  date instanceof Date=' + (u.lastDisconnect.date instanceof Date))
    }
    if (u.isOnline !== undefined) rec('  isOnline=' + u.isOnline)
    if (u.receivedPendingNotifications !== undefined) rec('  receivedPendingNotifications=' + u.receivedPendingNotifications)
  })

  for (const ev of ['messages.upsert','messaging-history.set','chats.upsert','contacts.upsert','groups.upsert','call','presence.update','message-receipt.update']) {
    sock.ev.on(ev, d => rec('EVENT ' + ev + ' payloadType=' + (Array.isArray(d)?'array':typeof d) + ' keys=' + JSON.stringify(Array.isArray(d)?Object.keys(d[0]||{}):Object.keys(d||{}))))
  }

  setTimeout(() => {
    rec('--- ws readyState=' + (sock.ws && sock.ws.readyState))
    rec('--- user=' + JSON.stringify(sock.user))
    fs.writeFileSync('/home/user/baileys-mod/.livetest/out.txt', log.join('\n'))
    process.exit(0)
  }, 30000)
})().catch(e => { rec('FATAL ' + e.message); fs.writeFileSync('/home/user/baileys-mod/.livetest/out.txt', log.join('\n')); process.exit(1) })

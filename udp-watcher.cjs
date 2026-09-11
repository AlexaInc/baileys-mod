// Patient UDP egress recovery watcher: ONE STUN probe to google every 180s.
// Logs to udp-watcher.log; exits on first success (keeps the path quiet).
'use strict'
const dgram = require('dgram')
const crypto = require('crypto')
const fs = require('fs')

const LOG = __dirname + '/udp-watcher.log'
const log = (m) => fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n')

function probe() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const tx = crypto.randomBytes(12)
    const req = Buffer.alloc(20)
    req.writeUInt16BE(0x0001); req.writeUInt16BE(0); req.writeUInt32BE(0x2112a442); tx.copy(req, 8)
    const t = setTimeout(() => { sock.close(); resolve(false) }, 3500)
    sock.on('message', () => { clearTimeout(t); sock.close(); resolve(true) })
    sock.on('error', () => { clearTimeout(t); try { sock.close() } catch {} ; resolve(false) })
    sock.send(req, 19302, 'stun.l.google.com', (err) => {
      if (err) { clearTimeout(t); try { sock.close() } catch {}; resolve(false) }
    })
  })
}

;(async () => {
  log('watcher started')
  for (let i = 1; i <= 200; i++) {
    const up = await probe()
    log('probe ' + i + ': ' + (up ? 'UP ✅' : 'down'))
    if (up) { log('RECOVERED — stopping all probe traffic'); process.exit(0) }
    await new Promise((r) => setTimeout(r, 180000))
  }
  log('watcher gave up after 200 probes')
})()

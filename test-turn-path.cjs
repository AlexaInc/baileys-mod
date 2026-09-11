// Full TURN-over-TCP probe with connection retries (the sandbox gateway's TCP
// proxy flakes on first connects; libwebrtc retries and wins — so do we).
// Flow: allocate (long-term auth) → permission toward a WhatsApp relay →
// STUN binding (bare, no USERNAME) via SEND indication → expect DATA back.
'use strict'
const net = require('net')
const crypto = require('crypto')

const CF_TURN = { host: 'turn.cloudflare.com', port: 3478 }
const WA_RELAY = { host: process.argv[4] || '157.240.11.51', port: 3478 }
const USERNAME = process.argv[2]
const CREDENTIAL = process.argv[3]
if (!USERNAME || !CREDENTIAL) {
  console.error('usage: node test-turn-path.cjs <username> <credential> [relayIp]')
  process.exit(1)
}

const MAGIC = 0x2112a442

function attr(t, v) {
  const h = Buffer.alloc(4)
  h.writeUInt16BE(t, 0); h.writeUInt16BE(v.length, 2)
  return Buffer.concat([h, v, Buffer.alloc((4 - v.length % 4) % 4)])
}
function msg(type, attrs) {
  const len = attrs.reduce((n, a) => n + a.length, 0)
  const h = Buffer.alloc(20)
  h.writeUInt16BE(type, 0); h.writeUInt16BE(len, 2); h.writeUInt32BE(MAGIC, 4)
  crypto.randomBytes(12).copy(h, 8)
  return Buffer.concat([h, ...attrs])
}
function parseAttrs(buf) {
  const out = []
  const len = buf.readUInt16BE(2)
  let p = 20
  while (p + 4 <= 20 + len) {
    const t = buf.readUInt16BE(p), l = buf.readUInt16BE(p + 2)
    out.push([t, buf.subarray(p + 4, p + 4 + l)])
    p += 4 + l + ((4 - l % 4) % 4)
  }
  return out
}
function xorAddr(ip, port) {
  const b = Buffer.from(ip.split('.').map(Number))
  const out = Buffer.alloc(8)
  out.writeUInt8(0, 0); out.writeUInt8(1, 1)
  out.writeUInt16BE(port ^ (MAGIC >>> 16), 2)
  out[4] = b[0] ^ 0x21; out[5] = b[1] ^ 0x12; out[6] = b[2] ^ 0xa4; out[7] = b[3] ^ 0x42
  return out
}
function unxorAddr(v) {
  return {
    ip: `${v[4] ^ 0x21}.${v[5] ^ 0x12}.${v[6] ^ 0xa4}.${v[7] ^ 0x42}`,
    port: v.readUInt16BE(2) ^ (MAGIC >>> 16),
  }
}
let REALM = '', NONCE = ''
const authKey = () => crypto.createHash('md5').update(USERNAME + ':' + REALM + ':' + CREDENTIAL).digest()
function withAuth(type, attrs) {
  const base = attrs.slice()
  base.push(attr(0x0006, Buffer.from(USERNAME, 'utf8')))
  base.push(attr(0x0014, Buffer.from(REALM, 'utf8')))
  base.push(attr(0x0015, Buffer.from(NONCE, 'utf8')))
  const lenNoMI = base.reduce((n, a) => n + a.length, 0)
  const head = Buffer.alloc(20)
  head.writeUInt16BE(type, 0); head.writeUInt16BE(lenNoMI + 24, 2); head.writeUInt32BE(MAGIC, 4)
  crypto.randomBytes(12).copy(head, 8)
  const body = Buffer.concat([head, ...base])
  const mi = crypto.createHmac('sha1', authKey()).update(body).digest()
  return Buffer.concat([body, attr(0x0008, mi)])
}

let sock = null
let buf = Buffer.alloc(0)
let attempt = 0
const maxAttempts = 8
let phase = 'connect' // connect → allocated → perm → probed

function connect() {
  sock = net.connect(CF_TURN.port, CF_TURN.host)
  sock.setTimeout(8000)
  buf = Buffer.alloc(0)
  sock.on('connect', () => {
    if (phase === 'connect') {
      console.log('[1] TCP connected (attempt ' + (attempt + 1) + ')')
      sock.write(msg(0x0003, [attr(0x0019, Buffer.from([17, 0, 0, 0]))]))
    }
  })
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 20) {
      const len = buf.readUInt16BE(2)
      if (buf.length < 20 + len) break
      handle(buf.subarray(0, 20 + len))
      buf = buf.subarray(20 + len)
    }
  })
  sock.on('timeout', () => {
    if (phase === 'probed') {
      console.log('❌ no DATA indication from WA relay (silent via TURN path)')
      process.exit(1)
    }
    console.log('    timeout'); sock.destroy()
  })
  sock.on('error', (e) => { console.log('    ' + (e.code || e.message)) })
  sock.on('close', () => {
    if (phase !== 'probed') retry()
  })
}
function retry() {
  attempt++
  if (attempt >= maxAttempts) {
    console.log('❌ giving up after ' + attempt + ' attempts')
    process.exit(1)
  }
  setTimeout(connect, 350)
}

function handle(m) {
  const type = m.readUInt16BE(0)
  const attrs = parseAttrs(m)
  const get = (t) => attrs.find(([at]) => at === t)?.[1]

  if (type === 0x0113) {
    const err = get(0x0009)
    const code = err ? err.readUInt8(2) * 100 + err.readUInt8(3) : 0
    const why = err ? err.subarray(4).toString() : ''
    const realm = get(0x0014)?.toString()
    const nonce = get(0x0015)?.toString()
    console.log('    error ' + code + ' ' + why + (realm ? ' realm✓' : '') + (nonce ? ' nonce✓' : ''))
    if (code === 401 && realm && nonce) {
      REALM = realm; NONCE = nonce
      sock.write(withAuth(0x0003, [attr(0x0019, Buffer.from([17, 0, 0, 0]))]))
      console.log('[2] authenticated allocate sent')
      return
    }
    console.log('❌ allocate failed'); process.exit(1)
  }
  if (type === 0x0103) {
    const r = get(0x0016) ? unxorAddr(get(0x0016)) : null
    const lifetime = get(0x000d)?.readUInt32BE(0)
    console.log('[3] ✅ ALLOCATE SUCCESS — relayed=' + (r ? r.ip + ':' + r.port : '??') + ' lifetime=' + lifetime + 's')
    phase = 'allocated'
    sock.write(withAuth(0x0008, [attr(0x0012, xorAddr(WA_RELAY.host, WA_RELAY.port))]))
    console.log('[4] create-permission → ' + WA_RELAY.host + ':' + WA_RELAY.port)
    setTimeout(() => {
      // BARE STUN binding request (no USERNAME / MI) — the form the WA relay
      // is known to answer from arbitrary IPs.
      const bind = Buffer.alloc(20)
      bind.writeUInt16BE(0x0001, 0); bind.writeUInt16BE(0, 2); bind.writeUInt32BE(MAGIC, 4)
      crypto.randomBytes(12).copy(bind, 8)
      sock.write(msg(0x0016, [attr(0x0012, xorAddr(WA_RELAY.host, WA_RELAY.port)), attr(0x0013, bind)]))
      console.log('[5] bare STUN binding → WA relay via TURN; waiting…')
      // resend a few times (TURN/relay packet loss tolerance)
      const iv = setInterval(() => {
        try {
          const b2 = Buffer.alloc(20)
          b2.writeUInt16BE(0x0001, 0); b2.writeUInt16BE(0, 2); b2.writeUInt32BE(MAGIC, 4)
          crypto.randomBytes(12).copy(b2, 8)
          sock.write(msg(0x0016, [attr(0x0012, xorAddr(WA_RELAY.host, WA_RELAY.port)), attr(0x0013, b2)]))
        } catch {}
      }, 1500)
      setTimeout(() => { clearInterval(iv); console.log('❌ no DATA indication after 12s'); process.exit(1) }, 12000)
    }, 400)
    return
  }
  if (type === 0x0108) {
    console.log('    ✅ permission OK — sending probe')
    phase = 'probed'
    return
  }
  if (type === 0x0118) {
    const err = get(0x0009)
    console.log('❌ permission error ' + (err ? err.readUInt8(2) * 100 + err.readUInt8(3) + ' ' + err.subarray(4).toString() : '?'))
    process.exit(1)
  }
  if (type === 0x0017) {
    const p = get(0x0012) ? unxorAddr(get(0x0012)) : null
    const data = get(0x0013)
    console.log('[6] 🎉 DATA from ' + (p ? p.ip + ':' + p.port : '??') + ' — ' + (data ? data.length : 0) + ' bytes')
    if (data && data.length >= 20) {
      const dt = data.readUInt16BE(0)
      console.log('    inner type 0x' + dt.toString(16) + (dt === 0x0101 ? ' = BINDING SUCCESS ✅ WA RELAY ANSWERS VIA CLOUDFLARE TURN' : ''))
    }
    process.exit(0)
  }
  console.log('    (unhandled type 0x' + type.toString(16) + ')')
}

connect()
// (extension at bottom is documentation only)

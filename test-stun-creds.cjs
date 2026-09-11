// Probe the live relay (from the captured relay block) with credentialed STUN
// binding requests to find the exact ufrag formulation the relay accepts.
'use strict'
const dgram = require('dgram')
const crypto = require('crypto')

const KEY_ASCII = 'xm9yryebuQ+u6DXNUNZzug=='
const TOKEN_HEX = '090f01f5dcef6ad4c451eb7543151b10c632149b0b4fe905cb1d6b570d21cee1ea506f127bdc68c9150ace66f44e74febb73940948db5f8437c85392a0a692500306bfc2dc8b71bc93fc345d4ba0d3e4ef28f96d6748980401aa262f2281c4fe76cd1fce2776f74f91c3e8adfa8a3edd3959a5211d38421602ddce57178cdfda03906a30b0a7d6395bd73fb39512cb346464f9daa2d13fa5b33bb6f9721e7783161f9b5ec03cee465fc5c21c19c946c785431a8a82667961e3d0b23e761ba1'
const RELAY = { host: '157.240.11.51', port: 3478 } // lax3c02, tokenId=2

const token = Buffer.from(TOKEN_HEX, 'hex')

function attr(t, v) { const h = Buffer.alloc(4); h.writeUInt16BE(t); h.writeUInt16BE(v.length); return Buffer.concat([h, v, Buffer.alloc((4 - v.length % 4) % 4)]) }

function bindingRequest(usernameStr, pwd) {
    const tx = crypto.randomBytes(12)
    const username = Buffer.from(usernameStr, 'utf8')
    let body = attr(0x0006, username) // USERNAME
    const prio = Buffer.alloc(4); prio.writeUInt32BE(1845501695)
    body = Buffer.concat([body, attr(0x0024, prio)]) // PRIORITY
    // also SOFTWARE + ICE-CONTROLLED like libjuice? keep minimal first
    const msgLen = body.length + 24
    const ph = Buffer.alloc(20); ph.writeUInt16BE(0x0001); ph.writeUInt16BE(msgLen); ph.writeUInt32BE(0x2112a442); tx.copy(ph, 8)
    const mi = crypto.createHmac('sha1', Buffer.from(pwd, 'utf8')).update(ph).update(body).digest()
    body = Buffer.concat([body, attr(0x0008, mi)])
    const req = Buffer.alloc(20 + body.length)
    req.writeUInt16BE(0x0001); req.writeUInt16BE(body.length); req.writeUInt32BE(0x2112a442); tx.copy(req, 8); body.copy(req, 20)
    return req
}

function probe(label, usernameStr, pwd) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        const req = bindingRequest(usernameStr, pwd)
        let answered = false
        sock.on('message', (m, rinfo) => {
            answered = true
            // check MI presence: walk attrs
            let off = 20, attrs = []
            while (off + 4 <= m.length) { const t = m.readUInt16BE(off), l = m.readUInt16BE(off + 2); attrs.push(t.toString(16).padStart(4, '0')); off += 4 + l + ((4 - l % 4) % 4) }
            console.log(`✅ ${label}: got ${m.length}B reply type=0x${m.readUInt16BE(0).toString(16)} attrs=[${attrs.join(',')}]`)
            sock.close(); resolve(true)
        })
        const timer = setInterval(() => { try { sock.send(req, RELAY.port, RELAY.host) } catch { } }, 400)
        setTimeout(() => { clearInterval(timer); sock.close(); if (!answered) console.log(`❌ ${label}: no reply`); resolve(answered) }, 2500)
    })
}

;(async () => {
    const b64full = token.toString('base64')
    const localFrag = '4Yk2X9Qm' // arbitrary local ufrag like libjuice would use
    const pwd = KEY_ASCII

    await probe('bare request (control)', null, pwd).catch(() => { })
    // NOTE: probe with null username won't include USERNAME attr — handle:
})()

// control: bare request without USERNAME
function bare() {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        const tx = crypto.randomBytes(12)
        const req = Buffer.alloc(20)
        req.writeUInt16BE(0x0001); req.writeUInt16BE(0); req.writeUInt32BE(0x2112a442); tx.copy(req, 8)
        let answered = false
        sock.on('message', () => { answered = true })
        const timer = setInterval(() => { try { sock.send(req, RELAY.port, RELAY.host) } catch { } }, 400)
        setTimeout(() => { clearInterval(timer); sock.close(); console.log(answered ? '✅ bare: replies' : '❌ bare: no reply'); resolve() }, 2000)
    })
}

;(async () => {
    await bare()
    const b64 = Buffer.from(TOKEN_HEX, 'hex').toString('base64')
    const localFrag = '4Yk2X9Qm'
    // libjuice USERNAME format: remoteUfrag:localUfrag
    await probe(`full b64 ufrag (${b64.length} ch)`, `${b64}:${localFrag}`, KEY_ASCII)
    await probe(`b64 ufrag no padding`, `${b64.replace(/=+$/, '')}:${localFrag}`, KEY_ASCII)
    await probe(`b64 ufrag truncated 32`, `${b64.slice(0, 32)}:${localFrag}`, KEY_ASCII)
    await probe(`latin1 ufrag`, `${Buffer.from(TOKEN_HEX, 'hex').toString('latin1')}:${localFrag}`, KEY_ASCII)
    await probe(`hex ufrag`, `${TOKEN_HEX}:${localFrag}`, KEY_ASCII)
    process.exit(0)
})()

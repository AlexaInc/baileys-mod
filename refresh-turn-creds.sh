#!/bin/bash
# Refresh Cloudflare TURN creds into turn-creds.json (TCP+TLS urls only).
curl -s --max-time 15 \
  -H 'Accept: application/json' \
  -H 'Origin: https://speed.cloudflare.com' \
  -H 'Referer: https://speed.cloudflare.com/' \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  https://speed.cloudflare.com/turn-creds | node -e "
let s = ''
process.stdin.on('data', d => s += d)
process.stdin.on('end', () => {
  const c = JSON.parse(s)
  const urls = c.urls.filter(u => u.includes('transport=tcp'))
  if (!urls.length || !c.username) { console.error('bad creds response'); process.exit(1) }
  require('fs').writeFileSync('turn-creds.json', JSON.stringify({ urls, username: c.username, credential: c.credential }, null, 2))
  console.log('turn-creds.json refreshed:', urls.join(', '))
})"

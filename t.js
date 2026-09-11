console.log((()=>{const b=Buffer.alloc(4); b.writeUInt16BE(0x0019,0); return b.toString("hex")})())

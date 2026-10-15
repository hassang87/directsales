// Minimal CBOR decoder covering what WebAuthn uses: integers, byte/text strings, arrays, maps, true/false/null.
// Rejects indefinite lengths, floats and tags, which WebAuthn authenticator data does not need.

export function decodeCbor(buf, offset = 0) {
  const view = buf;
  function readLen(info) {
    if (info < 24) return info;
    if (info === 24) return view[offset++];
    if (info === 25) { const v = view.readUInt16BE(offset); offset += 2; return v; }
    if (info === 26) { const v = view.readUInt32BE(offset); offset += 4; return v; }
    if (info === 27) {
      const v = view.readBigUInt64BE(offset); offset += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer too large');
      return Number(v);
    }
    throw new Error('Unsupported CBOR length encoding');
  }
  function item(depth) {
    if (depth > 16) throw new Error('CBOR nesting too deep');
    if (offset >= view.length) throw new Error('Truncated CBOR');
    const byte = view[offset++];
    const major = byte >> 5, info = byte & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); if (offset + n > view.length) throw new Error('Truncated CBOR bytes'); const b = view.subarray(offset, offset + n); offset += n; return Buffer.from(b); }
      case 3: { const n = readLen(info); if (offset + n > view.length) throw new Error('Truncated CBOR text'); const s = view.subarray(offset, offset + n).toString('utf8'); offset += n; return s; }
      case 4: { const n = readLen(info); const a = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: { const n = readLen(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('Unsupported CBOR simple value');
      default: throw new Error('Unsupported CBOR type');
    }
  }
  const value = item(0);
  return { value, offset };
}

/** Encoder for the small set of values tests need to build fake authenticator responses. */
export function encodeCbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (v === null) return Buffer.from([0xf6]);
  throw new Error('Cannot encode value');
}

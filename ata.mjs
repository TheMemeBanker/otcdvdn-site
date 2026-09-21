/**
 * Associated Token Account derivation — zero dependencies, browser + node.
 *
 * Public RPCs 403 browser calls to getTokenAccountsByOwner (indexed), but
 * plain getAccountInfo on a derived ATA passes. So we derive the ATA
 * ourselves: PDA of [owner, TOKEN_PROGRAM, mint] under the associated-token
 * program — sha256 via WebCrypto, plus an ed25519 on-curve check done with
 * BigInt field math (a PDA must NOT be on the curve).
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("bad base58 char");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === "1") out.unshift(0);
    else break;
  }
  return new Uint8Array(out);
}

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

// ---- ed25519 on-curve test: -x² + y² = 1 + d·x²·y² has a solution x for y
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function mod(a) {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function pow(base, exp) {
  let r = 1n;
  base = mod(base);
  while (exp > 0n) {
    if (exp & 1n) r = mod(r * base);
    base = mod(base * base);
    exp >>= 1n;
  }
  return r;
}

/** Is this 32-byte value a valid ed25519 point? (PDAs must not be.) */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] & (i === 31 ? 0x7f : 0xff));
  if (y >= P) return false;
  const y2 = mod(y * y);
  // x² = (y² − 1) / (d·y² + 1)
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = mod(u * pow(v, P - 2n));
  // Euler criterion: x² is a QR mod p iff x2^((p−1)/2) ∈ {0, 1}
  const chi = pow(x2, (P - 1n) / 2n);
  return chi === 0n || chi === 1n;
}

async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  const digest = await subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** findProgramAddress([owner, tokenProgram, mint], ataProgram) */
export async function deriveAta(ownerB58, mintB58, tokenProgramB58 = TOKEN_PROGRAM) {
  const owner = b58decode(ownerB58);
  const token = b58decode(tokenProgramB58);
  const mint = b58decode(mintB58);
  const program = b58decode(ATA_PROGRAM);
  if (owner.length !== 32 || mint.length !== 32) throw new Error("bad address length");

  for (let bump = 255; bump >= 0; bump--) {
    const buf = new Uint8Array(32 * 3 + 1 + 32 + PDA_MARKER.length);
    let o = 0;
    for (const part of [owner, token, mint]) {
      buf.set(part, o);
      o += 32;
    }
    buf[o++] = bump;
    buf.set(program, o);
    o += 32;
    buf.set(PDA_MARKER, o);
    const hash = await sha256(buf);
    if (!isOnCurve(hash)) return b58encode(hash);
  }
  throw new Error("no viable bump");
}

// Token encryption at rest (spec §6.2 "encrypted_tokens", §14 "AES-GCM with a
// key in Worker Secrets"). One helper for every integration (Basecamp, Google):
//
//   encrypted = "v1:" + base64url(iv) + ":" + base64url(ciphertext+tag)
//
// The key is 32 random bytes, base64-encoded, set with
// `wrangler secret put TOKEN_ENCRYPTION_KEY`; it never appears in a file.
// A random 96-bit IV per value. `aad` binds a ciphertext to its row (e.g. the
// user id), so a value copied to another row fails to decrypt.

const VERSION = 'v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const b64url = {
  encode(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  decode(text: string): Uint8Array {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
    const raw = atob(padded)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
  },
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0))
  if (bytes.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptJson(keyBase64: string, value: unknown, aad: string): Promise<string> {
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = encoder.encode(JSON.stringify(value))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, data))
  return `${VERSION}:${b64url.encode(iv)}:${b64url.encode(sealed)}`
}

export async function decryptJson<T>(keyBase64: string, encrypted: string, aad: string): Promise<T> {
  const [version, ivText, sealedText] = encrypted.split(':')
  if (version !== VERSION || !ivText || !sealedText) throw new Error('unsupported encrypted token format')
  const key = await importKey(keyBase64)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64url.decode(ivText), additionalData: encoder.encode(aad) },
    key,
    b64url.decode(sealedText),
  )
  return JSON.parse(decoder.decode(plain)) as T
}

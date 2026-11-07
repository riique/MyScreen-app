/** Chaves efêmeras do vídeo do UAC. A chave privada fica na instância que pediu o acesso. */
export async function createUacKeyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const publicKey = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { publicKey, privateKey: keys.privateKey };
}

export async function deriveUacKey(privateKey: CryptoKey, publicKey: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const remote = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: remote }, privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

const IV_BYTES = 12;

function frameContext(sessionId: string, generation: number) {
  return new TextEncoder().encode(sessionId + "/" + generation);
}

export async function encryptUacFrame(
  key: CryptoKey, sessionId: string, generation: number, frame: ArrayBuffer,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: frameContext(sessionId, generation) }, key, frame);
  const encrypted = new Uint8Array(IV_BYTES + body.byteLength);
  encrypted.set(iv);
  encrypted.set(new Uint8Array(body), IV_BYTES);
  return encrypted;
}

export function decryptUacFrame(
  key: CryptoKey, sessionId: string, generation: number, frame: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({
    name: "AES-GCM", iv: frame.subarray(0, IV_BYTES), additionalData: frameContext(sessionId, generation),
  }, key, frame.subarray(IV_BYTES));
}

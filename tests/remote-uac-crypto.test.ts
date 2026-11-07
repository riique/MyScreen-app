import { expect, it } from "vitest";
import {
  createUacKeyPair,
  decryptUacFrame,
  deriveUacKey,
  encryptUacFrame,
} from "../src/renderer/components/conference/remote/uacVideoCrypto";

it("cifra o quadro para o controlador original e autentica a sessão e o aviso", async () => {
  const [host, controller, stranger] = await Promise.all([createUacKeyPair(), createUacKeyPair(), createUacKeyPair()]);
  const [send, receive, wrong] = await Promise.all([
    deriveUacKey(host.privateKey, controller.publicKey),
    deriveUacKey(controller.privateKey, host.publicKey),
    deriveUacKey(stranger.privateKey, host.publicKey),
  ]);
  const session = "AAECAwQFBgcICQoLDA0ODw";
  const frame = new Uint8Array([255, 216, 255, 217]);
  const cipher = await encryptUacFrame(send, session, 42, frame.buffer);
  expect(cipher).not.toEqual(frame);
  expect(new Uint8Array(await decryptUacFrame(receive, session, 42, cipher))).toEqual(frame);
  await expect(decryptUacFrame(wrong, session, 42, cipher)).rejects.toThrow();
  await expect(decryptUacFrame(receive, session, 43, cipher)).rejects.toThrow();
  await expect(decryptUacFrame(receive, "EBESExQVFhcYGRobHB0eHw", 42, cipher)).rejects.toThrow();
});

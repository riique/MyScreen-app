import net from "node:net";
import { dialog, type BrowserWindow } from "electron";
import { expect, it, vi } from "vitest";
import { RemoteAdmin } from "../src/main/remoteAdmin";
import type { RemoteAdminEvent } from "@shared/ipc";
import type { Ctl } from "@shared/remote/protocol";

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));

const sessionId = "AAECAwQFBgcICQoLDA0ODw";
const controller = { identity: "ana", sid: "PA_ana", name: "Ana" };
const request = { t: "admin-request", sessionId, publicKey: "B" + "A".repeat(86) } as const;
const window = {
  isDestroyed: () => false,
  getNativeWindowHandle: () => Buffer.alloc(8),
} as BrowserWindow;

function packet(body: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([size, body]);
}

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path, () => resolve(socket));
    socket.on("error", reject);
  });
}

it("recusar no PC controlado encerra o pedido sem elevar", async () => {
  vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });
  const send = vi.fn();
  const authorize = vi.fn();
  const admin = new RemoteAdmin({
    executable: () => "myscreen-uac.exe",
    window: () => window,
    showWindow: vi.fn(),
    allowed: () => true,
    authorize,
    releaseInput: vi.fn(),
    send,
    emit: vi.fn(),
  });
  admin.handle(controller, request);
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith("ana", { t: "admin-status", sessionId, status: "refused" }));
  expect(authorize).not.toHaveBeenCalled();
  expect(admin.blocksInput).toBe(false);
});

it.skipIf(process.platform !== "win32")("autentica o worker e só encaminha cliques do SID e aviso ativos", async () => {
  vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false });
  const events: RemoteAdminEvent[] = [];
  const messages: Ctl[] = [];
  const commands: Buffer[] = [];
  const sockets: net.Socket[] = [];
  const admin = new RemoteAdmin({
    executable: () => "myscreen-uac.exe",
    window: () => window,
    showWindow: vi.fn(),
    allowed: (peer, id) => peer.sid === controller.sid && id === sessionId,
    releaseInput: vi.fn(),
    send: (_, msg) => messages.push(msg),
    emit: (event) => events.push(event),
    authorize: async (_, args) => {
      const nonce = args.split(" ").at(-1)!;
      const path = "\\\\.\\pipe\\myscreen-uac-" + nonce.slice(0, 32);
      const fake = await connect(path);
      sockets.push(fake);
      fake.write(packet(Buffer.concat([Buffer.from([3]), Buffer.alloc(64, 0x30)])));
      await new Promise<void>((resolve) => fake.once("close", () => resolve()));
      expect(events).toHaveLength(0);

      const worker = await connect(path);
      sockets.push(worker);
      worker.on("data", (data: Buffer) => commands.push(data));
      const rgba = Buffer.from([255, 0, 0, 255]);
      const frame = Buffer.alloc(9);
      frame[0] = 2;
      frame.writeUInt32LE(42, 1);
      frame.writeUInt16LE(1, 5);
      frame.writeUInt16LE(1, 7);
      const hello = packet(Buffer.concat([Buffer.from([3]), Buffer.from(nonce)]));
      worker.write(hello.subarray(0, 2));
      worker.write(Buffer.concat([hello.subarray(2), packet(Buffer.from([1])), packet(Buffer.concat([frame, rgba]))]));
      return true;
    },
  });
  try {
    admin.handle(controller, request);
    await vi.waitFor(() => expect(events.at(-1)?.t).toBe("frame"));
    const frame = events.at(-1);
    if (frame?.t !== "frame") throw new Error("Aviso simulado ausente");
    const click = { t: "admin-click", sessionId, generation: frame.generation, x: 200, y: 300 } as const;
    admin.handle({ ...controller, sid: "PA_other" }, click);
    admin.handle(controller, { ...click, generation: click.generation ^ 1 });
    expect(commands).toHaveLength(0);
    admin.handle(controller, click);
    await vi.waitFor(() => expect(Buffer.concat(commands)).toEqual(Buffer.from([42, 0, 0, 0, 200, 0, 44, 1])));
    admin.stop();
    expect(admin.blocksInput).toBe(false);
    expect(events.at(-1)).toEqual({ t: "end", sessionId });
    expect(messages.at(-1)).toEqual({ t: "admin-status", sessionId, status: "revoked" });
  } finally {
    admin.stop();
    for (const socket of sockets) socket.destroy();
  }
});

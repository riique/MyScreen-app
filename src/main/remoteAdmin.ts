import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { dialog, type BrowserWindow } from "electron";
import type { RemoteAdminEvent } from "../shared/ipc";
import type { AdminStatus, Ctl } from "../shared/remote/protocol";
import type { Peer } from "./remoteGate";

type Command = Extract<Ctl, { t: "admin-request" | "admin-stop" | "admin-click" }>;
type Access = {
  peer: Peer;
  sessionId: string;
  publicKey: string;
  abort: AbortController;
  dispose?: () => void;
  socket?: net.Socket;
  secure: boolean;
  prompt: { native: number; generation: number } | null;
  lastClick: number;
};

type Options = {
  executable(): string | null;
  window(): BrowserWindow | null;
  showWindow(): void;
  authorize(exe: string, args: string, hwnd: number): Promise<boolean>;
  allowed(peer: Peer, sessionId: string): boolean;
  releaseInput(): void;
  send(to: string, msg: Ctl): void;
  emit(event: RemoteAdminEvent): void;
};

const MAX_FRAME = 9 + 1024 * 768 * 4;
const APPROVAL_MS = 60_000;
const RETRY_MS = 30_000;

export class RemoteAdmin {
  private access: Access | null = null;
  private requestAt = 0;
  private lastSession: string | null = null;

  constructor(private readonly options: Options) {}

  get blocksInput(): boolean {
    return this.access?.secure === true;
  }

  handle(peer: Peer, msg: Command): void {
    if (!this.options.allowed(peer, msg.sessionId)) return;
    if (msg.t === "admin-request") {
      if (this.access || (this.lastSession === msg.sessionId && Date.now() - this.requestAt < RETRY_MS)) return;
      this.requestAt = Date.now();
      this.lastSession = msg.sessionId;
      void this.start(peer, msg.sessionId, msg.publicKey);
      return;
    }
    const access = this.access;
    if (!access || access.sessionId !== msg.sessionId || access.peer.sid !== peer.sid) return;
    if (msg.t === "admin-stop") {
      this.stop();
    } else if (msg.t === "admin-click" && access.secure && access.socket && access.prompt?.generation === msg.generation) {
      const now = Date.now();
      if (now - access.lastClick < 350 || access.socket.writableLength > 64) return;
      access.lastClick = now;
      const click = Buffer.alloc(8);
      click.writeUInt32LE(access.prompt.native, 0);
      click.writeUInt16LE(msg.x, 4);
      click.writeUInt16LE(msg.y, 6);
      access.socket.write(click);
    }
  }

  stop(status: AdminStatus = "revoked"): void {
    const access = this.access;
    if (!access) return;
    this.access = null;
    access.abort.abort();
    access.dispose?.();
    if (access.socket) this.options.emit({ t: "end", sessionId: access.sessionId });
    this.options.send(access.peer.identity, { t: "admin-status", sessionId: access.sessionId, status });
  }

  private async start(peer: Peer, sessionId: string, publicKey: string): Promise<void> {
    const exe = this.options.executable();
    if (!exe) {
      this.options.send(peer.identity, { t: "admin-status", sessionId, status: "unavailable" });
      return;
    }
    const access: Access = {
      peer, sessionId, publicKey, abort: new AbortController(), secure: true, prompt: null, lastClick: 0,
    };
    this.access = access;
    this.options.releaseInput();
    this.options.send(peer.identity, { t: "admin-status", sessionId, status: "waiting" });
    const timeout = setTimeout(() => {
      if (this.access === access && !access.socket) this.stop("unavailable");
    }, APPROVAL_MS);

    try {
      this.options.showWindow();
      const win = this.options.window();
      if (!win) {
        this.stop("unavailable");
        return;
      }
      const label = peer.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, 80);
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        title: "Acesso administrativo do MyScreen",
        message: "Permitir que " + label + " responda aos avisos do UAC?",
        detail: "O controlador poderá aprovar ou recusar operações administrativas nesta sessão. O Windows pedirá sua confirmação agora.",
        buttons: ["Recusar", "Continuar"],
        defaultId: 0,
        cancelId: 0,
        signal: access.abort.signal,
      });
      if (!this.stillAllowed(access)) return;
      if (response !== 1) {
        this.stop("refused");
        return;
      }
      const nonce = randomBytes(32).toString("hex");
      await this.listen(access, nonce);
      if (!this.stillAllowed(access) || win.isDestroyed()) return;
      const hwnd = Number(win.getNativeWindowHandle().readBigInt64LE(0));
      if (!await this.options.authorize(exe, "--authorize " + process.pid + " " + nonce, hwnd) &&
          this.access === access) this.stop("refused");
    } catch {
      if (this.access === access) this.stop("unavailable");
    } finally {
      if (this.access !== access || access.socket) clearTimeout(timeout);
      else access.abort.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    }
  }

  private stillAllowed(access: Access): boolean {
    return this.access === access && this.options.allowed(access.peer, access.sessionId);
  }

  private listen(access: Access, nonce: string): Promise<void> {
    const pending = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      if (!this.stillAllowed(access) || access.socket || pending.size >= 4) {
        socket.destroy();
        return;
      }
      pending.add(socket);
      socket.setTimeout(3000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        pending.delete(socket);
        if (this.access === access && access.socket === socket) this.stop("unavailable");
      });
      let length = 0;
      socket.on("readable", () => {
        while (this.stillAllowed(access)) {
          if (!length) {
            const size = socket.read(4) as Buffer | null;
            if (!size) return;
            length = size.readUInt32LE();
            if (length < 1 || length > (access.socket === socket ? MAX_FRAME : 65)) {
              socket.destroy();
              return;
            }
          }
          const data = socket.read(length) as Buffer | null;
          if (!data) return;
          length = 0;
          if (access.socket === socket) {
            if (!this.packet(access, data)) socket.destroy();
            continue;
          }
          if (access.socket || data.length !== 65 || data[0] !== 3 ||
              !timingSafeEqual(data.subarray(1), Buffer.from(nonce))) {
            socket.destroy();
            return;
          }
          access.socket = socket;
          socket.setTimeout(0);
          server.close();
          for (const client of pending) if (client !== socket) client.destroy();
          this.options.emit({
            t: "authorized", sessionId: access.sessionId, identity: access.peer.identity, sid: access.peer.sid, publicKey: access.publicKey,
          });
          this.options.send(access.peer.identity, { t: "admin-status", sessionId: access.sessionId, status: "enabled" });
        }
      });
    });
    access.dispose = () => {
      server.close();
      for (const socket of pending) socket.destroy();
    };
    const pipe = "\\\\.\\pipe\\myscreen-uac-" + nonce.slice(0, 32);
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Autorização encerrada"));
      access.abort.signal.addEventListener("abort", abort, { once: true });
      server.once("error", reject);
      server.listen(pipe, () => {
        access.abort.signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  }

  private packet(access: Access, data: Buffer): boolean {
    if (data.length === 1 && (data[0] === 0 || data[0] === 1)) {
      access.secure = data[0] === 1;
      access.prompt = null;
      this.options.releaseInput();
      this.options.emit({ t: "desktop", sessionId: access.sessionId, secure: access.secure });
      this.options.send(access.peer.identity, {
        t: "admin-view", sessionId: access.sessionId, desktop: access.secure ? "local" : "normal",
      });
      return true;
    }
    if (data[0] !== 2 || data.length < 9 || !access.secure) return false;
    const width = data.readUInt16LE(5);
    const height = data.readUInt16LE(7);
    if (width < 1 || width > 1024 || height < 1 || height > 768 || data.length !== 9 + width * height * 4) return false;
    const native = data.readUInt32LE(1);
    if (access.prompt?.native !== native) access.prompt = { native, generation: randomBytes(4).readUInt32LE() };
    this.options.emit({
      t: "frame", sessionId: access.sessionId, generation: access.prompt.generation, width, height,
      rgba: new Uint8Array(data.subarray(9)),
    });
    return true;
  }
}

/**
 * A identidade que o servidor deu nesta sala, guardada por sala. Voltar à
 * mesma sala depois de reiniciar o app reusa a identidade (com a prova do
 * servidor), então o histórico do chat reconhece o que é seu — e você pode
 * apagar o que mandou antes.
 */

const KEY = (roomId: string) => `myscreen:room-identity:${roomId}`;

export interface RoomIdentity {
  identity: string;
  proof: string;
}

export function readRoomIdentity(roomId: string): RoomIdentity | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(roomId)) ?? "null") as Partial<RoomIdentity> | null;
    return raw && typeof raw.identity === "string" && typeof raw.proof === "string"
      ? { identity: raw.identity, proof: raw.proof }
      : null;
  } catch {
    return null;
  }
}

export function writeRoomIdentity(roomId: string, value: RoomIdentity): void {
  try {
    localStorage.setItem(KEY(roomId), JSON.stringify(value));
  } catch {
    // Sem storage: a próxima entrada ganha identidade nova, só isso.
  }
}

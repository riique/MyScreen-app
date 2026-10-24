import type { Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RecordingEngine, type RecordAudio, type RecordingInfo, type RecordTarget } from "./engine";

/**
 * A gravação vista pela sala: o que está gravando, o último arquivo fechado e
 * o aviso de erro. Quem está na sala fica sabendo pelo chat quando alguém
 * começa e para de gravar — gravar ninguém às escondidas.
 */
export function useRecording({
  room,
  myName,
  sendChat,
}: {
  room: Room;
  myName: string;
  sendChat: (message: string) => Promise<unknown>;
}) {
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [lastFile, setLastFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<RecordingEngine | null>(null);

  const announce = useRef({ myName, sendChat });
  announce.current = { myName, sendChat };
  const say = (text: string) => void announce.current.sendChat(text).catch(() => {});

  useEffect(() => {
    const engine = new RecordingEngine(
      room,
      () => setRecordings(engine.list()),
      (message) => setError(message),
    );
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      // Sair da sala fecha os arquivos direito: o que já foi gravado fica.
      void engine.dispose();
    };
  }, [room]);

  const start = useCallback((targets: RecordTarget[], audio: RecordAudio) => {
    const engine = engineRef.current;
    if (!engine || targets.length === 0) return;
    setError(null);
    say(`🔴 ${announce.current.myName} começou a gravar: ${targets.map((t) => t.label).join(", ")}.`);
    void engine.start(targets, audio);
  }, []);

  const stop = useCallback(async (key: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    const label = engine.list().find((r) => r.key === key)?.label;
    const file = await engine.stop(key);
    if (file) setLastFile(file);
    if (label) say(`⏹ ${announce.current.myName} parou de gravar: ${label}.`);
  }, []);

  const stopAll = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const labels = engine.list().map((r) => r.label);
    const files = (await engine.stopAll()).filter((f): f is string => f !== null);
    if (files.length > 0) setLastFile(files[files.length - 1]);
    if (labels.length > 0) say(`⏹ ${announce.current.myName} parou de gravar: ${labels.join(", ")}.`);
  }, []);

  return { recordings, lastFile, error, dismissError: () => setError(null), start, stop, stopAll };
}

import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { GreenRoom, type GreenRoomJoinConfig } from "@/components/conference/GreenRoom";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sheet } from "@/components/sheet";
import { readNickname, rememberRoom, writeNickname } from "@/lib/storage";
import { ApiError, usePlatform } from "@/platform";

/** O token vive 6 h; renovar a cada 10 min evita cair no meio da chamada. */
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// O SDK do LiveKit só carrega quando a pessoa entra: o lobby monta sem ele.
const ConferenceRoom = lazy(() =>
  import("@/components/conference/ConferenceRoom").then((m) => ({ default: m.ConferenceRoom })),
);

type Session = {
  token: string;
  serverUrl: string;
  nickname: string;
  identity: string;
  /** Só na memória: o refresh do token precisa dela, o disco nunca a vê. */
  password?: string;
  media: Pick<GreenRoomJoinConfig, "audioEnabled" | "videoEnabled" | "audioDeviceId" | "videoDeviceId">;
};

function Preparing() {
  return (
    <div className="mx-auto w-full max-w-[34rem] px-6 py-20">
      <p className="font-mono text-[0.8125rem] text-ink-3">Preparando sala...</p>
    </div>
  );
}

export function RoomScreen({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const platform = usePlatform();
  const [loading, setLoading] = useState(true);
  const [savedNickname, setSavedNickname] = useState<string | null>(null);
  const [roomInfo, setRoomInfo] = useState<{ title: string; isLocked: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  // "Reconectar" recria a sala com um token novo em vez de recarregar a página.
  const [generation, setGeneration] = useState(0);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    let alive = true;
    void readNickname().then((name) => {
      if (alive) setSavedNickname(name);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    platform.api
      .getRoom(roomId)
      .then((room) => {
        if (!alive) return;
        setRoomInfo({ title: room.title, isLocked: room.isLocked });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        // Sala efêmera é válida mesmo sem registro; um erro de rede, não.
        if (error instanceof ApiError && error.status === 0) setLoadError(error.message);
        setRoomInfo({ title: `Sala ${roomId}`, isLocked: false });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [platform, roomId]);

  const handleJoin = useCallback(
    async (config: GreenRoomJoinConfig) => {
      setJoinError(null);
      try {
        const data = await platform.api.token({ roomId, nickname: config.nickname, password: config.password });
        writeNickname(config.nickname);
        rememberRoom(roomId, roomInfo?.title ?? `Sala ${roomId}`);
        setSession({
          token: data.token,
          serverUrl: data.livekitUrl,
          nickname: config.nickname,
          identity: data.participantIdentity,
          password: config.password,
          media: {
            audioEnabled: config.audioEnabled,
            videoEnabled: config.videoEnabled,
            audioDeviceId: config.audioDeviceId,
            videoDeviceId: config.videoDeviceId,
          },
        });
        return true;
      } catch (error) {
        // 429 traz a mensagem do servidor; não tenta de novo sozinho.
        setJoinError(error instanceof Error ? error.message : "Não foi possível conectar à sala.");
        return false;
      }
    },
    [platform, roomId, roomInfo?.title],
  );

  // Mesma identidade ao renovar: uma nova faria o SFU ver outra pessoa, e o
  // participante apareceria duplicado depois de reconectar.
  const refreshToken = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const data = await platform.api.token({
        roomId,
        nickname: s.nickname,
        participantIdentity: s.identity || undefined,
        password: s.password,
      });
      setSession((cur) => (cur ? { ...cur, token: data.token, identity: data.participantIdentity || cur.identity } : cur));
    } catch {
      // Renovar é rotina: falhar aqui não pode derrubar a chamada.
    }
  }, [platform, roomId]);

  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => void refreshToken(), TOKEN_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [Boolean(session), refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const reconnect = useCallback(async () => {
    await refreshToken();
    setGeneration((g) => g + 1);
  }, [refreshToken]);

  if (session) {
    return (
      <Suspense fallback={<Preparing />}>
        <ConferenceRoom
          key={generation}
          roomId={roomId}
          token={session.token}
          serverUrl={session.serverUrl}
          initialAudioEnabled={session.media.audioEnabled}
          initialVideoEnabled={session.media.videoEnabled}
          initialAudioDeviceId={session.media.audioDeviceId}
          initialVideoDeviceId={session.media.videoDeviceId}
          onLeave={onLeave}
          onReconnect={() => void reconnect()}
        />
      </Suspense>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AppBar>
        <button
          type="button"
          onClick={onLeave}
          className="inline-flex h-8 items-center gap-1.5 border border-transparent px-2.5 text-[0.8125rem] text-ink-2 transition-colors hover:border-rule hover:bg-band hover:text-ink [border-radius:var(--radius-cell)]"
        >
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden />
          Início
        </button>
        <ThemeToggle />
      </AppBar>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {loading || savedNickname === null ? (
          <Preparing />
        ) : (
          <div className="mx-auto w-full max-w-[68rem] px-6 py-8">
            {joinError || loadError ? (
              <Sheet className="mb-6 border-alert-line bg-alert-wash px-5 py-3.5">
                <p role="alert" className="text-[0.875rem] text-alert">
                  {joinError ?? loadError}
                </p>
              </Sheet>
            ) : null}
            <GreenRoom
              roomId={roomId}
              roomTitle={roomInfo?.title || `Sala ${roomId}`}
              isLocked={Boolean(roomInfo?.isLocked)}
              initialNickname={savedNickname}
              onJoin={handleJoin}
            />
          </div>
        )}
      </main>
    </div>
  );
}

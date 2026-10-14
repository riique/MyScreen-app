import { ArrowRight, Clock, Download, Lock, Plus, Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateStatus } from "@shared/ipc";
import { compareVersions, parseRoomInput } from "@shared/room";
import { AppBar } from "@/components/AppBar";
import { AppSettingsDialog } from "@/components/AppSettingsDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sheet } from "@/components/sheet";
import { forgetRoom, readRecent, rememberRoom, type RecentRoom } from "@/lib/storage";
import { usePlatform } from "@/platform";

/** Campo grande: as duas tarefas da página merecem alvo de clique folgado. */
const bigInput =
  "h-12 w-full border border-rule-2 bg-sheet px-4 text-[1rem] text-ink transition-colors placeholder:text-ink-3 hover:border-rule-3 focus:border-signal focus:shadow-[0_0_0_3px_var(--color-signal-wash)] focus:outline-none [border-radius:var(--radius-cell)]";

/**
 * A home do app só tem as duas tarefas (criar, entrar) e as salas recentes.
 * A vitrine do site (capacidades, hospedagem) não entra.
 */
export function Home({ onEnterRoom }: { onEnterRoom: (id: string) => void }) {
  const platform = usePlatform();
  const [title, setTitle] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentRoom[]>(readRecent);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [version, setVersion] = useState("");
  const [minVersion, setMinVersion] = useState<string | null>(null);

  useEffect(() => {
    void window.myscreen.app.info().then((i) => setVersion(i.version));
    void window.myscreen.updates.status().then(setUpdate);
    void window.myscreen.api.desktopInfo().then((r) => {
      if (r.ok) setMinVersion(r.data.minVersion);
    });
    return window.myscreen.updates.onStatus(setUpdate);
  }, []);

  const outdated = Boolean(minVersion && version && compareVersions(version, minVersion) < 0);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (outdated) return;
    setCreating(true);
    setCreateError(null);
    try {
      const room = await platform.api.createRoom({
        title: title.trim() || "Reunião instantânea",
        password: password || undefined,
      });
      rememberRoom(room.id, room.title);
      onEnterRoom(room.id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Não foi possível criar a sala.");
      setCreating(false);
    }
  }

  function handleJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (outdated) return;
    const id = parseRoomInput(roomCode);
    if (!id) {
      setJoinError("Isso não parece um código ou link de sala do MyScreen.");
      return;
    }
    setJoinError(null);
    onEnterRoom(id);
  }

  return (
    <div className="flex h-full flex-col">
      <AppBar>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Configurações do app"
          title="Configurações do app"
          className="inline-flex size-8 items-center justify-center border border-transparent text-ink-2 transition-colors hover:border-rule hover:bg-band hover:text-ink [border-radius:var(--radius-cell)]"
        >
          <Settings2 className="size-[1.0625rem]" strokeWidth={1.75} aria-hidden />
        </button>
        <ThemeToggle />
      </AppBar>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-6 pt-12 pb-16">
          {outdated ? (
            <Sheet className="mb-6 border-alert-line bg-alert-wash px-5 py-4">
              <p role="alert" className="text-[0.875rem] text-alert">
                Esta versão do app ({version}) é antiga demais para o servidor, que pede a {minVersion} ou mais
                nova. {update.state === "ready" ? "A atualização já foi baixada." : "Atualize para entrar nas salas."}
              </p>
            </Sheet>
          ) : null}

          {update.state === "ready" ? (
            <Sheet className="mb-6 flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <p className="flex items-center gap-2 text-[0.875rem] text-ink-2">
                <Download size={16} strokeWidth={1.75} aria-hidden className="text-signal" />
                A versão {update.version} está pronta.
              </p>
              <button
                type="button"
                onClick={() => window.myscreen.updates.install()}
                className="border border-signal bg-signal px-4 py-2 text-[0.8125rem] font-semibold text-on-signal transition-colors hover:bg-signal-2 [border-radius:var(--radius-sheet)]"
              >
                Reiniciar e atualizar
              </button>
            </Sheet>
          ) : update.state === "available" ? (
            <Sheet className="mb-6 flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <p className="flex items-center gap-2 text-[0.875rem] text-ink-2">
                <Download size={16} strokeWidth={1.75} aria-hidden className="text-signal" />
                A versão {update.version} está disponível.
              </p>
              <button
                type="button"
                onClick={() => window.myscreen.updates.download()}
                className="border border-signal bg-signal px-4 py-2 text-[0.8125rem] font-semibold text-on-signal transition-colors hover:bg-signal-2 [border-radius:var(--radius-sheet)]"
              >
                Baixar
              </button>
            </Sheet>
          ) : update.state === "downloading" ? (
            <p className="mb-6 font-mono text-[0.75rem] text-ink-3">Baixando atualização… {update.percent}%</p>
          ) : null}

          <h1 className="max-w-[40rem] text-[2.25rem] font-semibold tracking-[-0.034em] text-ink [line-height:1.06] [text-wrap:balance]">
            Sua tela, o som do PC e a sua câmera, na mesma faixa.
          </h1>
          <p className="mt-4 max-w-[60ch] text-[1rem] leading-[1.6] text-ink-2 [text-wrap:pretty]">
            Crie uma sala e mande o link — quem não tem o app entra pelo navegador. Daqui, o som do sistema vai
            sem eco da chamada, e dá para levar só o som da janela escolhida.
          </p>

          <Sheet className="mt-10 overflow-hidden">
            <div className="grid md:grid-cols-2">
              <form onSubmit={handleCreate} className="flex flex-col p-8">
                <h2 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink">Criar uma sala</h2>
                <p className="mt-1.5 text-[0.9375rem] leading-[1.55] text-ink-2">
                  Você entra primeiro e manda o link para quem vai assistir.
                </p>
                <div className="mt-7 space-y-4">
                  <div>
                    <label htmlFor="room-title" className="label-col block">
                      Nome da sala (opcional)
                    </label>
                    <input
                      id="room-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={120}
                      placeholder="Ex: Revisão do deploy"
                      autoComplete="off"
                      className={`${bigInput} mt-2`}
                    />
                  </div>
                  <div>
                    <label htmlFor="room-password" className="label-col block">
                      Senha (opcional)
                    </label>
                    <div className="relative mt-2">
                      <Lock
                        size={16}
                        strokeWidth={1.75}
                        aria-hidden
                        className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-3"
                      />
                      <input
                        id="room-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Deixe em branco para sala aberta"
                        autoComplete="new-password"
                        className={`${bigInput} pl-11`}
                      />
                    </div>
                  </div>
                </div>
                {createError ? (
                  <p
                    role="alert"
                    className="mt-4 border border-alert-line bg-alert-wash px-4 py-3 text-[0.875rem] text-alert [border-radius:var(--radius-cell)]"
                  >
                    {createError}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={creating || outdated}
                  className="mt-7 inline-flex h-12 items-center justify-center gap-2 self-start border border-signal bg-signal px-6 text-[0.9375rem] font-semibold text-on-signal transition-colors hover:border-signal-2 hover:bg-signal-2 disabled:pointer-events-none disabled:opacity-60 [border-radius:var(--radius-sheet)]"
                >
                  <Plus size={18} strokeWidth={2} aria-hidden />
                  {creating ? "Criando sala..." : "Criar e entrar"}
                </button>
              </form>

              <form
                onSubmit={handleJoin}
                className="flex flex-col border-t border-rule bg-band p-8 md:border-t-0 md:border-l"
              >
                <h2 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink">Entrar em uma sala</h2>
                <p className="mt-1.5 text-[0.9375rem] leading-[1.55] text-ink-2">
                  Cole o link que recebeu, ou só o código da sala.
                </p>
                <div className="mt-7">
                  <label htmlFor="room-code" className="label-col block">
                    Código ou link da reunião
                  </label>
                  <input
                    id="room-code"
                    value={roomCode}
                    onChange={(e) => {
                      setRoomCode(e.target.value);
                      setJoinError(null);
                    }}
                    placeholder="abc-def-ghi"
                    autoComplete="off"
                    spellCheck={false}
                    className={`${bigInput} mt-2 font-mono`}
                  />
                </div>
                {joinError ? (
                  <p role="alert" className="mt-3 text-[0.8125rem] text-alert">
                    {joinError}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={!roomCode.trim() || outdated}
                  className="mt-7 inline-flex h-12 items-center justify-center gap-2 self-start border border-rule-2 bg-sheet px-6 text-[0.9375rem] font-semibold text-ink transition-colors hover:border-rule-3 hover:bg-band-2 disabled:pointer-events-none disabled:opacity-50 [border-radius:var(--radius-sheet)]"
                >
                  Entrar
                  <ArrowRight size={18} strokeWidth={1.75} aria-hidden />
                </button>
              </form>
            </div>
          </Sheet>

          {recent.length > 0 ? (
            <section className="mt-12">
              <h2 className="flex items-center gap-2 border-b border-rule pb-3 text-[0.9375rem] font-semibold text-ink">
                <Clock size={15} strokeWidth={1.75} aria-hidden className="text-ink-3" />
                Salas recentes
              </h2>
              <ul className="divide-y divide-rule">
                {recent.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2">
                    <button
                      type="button"
                      disabled={outdated}
                      onClick={() => onEnterRoom(r.id)}
                      className="flex min-w-0 flex-1 items-baseline gap-3 px-2 py-1.5 text-left transition-colors hover:bg-band disabled:opacity-50 [border-radius:var(--radius-cell)]"
                    >
                      <span className="truncate text-[0.9375rem] font-medium text-ink">{r.title}</span>
                      <span className="shrink-0 font-mono text-[0.75rem] text-ink-3">{r.id}</span>
                      <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-ink-3">
                        {new Date(r.at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Tirar ${r.title} das recentes`}
                      title="Tirar das recentes"
                      onClick={() => {
                        forgetRoom(r.id);
                        setRecent(readRecent());
                      }}
                      className="shrink-0 p-1.5 text-ink-3 transition-colors hover:text-ink"
                    >
                      <X size={14} strokeWidth={1.75} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="mt-16 font-mono text-[0.6875rem] text-ink-3">
            MyScreen {version} · {platform.serverUrl().replace(/^https?:\/\//, "")}
          </p>
        </div>
      </main>

      <AppSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

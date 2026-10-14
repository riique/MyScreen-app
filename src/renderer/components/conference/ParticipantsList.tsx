
import { useParticipants, useRoomContext } from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { useMemo } from "react";
import { SheetHead } from "@/components/sheet";

interface ParticipantsListProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * A roster é uma coluna: quem está, com o que está ligado. O estado de cada
 * pessoa é escrito por extenso — "Câmera desligada", "Microfone mudo" — porque
 * um ícone sozinho obriga a pessoa a decorar o alfabeto de ícones da casa, e
 * "quem está sem microfone" é a pergunta real numa sala de 1 a few.
 *
 * O participante local vem de `useRoomContext().localParticipant` e não de
 * `useLocalParticipant()`: o hook devolve um tipo mesclado cuja forma muda
 * entre versões, e a roster inteira perderia a tipagem por causa de um elemento.
 */
export function ParticipantsList({ isOpen, onClose }: ParticipantsListProps) {
  const room = useRoomContext();
  const remoteParticipants = useParticipants();

  // `useParticipants` já inclui o participante local; somar de novo duplicava
  // a linha "(Você)". O local vai primeiro, os outros na ordem de chegada.
  const participants = useMemo(
    () => [
      room.localParticipant,
      ...remoteParticipants.filter((p) => p.identity !== room.localParticipant.identity),
    ],
    [room.localParticipant, remoteParticipants],
  );

  if (!isOpen) return null;

  const isTrackMuted = (p: Participant, source: Track.Source) => {
    const publication = p.getTrackPublication(source);
    return !publication || publication.isMuted;
  };

  return (
    <aside className="flex h-full w-full min-h-0 flex-col bg-sheet">
      <div className="px-4 py-3">
        <SheetHead
          title="Participantes"
          meta={`${participants.length}`}
          action={
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar lista de participantes"
              className="border border-rule-2 px-2 py-1 text-[0.75rem] text-ink-2 transition-colors hover:bg-band hover:text-ink [border-radius:var(--radius-cell)]"
            >
              Fechar
            </button>
          }
        />
      </div>

      <ul className="flex-1 divide-y divide-rule overflow-y-auto">
        {participants.map((p) => {
          const camMuted = isTrackMuted(p, Track.Source.Camera);
          const micMuted = isTrackMuted(p, Track.Source.Microphone);
          const sharing = p.getTrackPublication(Track.Source.ScreenShare) !== undefined;

          return (
            <li key={p.identity} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[0.875rem] font-medium text-ink">
                  {p.name || p.identity}
                  {p.isLocal ? (
                    <span className="ml-1.5 font-mono text-[0.6875rem] text-ink-3">(Você)</span>
                  ) : null}
                </span>
                {p.isSpeaking ? (
                  <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-signal">
                    Falando...
                  </span>
                ) : null}
              </div>

              <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                <Status
                  label="Câmera"
                  value={camMuted ? "desligada" : "ligada"}
                  on={!camMuted}
                  title={camMuted ? "Câmera desligada" : "Câmera ligada"}
                />
                <Status
                  label="Microfone"
                  value={micMuted ? "mudo" : "ativo"}
                  on={!micMuted}
                  title={micMuted ? "Microfone mudo" : "Microfone ativo"}
                />
                {sharing ? (
                  <Status
                    label="Tela"
                    value="compartilhando"
                    on
                    title="Compartilhando tela"
                  />
                ) : null}
              </dl>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/** Estado como valor escrito, com o rótulo da coluna ao lado. */
function Status({
  label,
  value,
  on,
  title,
}: {
  label: string;
  value: string;
  on: boolean;
  title: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <dt className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-3">
        {label}
      </dt>
      <dd
        className={`text-[0.75rem] ${on ? "text-ink-2" : "text-ink-3"}`}
        aria-label={`${label}: ${value}`}
      >
        {value}
      </dd>
    </div>
  );
}

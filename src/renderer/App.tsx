import { useCallback, useEffect, useRef, useState } from "react";
import { Home } from "./pages/Home";
import { RoomScreen } from "./pages/RoomScreen";

type View = { name: "home" } | { name: "room"; id: string };

/**
 * Duas telas: a home (criar, entrar, recentes) e a sala (lobby → chamada).
 * Um deep link `myscreen://room/<id>` leva direto à sala.
 */
export function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const viewRef = useRef(view);
  viewRef.current = view;

  const goRoom = useCallback((id: string) => {
    const current = viewRef.current;
    if (current.name === "room") {
      if (current.id === id) return;
      if (!window.confirm(`Sair da sala atual e entrar em "${id}"?`)) return;
    }
    setView({ name: "room", id });
  }, []);

  useEffect(() => {
    void window.myscreen.app.consumePendingRoom().then((id) => {
      if (id) goRoom(id);
    });
    return window.myscreen.app.onNavigate(goRoom);
  }, [goRoom]);

  if (view.name === "room") {
    return <RoomScreen key={view.id} roomId={view.id} onLeave={() => setView({ name: "home" })} />;
  }
  return <Home onEnterRoom={goRoom} />;
}

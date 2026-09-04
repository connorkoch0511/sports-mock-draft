import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home.jsx";
import NewDraft from "./pages/NewDraft.jsx";
import Draft from "./pages/Draft.jsx";
import Results from "./pages/Results.jsx";
import Board from "./pages/Board.jsx";
import Boards from "./pages/Boards.jsx";
import MyDrafts from "./pages/MyDrafts.jsx";
import Player from "./pages/Player.jsx";
import AuthCallback from "./pages/AuthCallback.jsx";
import { AuthProvider } from "./lib/AuthProvider.jsx";
import NavBar from "./components/NavBar.jsx";
import RequireAuth from "./components/RequireAuth.jsx";

export default function App() {
  return (
    <AuthProvider>
      <div className="flex h-dvh flex-col bg-[#070A0F] text-white">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 min-h-0 flex-col px-4 sm:px-6 lg:px-8">
          <div className="shrink-0">
            <NavBar />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/draft/new" element={<RequireAuth><NewDraft /></RequireAuth>} />
              <Route path="/drafts" element={<RequireAuth><MyDrafts /></RequireAuth>} />
              <Route path="/draft/:draftId" element={<RequireAuth><Draft /></RequireAuth>} />
              <Route path="/draft/:draftId/results" element={<RequireAuth><Results /></RequireAuth>} />
              <Route path="/board/:boardId" element={<RequireAuth><Board /></RequireAuth>} />
              <Route path="/boards" element={<RequireAuth><Boards /></RequireAuth>} />
              <Route path="/player/:playerId" element={<Player />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
            </Routes>
          </div>
        </div>
      </div>
    </AuthProvider>
  );
}
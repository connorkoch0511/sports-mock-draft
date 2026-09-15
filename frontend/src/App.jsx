import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home.jsx";
import NewDraft from "./pages/NewDraft.jsx";
import Draft from "./pages/Draft.jsx";
import JoinDraft from "./pages/JoinDraft.jsx";
import Results from "./pages/Results.jsx";
import Board from "./pages/Board.jsx";
import Boards from "./pages/Boards.jsx";
import MyDrafts from "./pages/MyDrafts.jsx";
import Player from "./pages/Player.jsx";
import AuthCallback from "./pages/AuthCallback.jsx";
import YahooCallback from "./pages/YahooCallback.jsx";
import { Privacy, Terms } from "./pages/Legal.jsx";
import { AuthProvider } from "./lib/AuthProvider.jsx";
import NavBar from "./components/NavBar.jsx";
import RequireAuth from "./components/RequireAuth.jsx";

export default function App() {
  return (
    <AuthProvider>
      <div className="flex h-dvh flex-col bg-[#070A0F] text-white">
        {/*
            xl:max-w-[1680px]: Draft.jsx widens its OWN container to
            xl:max-w-[1600px] so the queue column has room on a wide monitor
            (Task 3) -- but this shell wraps every route, and its plain
            max-w-[1400px] sat in front of that, plus its own 64px of
            lg:px-8 padding either side. Together those re-capped Draft's
            content at 1336px regardless of Draft's own 1600px ceiling, so a
            1728px monitor kept rendering the same narrow grid Task 3 was
            written to fix -- measured: the Draft Board (the flexible middle
            column) fell to 200px against a table that wants 620, exactly
            the failure mode Task 3's own brief warns about, just caused one
            layer up from where that brief was looking. 1680, not 1600: it
            has to clear Draft's inner max-width AND this div's own 64px of
            padding (1600 + 64 = 1664) for Draft's own cap to ever be the
            one that actually binds. Scoped to xl and up, the same
            breakpoint where Draft's fourth column appears, so nothing below
            it (or any other page's own width) changes.
        */}
        <div className="mx-auto flex w-full max-w-[1400px] xl:max-w-[1680px] flex-1 min-h-0 flex-col px-4 sm:px-6 lg:px-8">
          <div className="shrink-0">
            <NavBar />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/draft/new" element={<RequireAuth><NewDraft /></RequireAuth>} />
              <Route path="/drafts" element={<RequireAuth><MyDrafts /></RequireAuth>} />
              <Route path="/draft/:draftId" element={<RequireAuth><Draft /></RequireAuth>} />
              <Route path="/draft/:draftId/join" element={<RequireAuth><JoinDraft /></RequireAuth>} />
              <Route path="/draft/:draftId/results" element={<RequireAuth><Results /></RequireAuth>} />
              <Route path="/board/:boardId" element={<RequireAuth><Board /></RequireAuth>} />
              <Route path="/boards" element={<RequireAuth><Boards /></RequireAuth>} />
              <Route path="/player/:playerId" element={<Player />} />
              {/*
                Public, and they have to be: Google follows these links from
                the consent screen, and someone deciding whether to sign in
                must be able to read what happens to their data first.
              */}
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/yahoo/callback" element={<RequireAuth><YahooCallback /></RequireAuth>} />
            </Routes>
          </div>
        </div>
      </div>
    </AuthProvider>
  );
}
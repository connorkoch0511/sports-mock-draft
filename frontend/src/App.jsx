import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home.jsx";
import NewDraft from "./pages/NewDraft.jsx";
import Draft from "./pages/Draft.jsx";
import Results from "./pages/Results.jsx";
import Board from "./pages/Board.jsx";
import Boards from "./pages/Boards.jsx";
import NavBar from "./components/NavBar.jsx";

export default function App() {
  return (
    <div className="flex h-screen flex-col bg-[#070A0F] text-white">
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 min-h-0 flex-col px-4 sm:px-6 lg:px-8">
        <div className="shrink-0">
          <NavBar />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/draft/new" element={<NewDraft />} />
            <Route path="/draft/:draftId" element={<Draft />} />
            <Route path="/draft/:draftId/results" element={<Results />} />
            <Route path="/board/:boardId" element={<Board />} />
            <Route path="/boards" element={<Boards />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
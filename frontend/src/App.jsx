import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home.jsx";
import Draft from "./pages/Draft.jsx";
import Results from "./pages/Results.jsx";
import Board from "./pages/Board.jsx";
import Boards from "./pages/Boards.jsx";

export default function App() {
  return (
    <div className="min-h-screen bg-[#070A0F] text-white">
      <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/draft/:draftId" element={<Draft />} />
          <Route path="/draft/:draftId/results" element={<Results />} />
          <Route path="/board/:boardId" element={<Board />} />
          <Route path="/boards" element={<Boards />} />
        </Routes>
      </div>
    </div>
  );
}
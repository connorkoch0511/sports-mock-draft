import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home.jsx";
import Draft from "./pages/Draft.jsx";

export default function App() {
  return (
    <div className="min-h-screen bg-black text-white">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/draft/:draftId" element={<Draft />} />
      </Routes>
    </div>
  );
}
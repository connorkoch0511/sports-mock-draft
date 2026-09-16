import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { registerServiceWorker } from "./lib/push.js";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// After render, so registration never delays first paint. Progressive
// enhancement: this resolves quietly where service workers are unavailable --
// registerServiceWorker() itself catches a failed registration, but that
// try/catch doesn't start until after its default parameter is evaluated, so
// a browser whose navigator.serviceWorker getter throws would still surface
// here as an unhandled rejection. .catch() is the backstop for that.
registerServiceWorker().catch(() => {});

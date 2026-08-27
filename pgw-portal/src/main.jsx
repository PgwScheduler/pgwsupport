import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthProvider.jsx";
import { DateRangeProvider } from "./context/DateRangeProvider.jsx";
import "./index.css";

// DateRangeProvider sits ABOVE App, not inside a screen, because the
// selected range has to survive navigation between screens — that is the
// whole point of a shared control.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <DateRangeProvider>
        <App />
      </DateRangeProvider>
    </AuthProvider>
  </React.StrictMode>
);

import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root"));
if (window.location.pathname === "/sports") {
  import("./sports/App.jsx").then(({ default: SportsApp }) => root.render(<SportsApp />));
} else {
  Promise.all([import("./App.jsx"), import("./style.css")]).then(([{ default: App }]) => root.render(<App />));
}

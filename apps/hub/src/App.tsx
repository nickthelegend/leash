import { useEffect, useState } from "react";
import { Hub } from "./Hub";
import { Landing } from "./Landing";

function route(): string {
  const h = window.location.hash.replace(/^#\/?/, "");
  return h.split(/[?#]/)[0];
}

export function App() {
  const [r, setR] = useState(route);
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.title = r === "hub" ? "LEASH Hub · Chat" : "LEASH Hub";
  }, [r]);
  if (r === "hub") return <Hub />;
  return <Landing focusHow={r === "how"} />;
}

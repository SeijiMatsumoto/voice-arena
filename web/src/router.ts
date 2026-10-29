import { useEffect, useState } from "react";

/** Minimal hash router: #/results/<report>/<dataset>, #/run, #/playground. */
export function useRoute(): string[] {
  const read = () =>
    // "?checker=..." after the route is a parameter, not part of the last segment.
    window.location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export function navigate(path: string) {
  window.location.hash = path;
  window.scrollTo(0, 0);
}

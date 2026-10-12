import { useEffect, useState } from "react";

// Below Tailwind's `md` (768px): a phone, held either way. The screens that
// managers use on the shop floor (tic sheet, schedule) switch layout here.
export const PHONE_QUERY = "(max-width: 767px)";

export function useMediaQuery(query) {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export const useIsPhone = () => useMediaQuery(PHONE_QUERY);

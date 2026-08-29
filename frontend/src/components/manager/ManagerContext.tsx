import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { HistoryData } from "../../types";
import { loadHistory } from "../../dataLoader";

interface ManagerData {
  history: HistoryData | null;
  historyError: string | null;
}

const ManagerDataContext = createContext<ManagerData | null>(null);

/** One `/api/history` fetch shared by Overview, Bottlenecks and Shift History. */
export function ManagerDataProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadHistory(10)
      .then((h) => live && setHistory(h))
      .catch((e) => live && setHistoryError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, []);

  return (
    <ManagerDataContext.Provider value={{ history, historyError }}>
      {children}
    </ManagerDataContext.Provider>
  );
}

export function useManagerData() {
  const ctx = useContext(ManagerDataContext);
  if (!ctx) throw new Error("useManagerData used outside ManagerDataProvider");
  return ctx;
}

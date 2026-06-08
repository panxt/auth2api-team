import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useCallback,
} from "react";

/** Identity of the currently-logged-in admin key (from /admin/ui/whoami). */
export interface WhoAmI {
  label: string | null;
  owner: string | null;
  admin: boolean;
  enabled: boolean;
  apiKeyShort: string;
}

interface AuthValue {
  key: string | null;          // raw admin key (held in memory + localStorage)
  whoami: WhoAmI | null;       // last successful identity probe
  login: (key: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

const STORAGE_KEY = "auth2api.adminKey";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);

  const probe = useCallback(async (k: string): Promise<WhoAmI | null> => {
    try {
      const resp = await fetch("/admin/ui/whoami", {
        headers: { Authorization: `Bearer ${k}` },
      });
      if (!resp.ok) return null;
      return (await resp.json()) as WhoAmI;
    } catch {
      return null;
    }
  }, []);

  // On mount + whenever the in-memory key changes, refresh whoami.
  // If the server rejects the key (e.g. it was disabled / rotated / quota
  // tracker isn't tracking it), clear localStorage + drop the key so
  // RequireAuth bounces us to /login instead of stranding the user in a
  // page where every /admin/* call 401s. (Fix F9.)
  useEffect(() => {
    if (!key) {
      setWhoami(null);
      return;
    }
    let cancelled = false;
    probe(key).then((w) => {
      if (cancelled) return;
      if (w) {
        setWhoami(w);
      } else {
        // Stale key — server doesn't accept it anymore.
        localStorage.removeItem(STORAGE_KEY);
        setKey(null);
        setWhoami(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, probe]);

  const login = useCallback(
    async (k: string) => {
      const w = await probe(k);
      if (!w) return { ok: false as const, error: "key rejected by /admin/ui/whoami" };
      localStorage.setItem(STORAGE_KEY, k);
      setKey(k);
      setWhoami(w);
      return { ok: true as const };
    },
    [probe],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setKey(null);
    setWhoami(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!key) return;
    const w = await probe(key);
    setWhoami(w);
  }, [key, probe]);

  return (
    <AuthContext.Provider value={{ key, whoami, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

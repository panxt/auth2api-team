import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Users } from "./pages/Users";
import { Accounts } from "./pages/Accounts";
import { Stats } from "./pages/Stats";
import { Logs } from "./pages/Logs";
import { Config } from "./pages/Config";
import { Layout } from "./components/Layout";

/** Wraps inner routes — bounce to /login if no key. */
function RequireAuth({ children }: { children: JSX.Element }) {
  const { key } = useAuth();
  if (!key) return <Navigate to="/login" replace />;
  return children;
}

/** Admin-only route guard. Waits for the whoami probe before deciding so an
 *  admin isn't bounced during the initial load. Non-admins go to /accounts. */
function RequireAdmin({ children }: { children: JSX.Element }) {
  const { key, whoami } = useAuth();
  if (!key) return <Navigate to="/login" replace />;
  if (whoami === null) return null; // still probing identity
  if (!whoami.admin) return <Navigate to="/accounts" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/stats" replace />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/users" element={<Users />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/logs" element={<Logs />} />
        <Route
          path="/config"
          element={
            <RequireAdmin>
              <Config />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/stats" replace />} />
    </Routes>
  );
}

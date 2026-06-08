import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Users } from "./pages/Users";
import { Accounts } from "./pages/Accounts";
import { Stats } from "./pages/Stats";
import { Layout } from "./components/Layout";

/** Wraps inner routes — bounce to /login if no key. */
function RequireAuth({ children }: { children: JSX.Element }) {
  const { key } = useAuth();
  if (!key) return <Navigate to="/login" replace />;
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
      </Route>
      <Route path="*" element={<Navigate to="/stats" replace />} />
    </Routes>
  );
}

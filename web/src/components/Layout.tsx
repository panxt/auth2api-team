import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

interface NavItemDef extends NavItem {
  adminOnly?: boolean;
}

const NAV: NavItemDef[] = [
  { to: "/me", label: "我的", icon: "🙋" },
  { to: "/stats", label: "看板", icon: "📊" },
  { to: "/users", label: "用户", icon: "👥" },
  { to: "/accounts", label: "账号", icon: "🔌" },
  { to: "/logs", label: "日志", icon: "📜" },
  { to: "/config", label: "设置", icon: "⚙️", adminOnly: true },
];

export function Layout() {
  const { whoami, logout } = useAuth();
  const nav = useNavigate();

  const onLogout = () => {
    logout();
    nav("/login", { replace: true });
  };

  return (
    <div className="min-h-screen flex bg-ink-950 text-ink-100">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-ink-800 flex flex-col">
        <div className="p-5 border-b border-ink-800">
          <div className="text-lg font-semibold tracking-tight">auth2api</div>
          <div className="text-xs text-ink-500 mt-0.5">admin dashboard</div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV.filter((item) => !item.adminOnly || whoami?.admin).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [
                  "flex items-center gap-2 px-3 py-2 rounded-md text-sm",
                  isActive
                    ? "bg-ink-800 text-ink-100"
                    : "text-ink-400 hover:text-ink-100 hover:bg-ink-900",
                ].join(" ")
              }
            >
              <span aria-hidden>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-ink-800 text-xs">
          <div className="text-ink-500 mb-1">已登录为</div>
          <div className="font-medium truncate">
            {whoami?.label ?? "(unlabeled)"}
            {whoami?.admin ? (
              <span className="ml-1 badge-ok">admin</span>
            ) : (
              <span className="ml-1 badge-muted">只读</span>
            )}
          </div>
          <button
            onClick={onLogout}
            className="mt-2 w-full btn-secondary text-xs"
          >
            退出登录
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

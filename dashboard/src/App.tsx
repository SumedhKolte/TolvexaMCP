import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { AuditPage } from "./pages/Audit";
import { ChatPage, ChatProvider } from "./pages/Chat";
import { ConnectPage } from "./pages/Connect";
import { LoginPage } from "./pages/Login";
import { MyKeysPage } from "./pages/MyKeys";
import { PermissionsPage } from "./pages/Permissions";
import { ServersPage } from "./pages/Servers";
import { StoresPage } from "./pages/Stores";
import { TeamPage } from "./pages/Team";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ChatProvider>
            <RequireAuth />
          </ChatProvider>
        }
      >
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/servers" replace />} />
          <Route path="/servers" element={<ServersPage />} />
          <Route path="/stores" element={<StoresPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/team" element={<RequireAuth adminOnly />}>
            <Route index element={<TeamPage />} />
          </Route>
          <Route path="/permissions" element={<PermissionsPage />} />
          <Route path="/keys" element={<MyKeysPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/audit" element={<AuditPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/servers" replace />} />
    </Routes>
  );
}

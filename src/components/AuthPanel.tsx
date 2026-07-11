import { useState } from "react";

interface Props {
  account: string | null;
  connecting: boolean;
  onConnect: (clientId: string, clientSecret: string) => void;
  onDisconnect: () => void;
}

export function AuthPanel({ account, connecting, onConnect, onDisconnect }: Props) {
  const [clientId, setClientId] = useState(() => localStorage.getItem("subdigest.clientId") ?? "");
  const [clientSecret, setClientSecret] = useState(
    () => localStorage.getItem("subdigest.clientSecret") ?? ""
  );
  const [showCreds, setShowCreds] = useState(!account);

  const connect = () => {
    localStorage.setItem("subdigest.clientId", clientId.trim());
    localStorage.setItem("subdigest.clientSecret", clientSecret.trim());
    onConnect(clientId.trim(), clientSecret.trim());
  };

  if (account) {
    return (
      <section className="panel auth">
        <div className="account-row">
          <span className="dot connected" />
          <span className="account" title={account}>
            {account}
          </span>
        </div>
        <button className="link" onClick={onDisconnect}>
          Sign out
        </button>
      </section>
    );
  }

  return (
    <section className="panel auth">
      <h2 className="col-title">Gmail Account</h2>
      <button className="link" onClick={() => setShowCreds((s) => !s)}>
        {showCreds ? "Hide credentials" : "API credentials"}
      </button>
      {showCreds && (
        <>
          <label>
            OAuth Client ID
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxx.apps.googleusercontent.com"
              spellCheck={false}
            />
          </label>
          <label>
            OAuth Client Secret
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-…"
              spellCheck={false}
            />
          </label>
        </>
      )}
      <button
        className="primary"
        disabled={connecting || !clientId.trim() || !clientSecret.trim()}
        onClick={connect}
      >
        {connecting ? "Waiting for Google…" : "Connect Gmail"}
      </button>
      <p className="hint">
        Sign-in opens in your browser. Access is read-only and tokens stay on this device.
      </p>
    </section>
  );
}

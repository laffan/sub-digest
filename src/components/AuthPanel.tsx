import { HAS_CREDENTIALS, OAUTH_REDIRECT_URI } from "../config";

interface Props {
  account: string | null;
  connecting: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
}

export function AuthPanel({ account, connecting, onConnect, onCancel, onDisconnect }: Props) {
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
      {!HAS_CREDENTIALS ? (
        <div className="creds-missing">
          <p className="hint">
            No OAuth credentials found. Copy <code>.env.example</code> to{" "}
            <code>.env</code>, fill in your Gmail client ID and secret, then restart the
            app.
          </p>
        </div>
      ) : (
        <>
          <button className="primary" disabled={connecting} onClick={onConnect}>
            {connecting ? "Waiting for Google…" : "Connect Gmail"}
          </button>
          {connecting ? (
            <>
              <button className="link" onClick={onCancel}>
                Cancel
              </button>
              <p className="hint">
                Complete sign-in in your browser. If Google shows{" "}
                <strong>access_denied</strong>, add your address as a Test user on the
                OAuth consent screen, then Cancel and try again.
              </p>
            </>
          ) : (
            <p className="hint">
              Sign-in opens in your browser. Access is read-only and tokens stay on this
              device.
            </p>
          )}
        </>
      )}
      <p className="hint redirect-hint">
        Redirect URI to register in Google Cloud Console:
        <code>{OAUTH_REDIRECT_URI}</code>
      </p>
    </section>
  );
}

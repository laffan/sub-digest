import { useEffect, useMemo, useState } from "react";
import {
  METHOD_LABELS,
  availableMethods,
  listIsEmpty,
  listSummary,
  sourceDomain,
  type SavedSource,
  type SignInMethod,
} from "../sources";
import type { SignInDetails } from "../saved";
import { TimeframePicker } from "./TimeframePicker";
import type { DateRange } from "../types";

interface Props {
  sources: SavedSource[];
  sourceId: string;
  onSourceChange: (id: string) => void;
  /** The account this source is signed in as, or null. */
  account: string | null;
  signingIn: boolean;
  onSignIn: (method: SignInMethod, details: SignInDetails) => void;
  /** Asks the site to mail a sign-in link. */
  onRequestLink: (email: string) => void;
  onSignOut: () => void;
  listId: string;
  onListChange: (id: string) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
  collecting: boolean;
  onCollect: () => void;
  onEditSources: () => void;
  /** Whatever the last sign-in step had to say — "check your mail", usually. */
  notice: string | null;
  days: number;
  range: DateRange;
  rangeValid: boolean;
  onDaysChange: (days: number) => void;
  onRangeChange: (range: DateRange) => void;
  /** Whether anything has been collected yet, for the hint under the controls. */
  found: number;
}

/** How many articles one collection takes, at most. */
const LIMITS = [25, 50, 100, 200, 500];

/**
 * The saved-list input: sign in to a site, pick one of its lists, collect what's
 * on it.
 *
 * Sign-in is HTTP in the backend rather than a browser window, which is what
 * makes it the same on a Mac and on an iPad. Three ways in, and a site offers
 * whichever its recipe knows about: paste the link it mailed you, give it an
 * address and password, or paste a session cookie out of a browser.
 */
export function SavedPanel({
  sources,
  sourceId,
  onSourceChange,
  account,
  signingIn,
  onSignIn,
  onRequestLink,
  onSignOut,
  listId,
  onListChange,
  limit,
  onLimitChange,
  collecting,
  onCollect,
  onEditSources,
  notice,
  days,
  range,
  rangeValid,
  onDaysChange,
  onRangeChange,
  found,
}: Props) {
  const source = sources.find((s) => s.id === sourceId) ?? sources[0];
  const methods = useMemo(() => (source ? availableMethods(source) : []), [source]);
  const [method, setMethod] = useState<SignInMethod>(methods[0] ?? "cookie");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState("");
  const [cookie, setCookie] = useState("");

  // A different site signs in differently; start on whatever it offers first.
  useEffect(() => {
    setMethod((current) => (methods.includes(current) ? current : methods[0] ?? "cookie"));
  }, [methods]);

  if (!source) {
    return (
      <section className="panel saved">
        <h2 className="col-title">Saved List</h2>
        <p className="hint">
          No sources yet — add the site you keep a list on, and what to read it from.
        </p>
        <button className="secondary wide-btn" onClick={onEditSources}>
          Add a Source…
        </button>
      </section>
    );
  }

  const list = source.lists.find((l) => l.id === listId) ?? source.lists[0];
  const domain = sourceDomain(source);
  const canSignIn =
    !signingIn &&
    ((method === "link" && link.trim().length > 0) ||
      (method === "password" && email.trim().length > 0 && password.length > 0) ||
      (method === "cookie" && cookie.trim().length > 0));

  const submit = () => {
    if (!canSignIn) return;
    onSignIn(method, { email, password, link, cookie });
    setPassword("");
    setLink("");
    setCookie("");
  };

  return (
    <section className="panel saved">
      <div className="posts-head">
        <h2 className="col-title">Saved List</h2>
        <button className="filters-btn" onClick={onEditSources} title="Sources and their lists">
          Sources
          <span className="filters-count">{sources.length}</span>
        </button>
      </div>

      <label>
        Site
        <select value={source.id} onChange={(e) => onSourceChange(e.target.value)}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || "Untitled source"}
            </option>
          ))}
        </select>
      </label>

      {account ? (
        <>
          <div className="account-row signed-in">
            <span className="dot connected" />
            <span className="account" title={`Signed in to ${domain}`}>
              {account}
            </span>
          </div>
          <button className="link" onClick={onSignOut}>
            Sign out of {source.name || domain}
          </button>

          <label>
            List
            <select value={list?.id ?? ""} onChange={(e) => onListChange(e.target.value)}>
              {source.lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name || "Untitled list"}
                </option>
              ))}
            </select>
          </label>
          {list && <p className="hint list-summary">{listSummary(list)}</p>}

          <label>
            Most recent
            <select value={limit} onChange={(e) => onLimitChange(Number(e.target.value))}>
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n} articles
                </option>
              ))}
            </select>
          </label>

          <TimeframePicker
            days={days}
            range={range}
            rangeValid={rangeValid}
            onDaysChange={onDaysChange}
            onRangeChange={onRangeChange}
          >
            <button
              className="secondary"
              disabled={collecting || !rangeValid || !list || listIsEmpty(list)}
              onClick={onCollect}
              title={
                list && !listIsEmpty(list)
                  ? `Collect what's on ${list.name || "this list"}`
                  : "This list has no address to read"
              }
            >
              {collecting ? "Collecting…" : "Collect"}
            </button>
          </TimeframePicker>

          {list && listIsEmpty(list) && (
            <p className="hint warn">
              This list has no address to read — give it one under Sources.
            </p>
          )}

          {found === 0 && !collecting && list && !listIsEmpty(list) && (
            <p className="hint">
              Collect what's on {list.name || "this list"}. Each article is fetched from the site
              itself, so an item dated before your timeframe is left behind.
            </p>
          )}
        </>
      ) : (
        <>
          {methods.length > 1 && (
            <div className="method-row" role="group" aria-label="How to sign in">
              {methods.map((m) => (
                <button
                  key={m}
                  className={`segment${m === method ? " active" : ""}`}
                  onClick={() => setMethod(m)}
                  aria-pressed={m === method}
                >
                  {METHOD_LABELS[m]}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {method === "link" && (
              <>
                <label>
                  Address on the account
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  className="secondary wide-btn"
                  type="button"
                  disabled={signingIn || email.trim().length === 0}
                  onClick={() => onRequestLink(email)}
                >
                  Email me a sign-in link
                </button>
                <label>
                  The link, pasted
                  <textarea
                    className="paste-box"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    placeholder={`https://${domain}/sign-in?token=…`}
                    rows={3}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <p className="hint">
                  <strong>Copy the link — don't open it.</strong> Opening it spends it, and the
                  session lands in the browser instead of here. Press and hold it in Mail (or
                  right-click on the Mac) and choose Copy Link.
                </p>
              </>
            )}

            {method === "password" && (
              <>
                <label>
                  Address
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </label>
                <p className="hint">
                  Sent straight to {domain} and never stored — what's kept is the session it hands
                  back.
                </p>
              </>
            )}

            {method === "cookie" && (
              <>
                <label>
                  Session cookie from {domain}
                  <textarea
                    className="paste-box"
                    value={cookie}
                    onChange={(e) => setCookie(e.target.value)}
                    placeholder={`${source.cookieName || "session"}=…`}
                    rows={3}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <p className="hint">
                  Sign in to {domain} in a browser, then copy the session cookie from its developer
                  tools (Application → Cookies). A whole <code>name=value</code> line or the bare
                  value both work. This is the way in to a site with no sign-in endpoint of its
                  own — and it needs a desktop browser to get at.
                </p>
              </>
            )}

            <button className="primary wide-btn" type="submit" disabled={!canSignIn}>
              {signingIn ? "Signing in…" : `Sign in to ${source.name || domain}`}
            </button>
          </form>

          {notice && <p className="hint notice">{notice}</p>}
        </>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AuthPanel } from "./components/AuthPanel";
import { PostList } from "./components/PostList";
import { SettingsPanel } from "./components/SettingsPanel";
import { Preview } from "./components/Preview";
import {
  gmailCancelConnect,
  gmailConnect,
  gmailDisconnect,
  gmailGetBody,
  gmailSearch,
  gmailStatus,
  publicationFromHeader,
  savePdf,
} from "./gmail";
import { parseEmailHtml, parsePlainText } from "./parse";
import { generatePdf } from "./pdf/layout";
import { DEFAULT_SETTINGS, type DigestPost, type LayoutSettings, type Post } from "./types";

const SETTINGS_KEY = "subdigest.settings";

function loadSettings(): LayoutSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* fall through */
  }
  return DEFAULT_SETTINGS;
}

export default function App() {
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [days, setDays] = useState(30);
  const [scanning, setScanning] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [settings, setSettings] = useState<LayoutSettings>(loadSettings);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);

  // Fetched email bodies, cached by message id so re-generating is instant.
  const bodyCache = useRef(new Map<string, string>());

  useEffect(() => {
    gmailStatus()
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      setAccount(await gmailConnect());
    } catch (e) {
      // A user-initiated cancel isn't an error worth surfacing.
      if (!/cancel/i.test(String(e))) setError(String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const cancelConnect = useCallback(() => {
    gmailCancelConnect().catch(() => {});
  }, []);

  const disconnect = useCallback(async () => {
    await gmailDisconnect().catch(() => {});
    setAccount(null);
    setPosts([]);
    setPdfBytes(null);
  }, []);

  const scan = useCallback(async () => {
    setError(null);
    setScanning(true);
    try {
      const afterMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const metas = await gmailSearch(afterMs);
      setPosts(
        metas
          .map((m) => ({
            ...m,
            publication: publicationFromHeader(m.from),
            selected: true,
          }))
          .sort((a, b) => b.dateMs - a.dateMs)
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [days]);

  const togglePost = useCallback((id: string) => {
    setPosts((ps) => ps.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p)));
  }, []);

  const togglePublication = useCallback((name: string, selected: boolean) => {
    setPosts((ps) => ps.map((p) => (p.publication === name ? { ...p, selected } : p)));
  }, []);

  const selectedCount = useMemo(() => posts.filter((p) => p.selected).length, [posts]);

  const generate = useCallback(async () => {
    const selected = posts.filter((p) => p.selected);
    if (selected.length === 0) return;
    setError(null);
    setGenerating(true);
    try {
      const digest: DigestPost[] = [];
      for (let i = 0; i < selected.length; i++) {
        const p = selected[i];
        setProgress(`Fetching ${i + 1}/${selected.length}: ${p.subject}`);
        let body = bodyCache.current.get(p.id);
        if (body === undefined) {
          body = await gmailGetBody(p.id);
          bodyCache.current.set(p.id, body);
        }
        const isHtml = /<\/?[a-z][\s\S]*>/i.test(body.slice(0, 500));
        const blocks = isHtml ? parseEmailHtml(body, p.subject) : parsePlainText(body);
        digest.push({
          publication: p.publication,
          title: p.subject,
          dateMs: p.dateMs,
          blocks,
        });
      }
      const bytes = await generatePdf(digest, settings, setProgress);
      setPdfBytes(bytes);
      setProgress("");
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }, [posts, settings]);

  const exportPdf = useCallback(async () => {
    if (!pdfBytes) return;
    const path = await save({
      defaultPath: "substack-digest.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return;
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < pdfBytes.length; i += chunk) {
      bin += String.fromCharCode(...pdfBytes.subarray(i, i + chunk));
    }
    try {
      await savePdf(path, btoa(bin));
    } catch (e) {
      setError(String(e));
    }
  }, [pdfBytes]);

  return (
    <div className="app">
      <aside className="col col-left">
        <h1 className="brand">Sub Digest</h1>
        <AuthPanel
          account={account}
          connecting={connecting}
          onConnect={connect}
          onCancel={cancelConnect}
          onDisconnect={disconnect}
        />
        {account && (
          <PostList
            posts={posts}
            days={days}
            scanning={scanning}
            onDaysChange={setDays}
            onScan={scan}
            onTogglePost={togglePost}
            onTogglePublication={togglePublication}
          />
        )}
      </aside>

      <aside className="col col-mid">
        <h2 className="col-title">PDF Settings</h2>
        <SettingsPanel settings={settings} onChange={setSettings} />
        <div className="generate-area">
          <button
            className="primary generate"
            disabled={generating || selectedCount === 0}
            onClick={generate}
          >
            {generating ? "Generating…" : `Generate (${selectedCount} posts)`}
          </button>
          {pdfBytes && !generating && (
            <button className="secondary" onClick={exportPdf}>
              Save PDF…
            </button>
          )}
          {progress && <div className="progress">{progress}</div>}
          {error && <div className="error">{error}</div>}
        </div>
      </aside>

      <main className="col col-preview">
        <Preview pdfBytes={pdfBytes} />
      </main>
    </div>
  );
}

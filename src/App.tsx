import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AuthPanel } from "./components/AuthPanel";
import { PostList } from "./components/PostList";
import { SettingsPanel } from "./components/SettingsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { AgentOptionsModal } from "./components/AgentOptionsModal";
import { Preview } from "./components/Preview";
import { anthropicProcess } from "./anthropic";
import { markdownToBlocks } from "./parse";
import {
  gmailCancelConnect,
  gmailConnect,
  gmailDisconnect,
  gmailGetBody,
  gmailSearch,
  gmailStatus,
  publicationFromHeader,
  saveFile,
} from "./gmail";
import { parseEmailHtml, parsePlainText } from "./parse";
import { generatePdf } from "./pdf/layout";
import { generateEpub } from "./epub/build";
import { dayEndMs, dayStartMs, isoLocalDay } from "./dates";
import {
  CUSTOM_RANGE,
  DEFAULT_SETTINGS,
  outputFileName,
  type AgentConfig,
  type DateRange,
  type DigestPost,
  type GeneratedOutput,
  type LayoutSettings,
  type Post,
} from "./types";

const SETTINGS_KEY = "subdigest.settings";
const DOMAINS_KEY = "subdigest.domains";
const AGENTS_KEY = "subdigest.agentConfigs";
const ANTHROPIC_KEY = "subdigest.anthropicKey";
const DEFAULT_DOMAINS = ["substack.com"];

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  return fallback;
}

function loadSettings(): LayoutSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* fall through */
  }
  return DEFAULT_SETTINGS;
}

function loadDomains(): string[] {
  try {
    const raw = localStorage.getItem(DOMAINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_DOMAINS;
}

export default function App() {
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [days, setDays] = useState(30);
  // Only consulted when `days === CUSTOM_RANGE`; defaults to the last month.
  const [range, setRange] = useState<DateRange>(() => ({
    start: isoLocalDay(Date.now() - 30 * 24 * 60 * 60 * 1000),
    end: isoLocalDay(Date.now()),
  }));
  const [scanning, setScanning] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [settings, setSettings] = useState<LayoutSettings>(loadSettings);
  const [domains, setDomains] = useState<string[]>(loadDomains);
  const [showSettings, setShowSettings] = useState(false);
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentConfig>>(() =>
    loadJson(AGENTS_KEY, {})
  );
  const [agentOptionsFor, setAgentOptionsFor] = useState<string | null>(null);
  const [anthropicKey, setAnthropicKey] = useState(() => localStorage.getItem(ANTHROPIC_KEY) ?? "");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<GeneratedOutput | null>(null);

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

  useEffect(() => {
    localStorage.setItem(DOMAINS_KEY, JSON.stringify(domains));
  }, [domains]);

  useEffect(() => {
    localStorage.setItem(AGENTS_KEY, JSON.stringify(agentConfigs));
  }, [agentConfigs]);

  // Switching format leaves the preview showing the other format's document.
  useEffect(() => {
    setOutput(null);
  }, [settings.format]);

  const saveAnthropicKey = useCallback((key: string) => {
    setAnthropicKey(key);
    localStorage.setItem(ANTHROPIC_KEY, key);
  }, []);

  const toggleAgent = useCallback((name: string, useAgent: boolean) => {
    setAgentConfigs((cfgs) => ({
      ...cfgs,
      [name]: { instructions: cfgs[name]?.instructions ?? "", useAgent },
    }));
  }, []);

  const saveAgentInstructions = useCallback((name: string, instructions: string) => {
    setAgentConfigs((cfgs) => ({
      ...cfgs,
      [name]: { useAgent: cfgs[name]?.useAgent ?? true, instructions },
    }));
  }, []);

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
    setOutput(null);
  }, []);

  // The scan window, as epoch millis; 0 on either side means "open ended".
  // A custom range is inclusive of both days, so the end bound is the midnight
  // that closes it. Null means the range is incomplete or back to front.
  const scanWindow = useMemo((): { after: number; before: number } | null => {
    if (days !== CUSTOM_RANGE) {
      // days === 0 → "All time": pass 0 so the backend omits the date filter.
      return { after: days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0, before: 0 };
    }
    const after = dayStartMs(range.start);
    const before = dayEndMs(range.end);
    if (after === null || before === null || after >= before) return null;
    return { after, before };
  }, [days, range]);

  const scan = useCallback(async () => {
    if (!scanWindow) return;
    setError(null);
    setScanning(true);
    try {
      const metas = await gmailSearch(scanWindow.after, scanWindow.before, domains);
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
  }, [scanWindow, domains]);

  const togglePost = useCallback((id: string) => {
    setPosts((ps) => ps.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p)));
  }, []);

  /** Batch select/deselect, used by shift-click ranges in the post list. */
  const setPostsSelected = useCallback((ids: string[], selected: boolean) => {
    const inRange = new Set(ids);
    setPosts((ps) => ps.map((p) => (inRange.has(p.id) ? { ...p, selected } : p)));
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
        const agent = agentConfigs[p.publication];
        let blocks;
        if (agent?.useAgent && anthropicKey.trim()) {
          setProgress(`Agent processing ${i + 1}/${selected.length}: ${p.subject}`);
          try {
            const md = await anthropicProcess(anthropicKey, agent.instructions, p.subject, body);
            blocks = markdownToBlocks(md, p.subject);
          } catch (e) {
            // Fall back to the default parser rather than failing the whole run.
            setError(`Agent failed for "${p.publication}" — used default parsing. ${String(e)}`);
            const isHtml = /<\/?[a-z][\s\S]*>/i.test(body.slice(0, 500));
            blocks = isHtml ? parseEmailHtml(body, p.subject) : parsePlainText(body);
          }
        } else {
          const isHtml = /<\/?[a-z][\s\S]*>/i.test(body.slice(0, 500));
          blocks = isHtml ? parseEmailHtml(body, p.subject) : parsePlainText(body);
        }
        digest.push({
          publication: p.publication,
          title: p.subject,
          dateMs: p.dateMs,
          blocks,
        });
      }
      if (settings.format === "epub") {
        setOutput(await generateEpub(digest, settings, setProgress));
      } else {
        setOutput({ format: "pdf", bytes: await generatePdf(digest, settings, setProgress) });
      }
      setProgress("");
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }, [posts, settings, agentConfigs, anthropicKey]);

  const exportOutput = useCallback(async () => {
    if (!output) return;
    const ext = output.format;
    const path = await save({
      defaultPath: outputFileName(ext),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < output.bytes.length; i += chunk) {
      bin += String.fromCharCode(...output.bytes.subarray(i, i + chunk));
    }
    try {
      await saveFile(path, btoa(bin));
    } catch (e) {
      setError(String(e));
    }
  }, [output]);

  return (
    <div className="app">
      <aside className="col col-left">
        <div className="brand-row">
          <h1 className="brand">Sub Digest</h1>
          <button
            className="icon-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            title="Domains, agent & settings"
          >
            <GearIcon />
          </button>
        </div>
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
            range={range}
            rangeValid={scanWindow !== null}
            scanning={scanning}
            agentConfigs={agentConfigs}
            onDaysChange={setDays}
            onRangeChange={setRange}
            onScan={scan}
            onTogglePost={togglePost}
            onSetPostsSelected={setPostsSelected}
            onTogglePublication={togglePublication}
            onToggleAgent={toggleAgent}
            onOpenAgentOptions={setAgentOptionsFor}
          />
        )}
      </aside>

      <aside className="col col-mid">
        <h2 className="col-title">Output</h2>
        <SettingsPanel settings={settings} onChange={setSettings} />
        <div className="generate-area">
          <button
            className="primary generate"
            disabled={generating || selectedCount === 0}
            onClick={generate}
          >
            {generating ? "Generating…" : `Generate (${selectedCount} posts)`}
          </button>
          {output && !generating && (
            <button className="secondary" onClick={exportOutput}>
              {`Save ${output.format.toUpperCase()}…`}
            </button>
          )}
          {progress && <div className="progress">{progress}</div>}
          {error && <div className="error">{error}</div>}
        </div>
      </aside>

      <main className="col col-preview">
        <Preview output={output} />
      </main>

      {showSettings && (
        <SettingsModal
          domains={domains}
          onDomainsChange={setDomains}
          anthropicKey={anthropicKey}
          onAnthropicKeyChange={saveAnthropicKey}
          onClose={() => setShowSettings(false)}
        />
      )}

      {agentOptionsFor && (
        <AgentOptionsModal
          publication={agentOptionsFor}
          instructions={agentConfigs[agentOptionsFor]?.instructions ?? ""}
          hasKey={anthropicKey.trim().length > 0}
          onSave={(instructions) => saveAgentInstructions(agentOptionsFor, instructions)}
          onClose={() => setAgentOptionsFor(null)}
        />
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { AuthPanel } from "./components/AuthPanel";
import { PostList } from "./components/PostList";
import { SettingsPanel } from "./components/SettingsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { AgentOptionsModal } from "./components/AgentOptionsModal";
import { Preview } from "./components/Preview";
import { OrganizePanel } from "./components/OrganizePanel";
import { ContentPreview } from "./components/ContentPreview";
import { LogPane } from "./components/LogPane";
import { log, logError, logInfo, logWarn, type LogLevel } from "./log";
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
  type Block,
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
  // The column moves through the work in order — pick posts, watch them get
  // read and set their running order, then choose an output format. Each step
  // is settled before the next depends on it.
  const [step, setStep] = useState<"select" | "organize" | "output">("select");
  const [showLog, setShowLog] = useState(false);
  // Posts fetched and parsed, in the order they'll appear in the digest.
  const [prepared, setPrepared] = useState<DigestPost[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [prepareTotal, setPrepareTotal] = useState(0);

  // Fetched email bodies, cached by message id so re-generating is instant.
  const bodyCache = useRef(new Map<string, string>());
  // Parsed blocks, likewise — agent runs cost money, so don't repeat one just
  // because the user stepped back to change the selection.
  const blocksCache = useRef(new Map<string, Block[]>());

  useEffect(() => {
    gmailStatus()
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);

  // The backend logs over Tauri events; outside a Tauri window there are none.
  useEffect(() => {
    const unlisten = listen<{ level: LogLevel; source: string; message: string }>(
      "log",
      (event) => log(event.payload.level, event.payload.source, event.payload.message)
    ).catch(() => undefined);
    return () => {
      unlisten.then((off) => off?.()).catch(() => {});
    };
  }, []);

  /** Shows a step's status inline and keeps a copy in the log. */
  const report = useCallback((message: string) => {
    setProgress(message);
    if (message) logInfo("render", message);
  }, []);

  const fail = useCallback((source: string, e: unknown) => {
    const message = String(e);
    setError(message);
    logError(source, message);
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

  // Agent settings decide how a post is parsed, so cached blocks are stale
  // the moment they change.
  useEffect(() => {
    blocksCache.current.clear();
  }, [agentConfigs, anthropicKey]);

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
    setStep("select");
    logInfo("gmail", "Signed out");
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
    const label = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString() : "any");
    logInfo(
      "gmail",
      `Scanning ${domains.join(", ")} from ${label(scanWindow.after)} to ${label(scanWindow.before)}`
    );
    try {
      const metas = await gmailSearch(scanWindow.after, scanWindow.before, domains);
      const found = metas
        .map((m) => ({
          ...m,
          publication: publicationFromHeader(m.from),
          selected: true,
        }))
        .sort((a, b) => b.dateMs - a.dateMs);
      setPosts(found);
      const pubs = new Set(found.map((p) => p.publication));
      logInfo("gmail", `Found ${found.length} posts from ${pubs.size} publications`);
    } catch (e) {
      fail("gmail", e);
    } finally {
      setScanning(false);
    }
  }, [scanWindow, domains, fail]);

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

  /**
   * Fetches and parses every selected post, one at a time, so the Organize
   * step can show them arriving. Starts chronological; the user reorders from
   * there. Runs once on entering Organize, not on every Generate.
   */
  const organize = useCallback(async () => {
    const selected = [...posts.filter((p) => p.selected)].sort((a, b) => a.dateMs - b.dateMs);
    if (selected.length === 0) return;
    setStep("organize");
    setError(null);
    setOutput(null);
    setPrepared([]);
    setPrepareTotal(selected.length);
    setPreparing(true);
    logInfo("render", `Preparing ${selected.length} posts`);
    try {
      for (let i = 0; i < selected.length; i++) {
        const p = selected[i];
        report(`Fetching ${i + 1}/${selected.length}: ${p.subject}`);
        let body = bodyCache.current.get(p.id);
        if (body === undefined) {
          body = await gmailGetBody(p.id);
          bodyCache.current.set(p.id, body);
          logInfo("gmail", `Fetched "${p.subject}" (${body.length} chars)`);
        }
        const agent = agentConfigs[p.publication];
        let blocks = blocksCache.current.get(p.id);
        if (blocks === undefined) {
          if (agent?.useAgent && anthropicKey.trim()) {
            report(`Agent processing ${i + 1}/${selected.length}: ${p.subject}`);
            try {
              const md = await anthropicProcess(anthropicKey, agent.instructions, p.subject, body);
              blocks = markdownToBlocks(md, p.subject);
              logInfo("agent", `"${p.subject}" → ${blocks.length} blocks from ${md.length} chars`);
            } catch (e) {
              // Fall back to the default parser rather than failing the whole run.
              const detail = String(e);
              if (/no article links/i.test(detail)) {
                // Expected for anything that isn't a link roundup — note it and move on.
                logWarn("agent", `No links found in "${p.subject}" — used default parsing`);
              } else {
                const message = `Agent failed for "${p.publication}" — used default parsing. ${detail}`;
                setError(message);
                logError("agent", message);
              }
              const isHtml = /<\/?[a-z][\s\S]*>/i.test(body.slice(0, 500));
              blocks = isHtml ? parseEmailHtml(body, p.subject) : parsePlainText(body);
            }
          } else {
            const isHtml = /<\/?[a-z][\s\S]*>/i.test(body.slice(0, 500));
            blocks = isHtml ? parseEmailHtml(body, p.subject) : parsePlainText(body);
            logInfo("parse", `"${p.subject}" → ${blocks.length} blocks`);
          }
          blocksCache.current.set(p.id, blocks);
        }
        const post: DigestPost = {
          publication: p.publication,
          title: p.subject,
          dateMs: p.dateMs,
          blocks,
        };
        setPrepared((prev) => [...prev, post]);
      }
      setProgress("");
      logInfo("render", "All posts prepared");
    } catch (e) {
      fail("render", e);
    } finally {
      setPreparing(false);
    }
  }, [posts, agentConfigs, anthropicKey, report, fail]);

  /** Reorders the digest; any document already generated no longer matches. */
  const movePost = useCallback((index: number, delta: number) => {
    setPrepared((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    setOutput(null);
  }, []);

  const generate = useCallback(async () => {
    if (prepared.length === 0) return;
    setError(null);
    setGenerating(true);
    const startedAt = Date.now();
    logInfo("render", `Generating ${settings.format.toUpperCase()} from ${prepared.length} posts`);
    try {
      if (settings.format === "epub") {
        setOutput(await generateEpub(prepared, settings, report));
      } else {
        setOutput({ format: "pdf", bytes: await generatePdf(prepared, settings, report) });
      }
      setProgress("");
      logInfo("render", `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    } catch (e) {
      fail("render", e);
    } finally {
      setGenerating(false);
    }
  }, [prepared, settings, report, fail]);

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
      logInfo("save", `Wrote ${output.bytes.length.toLocaleString()} bytes to ${path}`);
    } catch (e) {
      fail("save", e);
    }
  }, [output, fail]);

  return (
    <div className={`app${showLog ? " with-log" : ""}`}>
      <aside className="col col-left">
        <div className="brand-row">
          <h1 className="brand">Sub Digest</h1>
          <div className="brand-actions">
            <button
              className={`icon-btn${showLog ? " active" : ""}`}
              onClick={() => setShowLog((v) => !v)}
              aria-label="Log"
              aria-pressed={showLog}
              title={showLog ? "Hide log" : "Show log"}
            >
              <LogIcon />
            </button>
            <button
              className="icon-btn"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              title="Domains, agent & settings"
            >
              <GearIcon />
            </button>
          </div>
        </div>

        {step === "select" ? (
          <>
            <div className="step-body">
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
            </div>
            {(posts.length > 0 || error) && (
              <div className="step-actions">
                {posts.length > 0 && (
                  <button className="primary" disabled={selectedCount === 0} onClick={organize}>
                    {selectedCount === 0
                      ? "Select some posts"
                      : `Continue with ${selectedCount} post${selectedCount === 1 ? "" : "s"}`}
                  </button>
                )}
                {error && <div className="error">{error}</div>}
              </div>
            )}
          </>
        ) : step === "organize" ? (
          <>
            <div className="step-body">
              <button
                className="back-link"
                onClick={() => setStep("select")}
                disabled={preparing}
                title={preparing ? "Wait for the posts to finish" : "Back to post selection"}
              >
                ← {selectedCount} post{selectedCount === 1 ? "" : "s"} selected
              </button>
              <OrganizePanel
                posts={prepared}
                done={prepared.length}
                total={prepareTotal}
                preparing={preparing}
                onMove={movePost}
              />
            </div>
            <div className="step-actions">
              <button
                className="primary"
                disabled={preparing || prepared.length === 0}
                onClick={() => setStep("output")}
              >
                {preparing ? "Preparing…" : "Continue to output"}
              </button>
              {progress && <div className="progress">{progress}</div>}
              {error && <div className="error">{error}</div>}
            </div>
          </>
        ) : (
          <>
            <div className="step-body">
              <button
                className="back-link"
                onClick={() => setStep("organize")}
                disabled={generating}
                title={generating ? "Finish generating first" : "Back to the running order"}
              >
                ← {prepared.length} post{prepared.length === 1 ? "" : "s"} in order
              </button>
              <h2 className="col-title">Output</h2>
              <SettingsPanel settings={settings} onChange={setSettings} />
            </div>
            <div className="step-actions">
              <button
                className="primary generate"
                disabled={generating || prepared.length === 0}
                onClick={generate}
              >
                {generating ? "Generating…" : `Generate ${settings.format.toUpperCase()}`}
              </button>
              {output && !generating && (
                <button className="secondary" onClick={exportOutput}>
                  {`Save ${output.format.toUpperCase()}…`}
                </button>
              )}
              {progress && <div className="progress">{progress}</div>}
              {error && <div className="error">{error}</div>}
            </div>
          </>
        )}
      </aside>

      <main className="col col-preview">
        {step === "organize" ? (
          <ContentPreview posts={prepared} preparing={preparing} />
        ) : (
          <Preview output={output} />
        )}
      </main>

      {showLog && <LogPane onClose={() => setShowLog(false)} />}

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

function LogIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7 9h4M7 13h10M7 17h7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
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

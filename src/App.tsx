import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { AuthPanel } from "./components/AuthPanel";
import { InputPicker } from "./components/InputPicker";
import { MailPanel } from "./components/MailPanel";
import { PostList } from "./components/PostList";
import { SavedPanel } from "./components/SavedPanel";
import { BrowserModal } from "./components/BrowserModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { FilterEditorModal } from "./components/FilterEditorModal";
import { Preview } from "./components/Preview";
import { OrganizePanel } from "./components/OrganizePanel";
import { CoverPanel } from "./components/CoverPanel";
import { CoverGallery } from "./components/CoverGallery";
import { ContentPreview } from "./components/ContentPreview";
import { LogPane } from "./components/LogPane";
import { log, logError, logInfo, logWarn, type LogLevel } from "./log";
import { anthropicProcess } from "./anthropic";
import { clearProcessed, loadProcessed, markProcessed } from "./processed";
import {
  FILTERS_KEY,
  activeFilters,
  decidingFilter,
  filterFingerprint,
  filterLabel,
  loadFilters,
} from "./filters";
import { blockSignature, rememberedKeys, withSignatures } from "./remember";
import {
  SOURCES_KEY,
  loadSources,
  newSourceId,
  openingUrl,
  sourceLabel,
  type SavedSource,
} from "./sources";
import { savedCapture, savedFetch, savedForget, savedHasSession } from "./saved";
import { orderPosts, type PostOrder } from "./order";
import { COVER_RESULTS, artworkLabel, metSearch } from "./met";
import { markdownToBlocks } from "./parse";
import {
  gmailCancelConnect,
  gmailConnect,
  gmailDisconnect,
  gmailGetBody,
  gmailSearch,
  gmailStatus,
  printDocument,
  publicationFromHeader,
  saveFile,
} from "./gmail";
import { parseEmailHtml, parsePlainText } from "./parse";
import { generatePdf } from "./pdf/layout";
import { generateEpub } from "./epub/build";
import { dayEndMs, dayStartMs, isoLocalDay, issueLine } from "./dates";
import {
  CUSTOM_RANGE,
  DEFAULT_SETTINGS,
  blockKey,
  outputFileName,
  parseBlockKey,
  withRemovals,
  type CoverArtwork,
  type DateRange,
  type DigestPost,
  type GeneratedOutput,
  type InputKind,
  type LayoutSettings,
  type MailFilter,
  type Post,
} from "./types";

const SETTINGS_KEY = "subdigest.settings";
const ANTHROPIC_KEY = "subdigest.anthropicKey";
/** Which input the last session used; the app opens where it was left. */
const INPUT_KEY = "subdigest.input";
/** Matches MAX_MESSAGES in the Rust backend. */
const SCAN_LIMIT = 1000;
/** Matches MAX_ITEMS in the saved-list backend, and the harvest script's own. */
const CAPTURE_LIMIT = 500;

function loadInput(): InputKind {
  return localStorage.getItem(INPUT_KEY) === "saved" ? "saved" : "gmail";
}

/** Document bytes as base64, which is how they cross into the backend. */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000; // one apply() per chunk, or the argument list overflows
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
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

export default function App() {
  // Where this session's reading comes from. One input at a time: what a step
  // collects is what every step after it works on, and mixing two of them would
  // mean a selection nobody could reason about.
  const [input, setInput] = useState<InputKind>(loadInput);

  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // The saved-list input: the sites it knows about, which one is picked, and
  // whether its browser is open. Sessions live in the backend — the most this
  // side ever sees is the domain one is kept for.
  const [sources, setSources] = useState<SavedSource[]>(loadSources);
  const [sourceId, setSourceId] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  // Said inside the browser rather than behind it: a capture that found nothing
  // leaves the modal open, because the fix is to navigate and try again.
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  // What the last capture read, for the line under the button.
  const [captured, setCaptured] = useState<{ count: number; from: string } | null>(null);
  const [days, setDays] = useState(30);
  // Only consulted when `days === CUSTOM_RANGE`; defaults to the last month.
  const [range, setRange] = useState<DateRange>(() => ({
    start: isoLocalDay(Date.now() - 30 * 24 * 60 * 60 * 1000),
    end: isoLocalDay(Date.now()),
  }));
  const [scanning, setScanning] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [settings, setSettings] = useState<LayoutSettings>(loadSettings);
  // What a scan looks for. The sidebar enables and disables them; the editor
  // composes them.
  const [filters, setFilters] = useState<MailFilter[]>(loadFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState(() => localStorage.getItem(ANTHROPIC_KEY) ?? "");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<GeneratedOutput | null>(null);
  // The column moves through the work in order — pick posts, watch them get
  // read and set their running order, choose what the cover is, then choose an
  // output format. Each step is settled before the next depends on it.
  const [step, setStep] = useState<"select" | "organize" | "cover" | "output">("select");
  const [showLog, setShowLog] = useState(false);
  // Entries fetched and parsed, in the order they were read. An agent-processed
  // email contributes one entry per article it linked to. What order they go
  // out in is `order` below, applied on the way to `ordered`.
  const [prepared, setPrepared] = useState<DigestPost[]>([]);
  // How the digest runs: by date, grouped by publication, or the arrangement
  // dragging left behind — which is what `customOrder`, a list of entry ids, is.
  const [order, setOrder] = useState<PostOrder>("chronological");
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [prepareDone, setPrepareDone] = useState(0);
  const [prepareTotal, setPrepareTotal] = useState(0);
  // Blocks the user has struck out. Marking is not deleting: the entries keep
  // everything, so stepping back to Organize shows the marks again and they can
  // be taken back. The removal happens on the way out, at generation.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState(false);
  // Bumped on every click in the running order, so clicking the same row twice
  // scrolls to it twice.
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  // Bumped when something is clicked out of the generated document, which asks
  // for it to be laid out again.
  const [refreshTick, setRefreshTick] = useState(0);

  // The cover: a theme to search the Met's open collection with, what came
  // back, and the piece the user settled on. All of it belongs to this issue,
  // so none of it is remembered between runs.
  const [theme, setTheme] = useState("");
  /** The theme the pieces on screen came back from. */
  const [searched, setSearched] = useState("");
  const [coverResults, setCoverResults] = useState<CoverArtwork[]>([]);
  const [coverSearching, setCoverSearching] = useState(false);
  const [cover, setCover] = useState<CoverArtwork | null>(null);

  // Posts processed before this session began. It's a snapshot on purpose: a
  // post read a minute ago shouldn't grey out under the user mid-run, so
  // marking one now shows up the *next* time they scan. Purely a marker —
  // nothing is skipped or deselected on the strength of it.
  const [processedBefore, setProcessedBefore] = useState<ReadonlySet<string>>(loadProcessed);
  const [processedCount, setProcessedCount] = useState(() => loadProcessed().size);

  // Fetched email bodies, cached by message id so re-generating is instant.
  const bodyCache = useRef(new Map<string, string>());
  // Prepared entries, likewise — agent runs cost money, so don't repeat one
  // just because the user stepped back to change the selection.
  const entryCache = useRef(new Map<string, DigestPost[]>());

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
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
  }, [sources]);

  useEffect(() => {
    localStorage.setItem(INPUT_KEY, input);
  }, [input]);

  // Switching format leaves the preview showing the other format's document.
  useEffect(() => {
    setOutput(null);
  }, [settings.format]);

  // A filter decides how the mail it found is read, so a changed filter makes
  // every cached entry stale — but only a change to what it *finds and reads*.
  // Remembering one more struck-out image mustn't cost another agent run.
  const scanFingerprint = useMemo(() => filterFingerprint(filters), [filters]);
  useEffect(() => {
    entryCache.current.clear();
  }, [scanFingerprint, anthropicKey]);

  // Striking material out changes what a generated document would contain —
  // except when the mark came from a click on the document itself, which
  // regenerates it rather than throwing it away.
  const keepPreview = useRef(false);
  useEffect(() => {
    if (keepPreview.current) {
      keepPreview.current = false;
      return;
    }
    setOutput(null);
  }, [removed]);

  /** Forgets every remembered post, so nothing in the scan list is shaded. */
  const forgetProcessed = useCallback(() => {
    clearProcessed();
    setProcessedBefore(new Set());
    setProcessedCount(0);
    logInfo("render", "Cleared the record of processed posts");
  }, []);

  const saveAnthropicKey = useCallback((key: string) => {
    setAnthropicKey(key);
    localStorage.setItem(ANTHROPIC_KEY, key);
  }, []);

  // The site on screen: what's picked, or the first there is. A site removed
  // leaves the picker on something real rather than on nothing.
  const source = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? sources[0],
    [sources, sourceId]
  );

  // Whether the picked site has a session kept for it. It's stored on the
  // device, so it survives a restart the way the Gmail token does — and it's
  // only ever used to fetch that site's own articles.
  useEffect(() => {
    const id = source?.id;
    if (!id) {
      setSession(null);
      return;
    }
    let live = true;
    savedHasSession(id)
      .then((domain) => live && setSession(domain))
      .catch(() => live && setSession(null));
    return () => {
      live = false;
    };
  }, [source?.id]);

  /**
   * Switches inputs. What's on screen came from the other one, and a session
   * collects from a single input, so it goes — nothing is silently carried
   * across into a run that wouldn't know how to read it.
   */
  const chooseInput = useCallback((kind: InputKind) => {
    setInput(kind);
    setPosts([]);
    setPrepared([]);
    setOutput(null);
    setError(null);
    setCaptured(null);
    setStep("select");
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

  // Only the enabled filters, and only those with something to match on — an
  // empty one would otherwise hand back the whole mailbox.
  const scanFilters = useMemo(() => activeFilters(filters), [filters]);

  const scan = useCallback(async () => {
    if (!scanWindow || scanFilters.length === 0) return;
    setError(null);
    setScanning(true);
    const label = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString() : "any");
    logInfo(
      "gmail",
      `Scanning with ${scanFilters.map(filterLabel).join(", ")} from ` +
        `${label(scanWindow.after)} to ${label(scanWindow.before)}`
    );
    try {
      const metas = await gmailSearch(scanWindow.after, scanWindow.before, scanFilters);
      const found: Post[] = metas
        .map((m) => ({
          ...m,
          publication: publicationFromHeader(m.from),
          selected: true,
          source: "gmail" as const,
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
  }, [scanWindow, scanFilters, fail]);

  const addSource = useCallback((name: string, url: string) => {
    const added: SavedSource = { id: newSourceId(), name, url };
    setSources((list) => [...list, added]);
    setSourceId(added.id);
  }, []);

  const removeSource = useCallback(
    (id: string) => {
      savedForget(id).catch(() => {});
      setSources((list) => list.filter((s) => s.id !== id));
      setSourceId("");
      setCaptured(null);
      setPosts([]);
    },
    []
  );

  const forgetSession = useCallback(() => {
    if (!source) return;
    savedForget(source.id).catch(() => {});
    setSession(null);
    logInfo("saved", `Forgot the session kept for ${sourceLabel(source)}`);
  }, [source]);

  /**
   * **Use this page**: reads the list the browser is showing, and turns it into
   * posts. They arrive in the same shape a scanned email does, which is the
   * whole point — everything after this step is the work it always was.
   *
   * The page is also remembered as where this site opens next time, since a
   * saved list is somewhere you go back to.
   */
  const captureList = useCallback(async () => {
    if (!source) return;
    setError(null);
    setCaptureNotice(null);
    setCapturing(true);
    try {
      const capture = await savedCapture(source.id);
      const within = scanWindow;
      // The page dated what it dated. An article it didn't date can't be held
      // to a timeframe, so it's kept and dated today — an entry has to carry a
      // date, and the day it was collected is the honest answer to when it
      // reached you. The log says how many, since that's a stand-in for a fact.
      const collectedAt = Date.now();
      const inWindow = capture.items.filter(
        (item) =>
          item.dateMs <= 0 ||
          !within ||
          ((within.after <= 0 || item.dateMs >= within.after) &&
            (within.before <= 0 || item.dateMs < within.before))
      );
      const undated = inWindow.filter((item) => item.dateMs <= 0).length;
      const found: Post[] = inWindow
        .map((item) => ({
          id: item.id,
          // Nothing reads this for a saved article — the byline and the
          // publication are already their own fields — but it's what a From
          // header is for, so it carries whoever the page named.
          from: item.author || item.publication,
          subject: item.title,
          dateMs: item.dateMs > 0 ? item.dateMs : collectedAt,
          filterIds: [],
          publication: item.publication,
          selected: true,
          source: "saved" as const,
          sourceId: source.id,
          url: item.url,
          author: item.author || undefined,
        }))
        .sort((a, b) => b.dateMs - a.dateMs);

      setPosts(found);
      setCaptured({ count: found.length, from: capture.pageUrl });
      setSources((list) =>
        list.map((s) => (s.id === source.id ? { ...s, lastUrl: capture.pageUrl } : s))
      );
      setSession(await savedHasSession(source.id).catch(() => null));
      // Nothing found leaves the browser open: the page shown was a sign-in
      // screen or the wrong page, and both are fixed by navigating, not by
      // starting over.
      if (found.length > 0) setBrowserOpen(false);

      const pubs = new Set(found.map((p) => p.publication));
      logInfo(
        "saved",
        `Took ${found.length} article${found.length === 1 ? "" : "s"} from ${pubs.size} ` +
          `publication${pubs.size === 1 ? "" : "s"} off ${capture.pageUrl}`
      );
      const skipped = capture.items.length - inWindow.length;
      if (skipped > 0) {
        logInfo("saved", `${skipped} article(s) on the page fell outside the timeframe`);
      }
      if (undated > 0) {
        logWarn(
          "saved",
          `${undated} article${undated === 1 ? " carried" : "s carried"} no date on the page — ` +
            `dated today, so ${undated === 1 ? "it sits" : "they sit"} at the end of a ` +
            `chronological digest`
        );
      }
      if (found.length === 0) {
        setCaptureNotice(
          capture.items.length > 0
            ? "Everything on that page fell outside the timeframe."
            : "Nothing on that page looked like an article — go to the list itself and try again."
        );
      }
    } catch (e) {
      setCaptureNotice(String(e));
      fail("saved", e);
    } finally {
      setCapturing(false);
    }
  }, [source, scanWindow, fail]);

  const toggleFilter = useCallback((id: string, enabled: boolean) => {
    setFilters((fs) => fs.map((f) => (f.id === id ? { ...f, enabled } : f)));
  }, []);

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

  // Which of the discovered posts the agent will read, so the list can say so
  // before the user commits to a run. Same rule Organize uses.
  const agentPosts = useMemo(() => {
    const ids = new Set<string>();
    for (const p of posts) {
      if (decidingFilter(filters, p.filterIds)?.useAgent) ids.add(p.id);
    }
    return ids;
  }, [posts, filters]);

  /**
   * Fetches and reads every selected post, one at a time, so the Organize step
   * can show them arriving. Starts chronological; the user reorders from there.
   * Runs once on entering Organize, not on every Generate.
   *
   * How a post is read depends on where it came from. An email is fetched from
   * Gmail and parsed — or handed to the agent, when the filter that found it
   * says so. A saved article is fetched from the site itself and scraped, which
   * is the same scrape the agent's link roundups get. Either way what comes out
   * is entries, and nothing downstream has to know which it was.
   */
  const organize = useCallback(async () => {
    const selected = [...posts.filter((p) => p.selected)].sort((a, b) => a.dateMs - b.dateMs);
    if (selected.length === 0) return;
    setStep("organize");
    setError(null);
    setOutput(null);
    setPrepared([]);
    // Last run's arrangement named entries this one may not even have.
    setCustomOrder([]);
    setOrder((o) => (o === "custom" ? "chronological" : o));
    setPrepareDone(0);
    setPrepareTotal(selected.length);
    setPreparing(true);
    logInfo("render", `Preparing ${selected.length} posts`);

    /** One saved article: fetched from the site, scraped, and that's the entry. */
    const readSaved = async (p: Post): Promise<DigestPost[]> => {
      if (!p.url) return [];
      let markdown = bodyCache.current.get(p.id);
      if (markdown === undefined) {
        markdown = await savedFetch(p.sourceId ?? "", p.url);
        bodyCache.current.set(p.id, markdown);
      }
      const blocks = markdownToBlocks(markdown, p.subject);
      logInfo("parse", `"${p.subject}" → ${blocks.length} blocks`);
      return [
        {
          id: p.id,
          publication: p.publication,
          title: p.subject,
          author: p.author,
          sourceUrl: p.url,
          dateMs: p.dateMs,
          blocks,
        },
      ];
    };

    /** One email: the body, then the agent or the parser, as its filter says. */
    const readMail = async (p: Post, agent: MailFilter | undefined): Promise<DigestPost[]> => {
      let body = bodyCache.current.get(p.id);
      if (body === undefined) {
        body = await gmailGetBody(p.id);
        bodyCache.current.set(p.id, body);
        logInfo("gmail", `Fetched "${p.subject}" (${body.length} chars)`);
      }
      /** The email itself as one entry — the fallback whenever no agent runs. */
      const asPost = (): DigestPost[] => {
        const isHtml = /<\/?[a-z][\s\S]*>/i.test(body!.slice(0, 500));
        const blocks = isHtml ? parseEmailHtml(body!, p.subject) : parsePlainText(body!);
        return [
          {
            id: p.id,
            publication: p.publication,
            filterId: agent?.id,
            title: p.subject,
            dateMs: p.dateMs,
            blocks,
          },
        ];
      };

      if (!agent?.useAgent || !anthropicKey.trim()) {
        const entries = asPost();
        logInfo("parse", `"${p.subject}" → ${entries[0].blocks.length} blocks`);
        return entries;
      }

      try {
        const found = await anthropicProcess(anthropicKey, agent.instructions, p.subject, body);
        // Each linked article stands on its own in the digest, under its own
        // title and byline rather than the email's subject line.
        const entries = found.map((entry, n) => ({
          id: `${p.id}#${n}`,
          publication: p.publication,
          filterId: agent.id,
          title: entry.title,
          author: entry.author || undefined,
          sourceUrl: entry.url,
          dateMs: p.dateMs,
          blocks: markdownToBlocks(entry.markdown, entry.title),
        }));
        logInfo(
          "agent",
          `"${p.subject}" → ${entries.length} article${entries.length === 1 ? "" : "s"}, ` +
            `${entries.reduce((n, e) => n + e.blocks.length, 0)} blocks`
        );
        return entries;
      } catch (e) {
        // Fall back to the default parser rather than failing the whole run.
        const detail = String(e);
        if (/no article links/i.test(detail)) {
          // Expected for anything that isn't a link roundup — note it and move on.
          logWarn("agent", `No links found in "${p.subject}" — used default parsing`);
        } else {
          const message = `Agent failed for "${filterLabel(agent)}" — used default parsing. ${detail}`;
          setError(message);
          logError("agent", message);
        }
        return asPost();
      }
    };

    try {
      for (let i = 0; i < selected.length; i++) {
        const p = selected[i];
        report(`Fetching ${i + 1}/${selected.length}: ${p.subject}`);
        // The filter that found this post decides how it's read — and it's the
        // filter that remembers what gets struck out of it. A saved article was
        // found by no filter, so it has neither.
        const agent = decidingFilter(filters, p.filterIds);
        let entries = entryCache.current.get(p.id);
        if (entries === undefined) {
          if (p.source === "saved") {
            try {
              entries = await readSaved(p);
            } catch (e) {
              // One unreachable article is not a failed run; the log names it
              // and the digest goes on without it, as a dropped link does.
              logError("saved", `Could not read "${p.subject}": ${e}`);
              entries = [];
            }
          } else {
            if (agent?.useAgent && anthropicKey.trim()) {
              report(`Agent processing ${i + 1}/${selected.length}: ${p.subject}`);
            }
            entries = await readMail(p, agent);
          }
          entryCache.current.set(p.id, entries);
        }
        const ready = entries;
        setPrepared((prev) => [...prev, ...ready]);
        // Anything this filter has been told to remove before comes out again.
        const already = agent ? rememberedKeys(ready, agent) : [];
        if (already.length > 0) {
          setRemoved((prev) => new Set([...prev, ...already]));
          logInfo(
            "render",
            `Removed ${already.length} remembered element${already.length === 1 ? "" : "s"} ` +
              `from "${p.subject}"`
          );
        }
        setPrepareDone(i + 1);
        setProcessedCount(markProcessed([p.id]));
      }
      setProgress("");
      logInfo("render", "All posts prepared");
    } catch (e) {
      fail("render", e);
    } finally {
      setPreparing(false);
    }
  }, [posts, filters, anthropicKey, report, fail]);

  // The running order itself: the prepared entries under whichever arrangement
  // is in force. Everything downstream — the preview, the exporters, what a
  // click on a row means — reads this rather than the order they arrived in.
  const ordered = useMemo(
    () => orderPosts(prepared, order, customOrder),
    [prepared, order, customOrder]
  );

  /**
   * Moves a row. Dragging *is* the custom order, so a drag switches to it,
   * taking the arrangement on screen as its starting point — nothing jumps
   * under the hand that moved it.
   */
  const reorderPost = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || from >= ordered.length || to < 0 || to >= ordered.length) {
        return;
      }
      const ids = ordered.map((p) => p.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      setCustomOrder(ids);
      setOrder("custom");
      setOutput(null);
    },
    [ordered]
  );

  /**
   * Switches how the digest runs. Picking Custom before anything has been
   * dragged adopts what's on screen, so it's a starting point rather than an
   * empty one; an arrangement already made is kept and returned to.
   */
  const chooseOrder = useCallback(
    (next: PostOrder) => {
      if (next === "custom" && customOrder.length === 0) setCustomOrder(ordered.map((p) => p.id));
      setOrder(next);
      setOutput(null);
    },
    [ordered, customOrder]
  );

  const postsById = useMemo(() => new Map(prepared.map((p) => [p.id, p])), [prepared]);

  /**
   * Tells the filters what was struck out of their mail, for the ones set to
   * remember it. Putting something back is the other half of the bargain: the
   * filter forgets it, so it stops coming out of next week's post.
   */
  const rememberMarks = useCallback(
    (keys: string[], remove: boolean) => {
      const byFilter = new Map<string, string[]>();
      for (const key of keys) {
        const parsed = parseBlockKey(key);
        if (!parsed) continue;
        const post = postsById.get(parsed.postId);
        if (!post?.filterId) continue;
        const block = post.blocks[parsed.index];
        const signature = block && blockSignature(block);
        if (!signature) continue;
        const known = byFilter.get(post.filterId);
        if (known) known.push(signature);
        else byFilter.set(post.filterId, [signature]);
      }
      if (byFilter.size === 0) return;
      setFilters((fs) =>
        fs.map((f) => {
          const signatures = byFilter.get(f.id);
          return signatures && f.rememberRemovals ? withSignatures(f, signatures, remove) : f;
        })
      );
    },
    [postsById]
  );

  /** Marks blocks struck out, or takes the marks back when `remove` is false. */
  const markRemoved = useCallback(
    (keys: string[], remove: boolean) => {
      if (keys.length === 0) return;
      setRemoved((prev) => {
        const next = new Set(prev);
        for (const key of keys) {
          if (remove) next.add(key);
          else next.delete(key);
        }
        return next;
      });
      rememberMarks(keys, remove);
    },
    [rememberMarks]
  );

  const restoreAll = useCallback(() => {
    // Everything on screen is wanted after all, so nothing here is remembered.
    rememberMarks([...removed], false);
    setRemoved(new Set());
  }, [removed, rememberMarks]);

  /**
   * Takes a whole article out of the output, or puts it back. It's the same
   * marking the strike-out tool does, applied to every block at once, so the
   * entry reads as struck out in the preview too and nothing is really gone.
   *
   * A filter that remembers removals doesn't learn from this one: dropping an
   * article is about this digest, and teaching it every paragraph of a piece
   * would be a filter that remembers an article rather than its furniture.
   */
  const toggleEntryRemoved = useCallback((post: DigestPost) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      const keys = post.blocks.map((_, i) => blockKey(post.id, i));
      const alreadyGone = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (alreadyGone) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);

  /** How many of an entry's blocks survive into the output. */
  const keptBlocks = useCallback(
    (post: DigestPost) => post.blocks.filter((_, i) => !removed.has(blockKey(post.id, i))).length,
    [removed]
  );

  /**
   * Searches the Met's open collection for the issue's theme. Only pieces the
   * museum has released are looked at, so anything the grid offers is a picture
   * the digest may print.
   */
  const searchCover = useCallback(async () => {
    const query = theme.trim();
    if (!query) return;
    setError(null);
    setCoverSearching(true);
    logInfo("cover", `Searching the Met's open collection for "${query}"`);
    try {
      const found = await metSearch(query, COVER_RESULTS);
      setCoverResults(found);
      setSearched(query);
    } catch (e) {
      fail("cover", e);
    } finally {
      setCoverSearching(false);
    }
  }, [theme, fail]);

  /** Settles on a picture for the cover, or takes it back off again. */
  const chooseCover = useCallback((art: CoverArtwork | null) => {
    setCover(art);
    setOutput(null); // whatever was generated has the old cover on it
    logInfo("cover", art ? `Cover: ${artworkLabel(art)}` : "Cover picture cleared");
  }, []);

  // What Generate will actually lay out: the running order, less anything
  // struck out, less any entry that leaves nothing behind.
  const forOutput = useMemo(() => withRemovals(ordered, removed), [ordered, removed]);

  // The line under the masthead. The picker prints it on every candidate, so
  // what's on screen is the cover as it will come out.
  const coverIssueLine = useMemo(() => issueLine(forOutput), [forOutput]);

  const generate = useCallback(async () => {
    // Only reachable by clicking the last of the content out of the document
    // itself; the button is disabled with nothing to lay out.
    if (forOutput.length === 0) {
      setOutput(null);
      return;
    }
    setError(null);
    setGenerating(true);
    const startedAt = Date.now();
    const dropped = prepared.length - forOutput.length;
    logInfo(
      "render",
      `Generating ${settings.format.toUpperCase()} from ${forOutput.length} entries` +
        (removed.size > 0
          ? ` (${removed.size} block${removed.size === 1 ? "" : "s"} removed` +
            (dropped > 0 ? `, ${dropped} entr${dropped === 1 ? "y" : "ies"} emptied)` : ")")
          : "")
    );
    try {
      if (settings.format === "epub") {
        setOutput(await generateEpub(forOutput, settings, report, cover));
      } else {
        const { bytes, placements } = await generatePdf(forOutput, settings, report, cover);
        setOutput({ format: "pdf", bytes, placements });
      }
      setProgress("");
      logInfo("render", `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    } catch (e) {
      fail("render", e);
    } finally {
      setGenerating(false);
    }
  }, [forOutput, prepared.length, removed.size, settings, cover, report, fail]);

  // Regenerating after a click on the document itself. The generate callback is
  // rebuilt whenever the content changes, so it's read from a ref: the tick and
  // the removal land in the same render, and this fires with the new one.
  const generateRef = useRef(generate);
  useEffect(() => {
    generateRef.current = generate;
  });
  useEffect(() => {
    if (refreshTick > 0) void generateRef.current();
  }, [refreshTick]);

  /**
   * Takes the block a reader clicked in the generated PDF out of the digest and
   * lays the document out again. The previous one stays on screen meanwhile, so
   * the page doesn't vanish from under the click that changed it.
   */
  const removeFromOutput = useCallback(
    (key: string) => {
      if (generating) return;
      keepPreview.current = true;
      markRemoved([key], true);
      setRefreshTick((n) => n + 1);
      logInfo("render", "Removed an element from the page; laying the digest out again");
    },
    [generating, markRemoved]
  );

  const exportOutput = useCallback(async () => {
    if (!output) return;
    const ext = output.format;
    const path = await save({
      defaultPath: outputFileName(ext),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    try {
      await saveFile(path, toBase64(output.bytes));
      logInfo("save", `Wrote ${output.bytes.length.toLocaleString()} bytes to ${path}`);
    } catch (e) {
      fail("save", e);
    }
  }, [output, fail]);

  /** Hands the finished PDF to the system's own print dialog. */
  const printOutput = useCallback(async () => {
    if (output?.format !== "pdf") return;
    setError(null);
    report("Sending it to the printer…");
    try {
      logInfo("print", await printDocument(outputFileName("pdf"), toBase64(output.bytes)));
    } catch (e) {
      fail("print", e);
    } finally {
      setProgress("");
    }
  }, [output, report, fail]);

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
              title="Agent & settings"
            >
              <GearIcon />
            </button>
          </div>
        </div>

        {step === "select" ? (
          <>
            <div className="step-body">
              <InputPicker
                value={input}
                onChange={chooseInput}
                disabled={scanning || capturing}
              />

              {input === "gmail" ? (
                <>
                  <AuthPanel
                    account={account}
                    connecting={connecting}
                    onConnect={connect}
                    onCancel={cancelConnect}
                    onDisconnect={disconnect}
                  />
                  {account && (
                    <MailPanel
                      days={days}
                      range={range}
                      rangeValid={scanWindow !== null}
                      scanning={scanning}
                      filters={filters}
                      found={posts.length}
                      onDaysChange={setDays}
                      onRangeChange={setRange}
                      onToggleFilter={toggleFilter}
                      onEditFilters={() => setShowFilters(true)}
                      onScan={scan}
                    />
                  )}
                </>
              ) : (
                <SavedPanel
                  sources={sources}
                  sourceId={source?.id ?? ""}
                  onSourceChange={setSourceId}
                  onAddSource={addSource}
                  onRemoveSource={removeSource}
                  session={session}
                  onForgetSession={forgetSession}
                  onOpenBrowser={() => setBrowserOpen(true)}
                  captured={captured}
                  days={days}
                  range={range}
                  rangeValid={scanWindow !== null}
                  onDaysChange={setDays}
                  onRangeChange={setRange}
                />
              )}

              <PostList
                posts={posts}
                agentPosts={agentPosts}
                processed={processedBefore}
                limit={input === "gmail" ? SCAN_LIMIT : CAPTURE_LIMIT}
                onTogglePost={togglePost}
                onSetPostsSelected={setPostsSelected}
                onTogglePublication={togglePublication}
              />
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
                posts={ordered}
                done={prepareDone}
                total={prepareTotal}
                preparing={preparing}
                removing={removing}
                removedCount={removed.size}
                keptBlocks={keptBlocks}
                order={order}
                onOrderChange={chooseOrder}
                onReorder={reorderPost}
                onFocus={(id) => setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }))}
                onToggleRemoving={() => setRemoving((v) => !v)}
                onRestoreAll={restoreAll}
                onToggleEntry={toggleEntryRemoved}
              />
            </div>
            <div className="step-actions">
              <button
                className="primary"
                disabled={preparing || forOutput.length === 0}
                onClick={() => setStep("cover")}
              >
                {preparing ? "Preparing…" : "Continue to cover"}
              </button>
              {progress && <div className="progress">{progress}</div>}
              {error && <div className="error">{error}</div>}
            </div>
          </>
        ) : step === "cover" ? (
          <>
            <div className="step-body">
              <button
                className="back-link"
                onClick={() => setStep("organize")}
                title="Back to the running order"
              >
                ← {forOutput.length} entr{forOutput.length === 1 ? "y" : "ies"} in order
              </button>
              <CoverPanel
                enabled={settings.coverPage}
                onEnabledChange={(on) => setSettings((s) => ({ ...s, coverPage: on }))}
                theme={theme}
                onThemeChange={setTheme}
                searching={coverSearching}
                searched={searched}
                resultCount={coverResults.length}
                cover={cover}
                onSearch={searchCover}
                onClear={() => chooseCover(null)}
                format={settings.format}
              />
            </div>
            <div className="step-actions">
              <button className="primary" onClick={() => setStep("output")}>
                {settings.coverPage && !cover ? "Continue without a picture" : "Continue to output"}
              </button>
              {error && <div className="error">{error}</div>}
            </div>
          </>
        ) : (
          <>
            <div className="step-body">
              <button
                className="back-link"
                onClick={() => setStep("cover")}
                disabled={generating}
                title={generating ? "Finish generating first" : "Back to the cover"}
              >
                ← {cover ? cover.title || "Cover chosen" : "No cover picture"}
              </button>
              <h2 className="col-title">Output</h2>
              <SettingsPanel settings={settings} onChange={setSettings} />
            </div>
            <div className="step-actions">
              <button
                className="primary generate"
                disabled={generating || forOutput.length === 0}
                onClick={generate}
              >
                {generating ? "Generating…" : `Generate ${settings.format.toUpperCase()}`}
              </button>
              {output && !generating && (
                <div className="output-actions">
                  <button className="secondary" onClick={exportOutput}>
                    {`Save ${output.format.toUpperCase()}…`}
                  </button>
                  {output.format === "pdf" && (
                    <button className="secondary" onClick={printOutput} title="Print this digest">
                      Print…
                    </button>
                  )}
                </div>
              )}
              {progress && <div className="progress">{progress}</div>}
              {error && <div className="error">{error}</div>}
            </div>
          </>
        )}
      </aside>

      <main className="col col-preview">
        {step === "organize" ? (
          <ContentPreview
            posts={ordered}
            preparing={preparing}
            removing={removing}
            removed={removed}
            focus={focus}
            onMark={markRemoved}
          />
        ) : step === "cover" ? (
          <CoverGallery
            enabled={settings.coverPage}
            results={coverResults}
            searching={coverSearching}
            searched={searched}
            chosen={cover}
            onChoose={chooseCover}
            pageSize={settings.pageSize}
            font={settings.font}
            issueLine={coverIssueLine}
          />
        ) : (
          <Preview output={output} busy={generating} onRemoveBlock={removeFromOutput} />
        )}
      </main>

      {showLog && <LogPane onClose={() => setShowLog(false)} />}

      {browserOpen && source && (
        <BrowserModal
          url={openingUrl(source)}
          name={sourceLabel(source)}
          capturing={capturing}
          notice={captureNotice}
          onCapture={captureList}
          onClose={() => setBrowserOpen(false)}
        />
      )}

      {showFilters && (
        <FilterEditorModal
          filters={filters}
          hasKey={anthropicKey.trim().length > 0}
          onChange={setFilters}
          onClose={() => setShowFilters(false)}
        />
      )}

      {showSettings && (
        <SettingsModal
          anthropicKey={anthropicKey}
          onAnthropicKeyChange={saveAnthropicKey}
          processedCount={processedCount}
          onForgetProcessed={forgetProcessed}
          onClose={() => setShowSettings(false)}
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

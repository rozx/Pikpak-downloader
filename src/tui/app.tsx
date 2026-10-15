import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, useInput, usePaste, useWindowSize } from "ink";
import type { TuiController } from "./controller";
import { createTheme, type Theme } from "./theme";
import { buildRows, explain, scrollOffset, type Row } from "./view-model";
import { MainPanel, MIN_COLUMNS, MIN_ROWS, panelLayout, type Size } from "./main-panel";
import { CONFIRM_LINES, ConfirmDialog, DetailPage, PASTE_BOX_LINES, PasteBox, SettingsPage } from "./pages";

type Screen = { kind: "main" } | { kind: "detail"; fileId: string } | { kind: "settings" } | { kind: "paste" }
  | { kind: "confirm"; id: string; title: string; back: Screen } | { kind: "quit" };

export function TuiApp({ controller, theme = createTheme(), size: fixedSize }: { controller: TuiController; theme?: Theme; size?: Size }) {
  const windowSize = useWindowSize();
  const size = fixedSize ?? windowSize;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [screen, setScreen] = useState<Screen>({ kind: "main" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [pasteMessage, setPasteMessage] = useState<string | null>(null);
  const [setting, setSetting] = useState({ selected: 0, editing: false, error: null as string | null });

  const rows = useMemo(() => buildRows({ shares: snapshot.shares, files: snapshot.files, expanded, userPaused: snapshot.userPaused }), [snapshot, expanded]);
  const found = rows.findIndex(row => row.key === selectedKey);
  const selected = found >= 0 ? found : Math.min(Math.max(0, rows.findIndex(row => row.kind === "file")), Math.max(0, rows.length - 1));
  const row = rows[selected];
  const overlayLines = screen.kind === "confirm" || screen.kind === "quit" ? CONFIRM_LINES : screen.kind === "paste" ? PASTE_BOX_LINES : 0;
  const { listHeight } = panelLayout(size, snapshot, overlayLines);
  const effectiveOffset = scrollOffset(offset, selected, listHeight, rows.length);
  useEffect(() => { if (effectiveOffset !== offset) setOffset(effectiveOffset); }, [effectiveOffset, offset]);

  const select = (index: number) => { const target = rows[Math.min(Math.max(index, 0), rows.length - 1)]; if (target) setSelectedKey(target.key); };
  const run = async (command: Parameters<TuiController["command"]>[0]) => {
    const result = await controller.command(command);
    if (!result.ok) controller.note({ icon: "✗", tone: "error", text: `操作失败：${explain(result.reason).reason}` });
    return result;
  };
  const askCancel = (target: Row | undefined, back: Screen) => {
    if (!target) return;
    if (target.kind === "share") {
      const open = target.counts.total - target.counts.completed - target.counts.cancelled;
      setScreen({ kind: "confirm", id: target.share.id, title: `取消「${target.share.title ?? target.share.id}」中未完成的 ${open} 个文件？`, back });
    } else if (target.file.state === "completed") controller.note({ icon: "!", tone: "warning", text: `${target.name} 已完成，无需取消` });
    else setScreen({ kind: "confirm", id: target.file.id, title: `取消 ${target.name}？`, back });
  };
  const open = async (target: Row | undefined) => {
    if (!target) return;
    const result = await controller.openDirectory(target.kind === "share" ? { shareId: target.share.id } : { shareId: target.shareId, fileId: target.file.id });
    if (!result.ok) controller.note({ icon: "✗", tone: "error", text: `无法打开目录：${explain(result.reason).reason}` });
  };

  const quit = () => { setScreen({ kind: "main" }); controller.stop(); };
  // Ctrl+C 与 q 一样先确认；确认框中再按 Ctrl+C 视为确认，停止期间再按立即退出。
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (snapshot.stopping) controller.forceExit();
    else if (screen.kind === "quit") quit();
    else setScreen({ kind: "quit" });
  });

  useInput((input, key) => {
    if (key.ctrl || snapshot.stopping) return;
    if (key.upArrow) select(selected - 1);
    else if (key.downArrow) select(selected + 1);
    else if (key.pageUp) select(selected - listHeight);
    else if (key.pageDown) select(selected + listHeight);
    else if (key.leftArrow && row) {
      const shareId = row.kind === "share" ? row.share.id : row.shareId;
      setExpanded(value => ({ ...value, [shareId]: false })); setSelectedKey(`s:${shareId}`);
    } else if (key.rightArrow && row?.kind === "share") setExpanded(value => ({ ...value, [row.share.id]: true }));
    else if (key.return && row) {
      if (row.kind === "share") setExpanded(value => ({ ...value, [row.share.id]: !row.expanded }));
      else setScreen({ kind: "detail", fileId: row.file.id });
    } else if (input === "r" && row) void run({ kind: "retry", id: row.kind === "share" ? row.share.id : row.file.id });
    else if (input === "c") askCancel(row, { kind: "main" });
    else if (input === "p") void run(snapshot.userPaused ? { kind: "resumeQueue" } : { kind: "pauseQueue" });
    else if (input === "o") void open(row);
    else if (input === "a") { setDraft(""); setPasteMessage(null); setScreen({ kind: "paste" }); }
    else if (input === "s") { setSetting({ selected: 0, editing: false, error: null }); setScreen({ kind: "settings" }); }
    else if (input === "q") setScreen({ kind: "quit" });
  }, { isActive: screen.kind === "main" });

  useInput((input, key) => {
    if (input === "y") quit();
    else if (input === "n" || key.escape) setScreen({ kind: "main" });
  }, { isActive: screen.kind === "quit" && !snapshot.stopping });

  const detailFile = screen.kind === "detail" ? Object.values(snapshot.files).flat().find(file => file.id === screen.fileId) : undefined;
  const detailRow = detailFile ? rows.find(item => item.kind === "file" && item.file.id === detailFile.id) : undefined;
  useInput((input, key) => {
    if (key.escape) setScreen({ kind: "main" });
    else if (input === "r" && detailFile) void run({ kind: "retry", id: detailFile.id });
    else if (input === "c" && detailRow) askCancel(detailRow, screen);
    else if (input === "o" && detailRow) void open(detailRow);
  }, { isActive: screen.kind === "detail" });

  useInput((input, key) => {
    if (screen.kind !== "confirm") return;
    if (input === "y") { void run({ kind: "cancel", id: screen.id }); setScreen(screen.back.kind === "detail" ? screen.back : { kind: "main" }); }
    else if (input === "n" || key.escape) setScreen(screen.back);
  }, { isActive: screen.kind === "confirm" });

  const submitPaste = async () => {
    const result = await run({ kind: "submitText", text: draft });
    if (!result.ok) { setPasteMessage(`未能接收：${explain(result.reason).reason}`); return; }
    if (!result.ids.length) { setPasteMessage(result.issues.length ? "配对不明确，未接收任何分享" : "未识别到分享链接，未接收任何分享"); return; }
    setScreen({ kind: "main" });
  };
  usePaste(text => { setDraft(value => value + text.replace(/\r\n?/g, "\n")); setPasteMessage(null); }, { isActive: screen.kind === "paste" });
  useInput((input, key) => {
    if (key.escape) setScreen({ kind: "main" });
    else if (key.return) void submitPaste();
    else if (key.backspace || key.delete) setDraft(value => value.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setDraft(value => value + input);
  }, { isActive: screen.kind === "paste" });

  const saveOutput = async () => {
    const result = await controller.command({ kind: "setOutputRoot", path: draft.trim() });
    if (result.ok) setSetting(value => ({ ...value, editing: false, error: null }));
    else setSetting(value => ({ ...value, error: explain(result.reason).reason }));
  };
  usePaste(text => setDraft(value => value + text.replace(/[\r\n]+/g, "")), { isActive: screen.kind === "settings" && setting.editing });
  useInput((input, key) => {
    if (setting.editing) {
      if (key.escape) setSetting(value => ({ ...value, editing: false, error: null }));
      else if (key.return) void saveOutput();
      else if (key.backspace || key.delete) setDraft(value => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft(value => value + input);
      return;
    }
    if (key.escape) setScreen({ kind: "main" });
    else if (key.upArrow || key.downArrow) setSetting(value => ({ ...value, selected: 1 - value.selected, error: null }));
    else if (setting.selected === 0 && key.return) { setDraft(snapshot.outputRoot ?? ""); setSetting(value => ({ ...value, editing: true, error: null })); }
    else if (setting.selected === 1 && (key.return || input === " ")) void run({ kind: "setClipboardWatch", enabled: snapshot.clipboard === "off" });
  }, { isActive: screen.kind === "settings" });

  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) {
    return <Text {...theme.paint("warning")}>窗口太小（{size.columns}×{size.rows}），请放大到至少 {MIN_COLUMNS}×{MIN_ROWS}</Text>;
  }
  if (screen.kind === "detail" && detailFile) {
    const share = snapshot.shares.find(item => item.id === detailFile.shareId);
    return <DetailPage file={detailFile} shareTitle={share?.title ?? detailFile.shareId} targetPath={controller.targetPath(detailFile.id)} userPaused={snapshot.userPaused} size={size} theme={theme} />;
  }
  if (screen.kind === "settings") {
    return <SettingsPage outputRoot={snapshot.outputRoot} clipboardOn={snapshot.clipboard !== "off"} selected={setting.selected} editing={setting.editing}
      draft={draft} error={setting.error} size={size} theme={theme} />;
  }
  const keys: Array<[string, string]> = screen.kind === "confirm" ? [["y", "确认"], ["n", "返回"]]
    : screen.kind === "quit" ? [["y", "退出"], ["n", "返回"]]
    : screen.kind === "paste" ? [["Enter", "提交"], ["Esc", "取消"]]
    : [["↑↓", "选择"], ["←→", "折叠"], ["Enter", "详情"], ["r", "重试"], ["c", "取消"], ["p", snapshot.userPaused ? "继续" : "暂停"], ["o", "目录"], ["a", "粘贴"], ["s", "设置"], ["q", "退出"]];
  const overlay = screen.kind === "confirm"
    ? <ConfirmDialog heading="取消任务" title={screen.title} detail="本地文件、断点和云端副本都会保留，之后可用 r 恢复。" confirm="确认取消" theme={theme} />
    : screen.kind === "quit" ? <ConfirmDialog heading="退出程序" title="停止下载并退出？" detail="当前下载会在安全点停止并保存断点，下次启动继续。" confirm="停止并退出" theme={theme} />
    : screen.kind === "paste" ? <PasteBox draft={draft} preview={controller.preview(draft)} outputRoot={snapshot.outputRoot} message={pasteMessage} theme={theme} width={size.columns - 4} />
    : undefined;
  return <MainPanel snapshot={snapshot} rows={rows} selected={selected} offset={effectiveOffset} size={size} theme={theme} overlay={overlay} overlayLines={overlayLines} keys={keys} />;
}

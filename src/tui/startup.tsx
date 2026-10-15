import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import { AppError } from "../errors";
import type { TuiController } from "./controller";
import { createTheme, type Theme } from "./theme";
import { explain } from "./view-model";
import { Keys, Rule, SPINNER as spinner, Title } from "./parts";
import { Brand } from "./brand";
import { TuiApp, type AccountAction } from "./app";
import { PERMISSIONS } from "../auth/permissions";
import type { Size } from "./main-panel";

export type StartupDeps = {
  busy: boolean;
  account(): Promise<string | null>;
  login(announce: (message: string) => void, signal: AbortSignal): Promise<string>;
  outputRoot(): Promise<string | null>;
  defaultOutputRoot: string;
  saveOutputRoot(path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  start(account: string): Promise<TuiController>;
  exit(code: number): void;
  // 已保存授权缺少的必需权限名称；未知或齐全时为空（improve-account-login 决策 6）。
  missing?(): Promise<string[]>;
  // 在安全点停止当前执行但不退出程序；之后可以登出或重新授权。
  suspend?(): Promise<void>;
  logout?(): Promise<void>;
};
// login.back：取消授权后按 Esc 回到的账号（重新授权或权限不足时）；heading 替换“尚未登录”。
type Login = { kind: "login"; waiting: boolean; messages: string[]; error: string | null; back: string | null; heading?: string };
type Phase = { kind: "checking"; message?: string } | { kind: "busy" } | { kind: "failed"; message: string }
  | Login
  | { kind: "setup"; account: string; draft: string; error: string | null }
  | { kind: "main"; controller: TuiController; account: string };
const loginPhase = (patch: Partial<Login> = {}): Login => ({ kind: "login", waiting: false, messages: [], error: null, back: null, ...patch });
const requiredNames = PERMISSIONS.filter(permission => permission.required).map(permission => permission.label).join("、");
const reasonOf = (error: unknown) => error instanceof AppError ? error.code : "operation_failed";
// 完整标志连同下方提示至少需要 60×24，放不下时改为单行标题。
const BRAND_COLUMNS = 60, BRAND_ROWS = 24;

// 启动检查：执行实例 → 登录会话 → 下载目录 → 主面板。界面内不收集账号密码。
// 启动检查画面至少保留 splashMs，避免标志一闪而过。
export function StartupApp({ deps, theme = createTheme(), size: fixedSize, splashMs = 800 }: { deps: StartupDeps; theme?: Theme; size?: Size; splashMs?: number }) {
  const windowSize = useWindowSize();
  const size = fixedSize ?? windowSize;
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [tick, setTick] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const shownAt = useRef(Date.now());
  const splash = async () => {
    const left = splashMs - (Date.now() - shownAt.current);
    if (left > 0) await new Promise(resolve => setTimeout(resolve, left));
  };

  const startMain = async (account: string) => {
    setPhase({ kind: "checking" });
    try { setPhase({ kind: "main", controller: await deps.start(account), account }); }
    catch (error) {
      const reason = reasonOf(error);
      if (reason === "login_required") setPhase(loginPhase({ error: "登录已失效，请重新授权" }));
      else if (reason === "output_unavailable") setPhase({ kind: "setup", account, draft: deps.defaultOutputRoot, error: explain(reason).reason });
      else setPhase({ kind: "failed", message: `${explain(reason).reason}。${explain(reason).advice}` });
    }
  };
  const checkRoot = async (account: string) => {
    if (await deps.outputRoot()) await startMain(account);
    else setPhase({ kind: "setup", account, draft: deps.defaultOutputRoot, error: null });
  };
  useEffect(() => {
    if (deps.busy) { setPhase({ kind: "busy" }); return; }
    void (async () => {
      try {
        const account = await deps.account();
        await splash();
        if (!account) { setPhase(loginPhase()); return; }
        // 已保存的授权缺少必需权限：提示重新授权，也允许按 Esc 暂时继续。
        const missing = await deps.missing?.().catch(() => []) ?? [];
        if (missing.length) setPhase(loginPhase({ heading: "当前授权缺少必须的权限", error: `缺少：${missing.join("、")}`, back: account }));
        else await checkRoot(account);
      } catch (error) { await splash(); setPhase({ kind: "failed", message: explain(reasonOf(error)).reason }); }
    })();
  }, []);
  const spinning = phase.kind === "checking" || phase.kind === "login" && phase.waiting;
  useEffect(() => {
    if (!spinning) return;
    const timer = setInterval(() => setTick(value => value + 1), 80);
    return () => clearInterval(timer);
  }, [spinning]);

  const authorize = async (back: string | null, heading?: string) => {
    const controller = new AbortController(); abort.current = controller;
    setPhase(loginPhase({ waiting: true, back, ...heading ? { heading } : {} }));
    try {
      // 只保留最近 3 条提示，多次权限不足时不会挤掉操作说明。
      const account = await deps.login(message => setPhase(value => value.kind === "login" ? { ...value, messages: [...value.messages, message].slice(-3) } : value), controller.signal);
      abort.current = null; await checkRoot(account);
    } catch {
      abort.current = null;
      setPhase(loginPhase({ back, ...heading ? { heading } : {}, error: controller.signal.aborted ? "已取消授权" : "授权未完成，请重试" }));
    }
  };
  // 账号页的登出与重新授权：先停止当前执行，再登出或打开浏览器授权。
  const accountAction = async (action: AccountAction, account: string) => {
    setPhase({ kind: "checking", message: "正在停止当前下载并保存进度…" });
    try { await deps.suspend?.(); }
    catch { setPhase({ kind: "failed", message: "当前下载未能及时停止，请退出程序后重试" }); return; }
    if (action === "reauthorize") { await authorize(account, "重新授权"); return; }
    try { await deps.logout?.(); setPhase(loginPhase({ heading: "已登出" })); }
    catch (error) { setPhase({ kind: "failed", message: explain(reasonOf(error)).reason }); }
  };
  const save = async (phaseValue: Extract<Phase, { kind: "setup" }>) => {
    const result = await deps.saveOutputRoot(phaseValue.draft.trim());
    if (result.ok) await startMain(phaseValue.account);
    else setPhase({ ...phaseValue, error: explain(result.reason).reason });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") { abort.current?.abort(); deps.exit(130); return; }
    if (phase.kind === "busy" || phase.kind === "failed") { deps.exit(1); return; }
    if (phase.kind === "login") {
      if (phase.waiting) { if (key.escape) abort.current?.abort(); return; }
      if (key.return) void authorize(phase.back, phase.heading);
      else if (phase.back && key.escape) void checkRoot(phase.back);
      else if (key.escape || input === "q") deps.exit(0);
      return;
    }
    if (phase.kind === "setup") {
      if (key.escape) deps.exit(0);
      else if (key.return) void save(phase);
      else if (key.backspace || key.delete) setPhase({ ...phase, draft: phase.draft.slice(0, -1), error: null });
      else if (input && !key.ctrl && !key.meta) setPhase({ ...phase, draft: phase.draft + input, error: null });
    }
  }, { isActive: phase.kind !== "main" && phase.kind !== "checking" });
  usePaste(text => setPhase(value => value.kind === "setup" ? { ...value, draft: value.draft + text.replace(/[\r\n]+/g, ""), error: null } : value),
    { isActive: phase.kind === "setup" });

  if (phase.kind === "main") {
    const account = phase.account;
    return <TuiApp controller={phase.controller} theme={theme} {...fixedSize ? { size: fixedSize } : {}} onAccount={action => void accountAction(action, account)} />;
  }
  const compact = size.columns < BRAND_COLUMNS || size.rows < BRAND_ROWS;
  const centered = (children: React.ReactNode) => (
    <Box flexDirection="column" height={size.rows} alignItems="center" justifyContent="center" gap={1}>
      <Brand theme={theme} compact={compact} />{children}
    </Box>
  );
  if (phase.kind === "checking") return centered(<Text {...theme.paint("muted")}><Text {...theme.paint("active")}>{spinner[tick % spinner.length]}</Text> {phase.message ?? "正在检查登录状态与下载目录…"}</Text>);
  if (phase.kind === "busy" || phase.kind === "failed") {
    return centered(<>
      {phase.kind === "busy"
        ? <Box flexDirection="column" alignItems="center"><Text {...theme.paint("warning")}>已有实例正在使用任务库（watch 或另一个界面）。</Text><Text {...theme.paint("muted")}>请先退出它；也可以在另一个终端用 status 只读查看。</Text></Box>
        : <Text {...theme.paint("error")}>{phase.message}</Text>}
      <Text {...theme.paint("muted")}>按任意键退出</Text>
    </>);
  }
  if (phase.kind === "login") {
    return centered(<>
      <Box flexDirection="column" alignItems="center">
        <Text {...theme.paint("warning")}>{phase.heading ?? "尚未登录"}</Text>
        <Text {...theme.paint("text")}>按 <Text {...theme.paint("key")} bold>Enter</Text> 在浏览器中打开 PikPak 官方授权页</Text>
        <Text {...theme.paint("text")}>授权页会逐项列出权限，请全部勾选（必须：{requiredNames}）</Text>
        <Text {...theme.paint("muted")}>密码只在官方页面输入，本程序不会接触你的密码</Text>
      </Box>
      {phase.waiting && <Text><Text {...theme.paint("active")}>{spinner[tick % spinner.length]} 正在等待浏览器授权…</Text><Text {...theme.paint("muted")}>   Esc 取消</Text></Text>}
      {phase.messages.map((message, index) => <Text key={index} {...theme.paint("muted")}>{message}</Text>)}
      {phase.error && <Text {...theme.paint("error")}>✗ {phase.error}</Text>}
      {!phase.waiting && <Text {...theme.paint("muted")}>{phase.back ? "Esc 返回，继续使用当前授权" : "Esc 退出"}</Text>}
    </>);
  }
  return (
    <Box flexDirection="column" height={size.rows} paddingX={1}>
      <Title text="首次设置" theme={theme} />
      <Rule width={size.columns - 2} theme={theme} />
      <Box flexDirection="column" flexGrow={1} paddingTop={1} gap={1}>
        <Text {...theme.paint("text")}>选择下载目录：</Text>
        <Text {...theme.paint("strong")}>{phase.draft}<Text {...theme.paint("key")}>▌</Text></Text>
        <Text {...theme.paint("muted")}>目录不存在时会自动创建；之后可以在设置页修改，已开始下载的分享保留原目录。</Text>
        {phase.error && <Text {...theme.paint("error")}>✗ {phase.error}</Text>}
      </Box>
      <Rule width={size.columns - 2} theme={theme} />
      <Keys items={[["Enter", "保存"], ["Esc", "退出"]]} theme={theme} />
    </Box>
  );
}

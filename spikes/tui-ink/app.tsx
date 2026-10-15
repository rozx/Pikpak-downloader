// Ink 打包验证程序（任务 1.1/1.2）：只验证终端能力，不接入任何业务代码或账号资料。
import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize, type Key } from "ink";

declare const INK_VERSION: string | undefined;
const inkVersion = typeof INK_VERSION === "string" ? INK_VERSION : "dev";
const restoreSequence = "\x1b[?2004l\x1b[?25h\x1b[?1049l";
let hardExit = () => {};

type State = "done" | "downloading" | "queued" | "failed" | "waiting";
const samples = ["episode01.mkv", "第一季/第02集 某某合集 1080p 内嵌中字.mkv", "纪录片合集/第一季/part1.mp4",
  "非常长的文件名用于测试中间省略是否按照显示宽度计算而不是按字符数计算.zip", "alpha-beta-gamma-delta-epsilon-zeta-eta-theta.tar.gz",
  "日本語のファイル名テスト.mp4", "한국어 파일 이름.mkv", "混合 Mixed 名称 ABC 中文.rar"];
const states: readonly State[] = ["done", "downloading", "queued", "failed", "waiting"];
const items = Array.from({ length: 40 }, (_, index) => ({
  name: `${String(index + 1).padStart(2, "0")} ${samples[index % samples.length]}`,
  size: `${(index * 37) % 900 + 12} MB`, state: states[index % states.length]!,
}));
const looks: Record<State, { icon: string; color: string; label: string }> = {
  done: { icon: "✓", color: "green", label: "已完成" }, downloading: { icon: "↓", color: "cyan", label: "下载中" },
  queued: { icon: "·", color: "gray", label: "排队中" }, failed: { icon: "✗", color: "red", label: "失败" },
  waiting: { icon: "⌛", color: "yellow", label: "等待云端空间" },
};
type Mode = "list" | "input" | "confirm" | "stopping";
const flags = (key: Key) => Object.entries(key).filter(([, value]) => value === true).map(([name]) => name).join(",");

function App() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const record = (line: string) => setLog(previous => [...previous.slice(-5), `${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${line}`]);
  const stop = () => { setMode("stopping"); record("开始停止，3 秒后退出"); setTimeout(() => exit(), 3000); };

  useEffect(() => {
    const timer = setInterval(() => setProgress(value => (value + 1) % 101), 100);
    return () => clearInterval(timer);
  }, []);

  usePaste(text => {
    const lines = text.split(/\r\n|\r|\n/).length;
    if (mode !== "input") { record(`粘贴已忽略（不在输入模式）len=${text.length} 行=${lines}`); return; }
    setDraft(previous => previous + text.replace(/\r\n?/g, "\n"));
    record(`粘贴 len=${text.length} 行=${lines}`);
  });

  useInput((input, key) => {
    record(`按键 input=${JSON.stringify(input).slice(0, 40)} len=${input.length} [${flags(key)}]`);
    if (key.ctrl && input === "c") { if (mode === "stopping") hardExit(); else stop(); return; }
    if (mode === "stopping") return;
    if (mode === "confirm") {
      if (input === "y") { record("确认：y"); setMode("list"); }
      else if (input === "n" || key.escape) { record("取消确认"); setMode("list"); }
      return;
    }
    if (mode === "input") {
      if (key.escape) setMode("list");
      else if (key.return) { record(`提交 ${draft.split("\n").length} 行 ${draft.length} 字符`); setDraft(""); setMode("list"); }
      else if (key.backspace || key.delete) setDraft(value => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft(value => value + input);
      return;
    }
    if (key.upArrow) setSelected(value => Math.max(0, value - 1));
    else if (key.downArrow) setSelected(value => Math.min(items.length - 1, value + 1));
    else if (key.pageUp) setSelected(value => Math.max(0, value - 10));
    else if (key.pageDown) setSelected(value => Math.min(items.length - 1, value + 10));
    else if (input === "a") setMode("input");
    else if (input === "c") setMode("confirm");
    else if (input === "q") stop();
    else if (input === "x") setTimeout(() => { throw new Error("模拟未处理异常"); }, 0);
  });

  if (columns < 60 || rows < 15) return <Text color="yellow">窗口太小（{columns}×{rows}），请放大到至少 60×15</Text>;
  const listHeight = Math.max(3, rows - 15);
  const start = Math.min(Math.max(0, selected - Math.floor(listHeight / 2)), Math.max(0, items.length - listHeight));
  const rule = <Text color="gray">{"─".repeat(Math.max(0, columns - 1))}</Text>;
  const filled = Math.round(progress / 100 * 12);
  return (
    <Box flexDirection="column">
      <Box>
        <Text backgroundColor="blue" color="whiteBright" bold> Ink 打包验证 </Text>
        <Text color="gray">  {columns}×{rows} · Ink {inkVersion} · React {React.version} · Bun {Bun.version} · {process.platform}-{process.arch}</Text>
      </Box>
      {rule}
      {items.slice(start, start + listHeight).map((item, offset) => {
        const index = start + offset, look = looks[item.state];
        return (
          <Box key={index}>
            <Text>{index === selected ? "> " : "  "}</Text>
            <Box width={3}><Text color={look.color}>{look.icon}</Text></Box>
            <Box width={40}><Text wrap="truncate-middle" inverse={index === selected}>{item.name}</Text></Box>
            <Box width={9}><Text color="gray">{item.size}</Text></Box>
            {item.state === "downloading"
              ? <Text><Text color="cyan">{"█".repeat(filled)}</Text><Text color="gray">{"░".repeat(12 - filled)}</Text><Text> {progress}%</Text></Text>
              : <Text color={look.color}>{look.label}</Text>}
          </Box>
        );
      })}
      {mode === "input" && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
          <Text color="cyan" bold>粘贴或输入多行文本（Enter 提交，Esc 返回）</Text>
          {(draft || " ").split("\n").slice(-4).map((line, index) => <Text key={index}>{line || " "}</Text>)}
        </Box>
      )}
      {mode === "confirm" && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
          <Text color="yellow" bold>取消「{items[selected]!.name}」？</Text>
          <Text><Text color="yellowBright" bold>y</Text> 确认    <Text color="yellowBright" bold>n</Text> 返回</Text>
        </Box>
      )}
      {rule}
      {log.map((line, index) => <Text key={index} color="gray">{line}</Text>)}
      {rule}
      {mode === "stopping"
        ? <Text color="yellow">正在停止并保存进度…（再按 Ctrl+C 立即退出）</Text>
        : <Text><Text color="yellowBright" bold>↑↓/PgUp/PgDn</Text> 选择  <Text color="yellowBright" bold>a</Text> 输入框  <Text color="yellowBright" bold>c</Text> 确认框  <Text color="yellowBright" bold>x</Text> 模拟异常  <Text color="yellowBright" bold>q</Text> 退出</Text>}
    </Box>
  );
}

const instance = render(<App />, { exitOnCtrlC: false, alternateScreen: true, maxFps: 10, incrementalRendering: true });
hardExit = () => { process.stdout.write(`${restoreSequence}已立即退出（停止期间第二次 Ctrl+C）\n`); process.exit(130); };
process.on("uncaughtException", error => {
  try { instance.unmount(); } catch { /* 卸载失败时仍写入恢复序列。 */ }
  process.stdout.write(`${restoreSequence}验证程序捕获未处理异常，终端已恢复：${error.message}\n`);
  process.exit(1);
});
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => { instance.unmount(); process.stdout.write(restoreSequence); process.exit(143); });
}
await instance.waitUntilExit();
process.stdout.write("验证程序已正常退出，主屏幕原内容应已恢复。\n");

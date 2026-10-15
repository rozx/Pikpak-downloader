// 效果图还原：用 Ink 按已确认的六张效果图绘制界面，只用于在真实终端中对比观感，不接入业务代码。
import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";

type FileState = "done" | "downloading" | "queued" | "failed" | "waiting" | "paused";
type MockFile = { name: string; size: string; state: FileState; note?: string };
type MockShare = { title: string; path: string; files: MockFile[] };
const shares: MockShare[] = [
  { title: "某某合集", path: "~\\Downloads\\PikPak-Test", files: [
    { name: "episode01.mkv", size: "412 MB", state: "done" },
    { name: "episode02.mkv", size: "412 MB", state: "downloading" },
    { name: "episode03.mkv", size: "380 MB", state: "queued" },
  ] },
  { title: "纪录片合集", path: "~\\Downloads\\PikPak-Test", files: [
    { name: "第一季/part1.mp4", size: "2.1 GB", state: "failed", note: "失败 · 下载地址多次失效，已重试 3 次" },
    { name: "第一季/part2.mp4", size: "1.8 GB", state: "waiting", note: "等待云端空间（需 1.8 GB，可用 0.6 GB）" },
  ] },
  { title: "另一个分享", path: "~\\Downloads\\PikPak-Test", files: [
    { name: "readme.txt", size: "4 KB", state: "done" }, { name: "资料包.zip", size: "96 MB", state: "done" },
  ] },
];
const looks: Record<FileState, { icon: string; color: string; label: string }> = {
  done: { icon: "✓", color: "green", label: "已完成" }, downloading: { icon: "↓", color: "cyan", label: "下载中" },
  queued: { icon: "·", color: "gray", label: "排队中" }, failed: { icon: "✗", color: "red", label: "失败" },
  waiting: { icon: "⌛", color: "yellow", label: "等待" }, paused: { icon: "⏸", color: "yellow", label: "已暂停" },
};
const events = [
  { time: "22:33:40", icon: "✓", color: "green", text: "episode01.mkv 校验通过，已完成" },
  { time: "22:32:12", icon: "✗", color: "red", text: "part1.mp4 下载失败，本轮 3 次重试已用完" },
  { time: "22:31:07", icon: "⟳", color: "magenta", text: "「某某合集」扫描完成：3 个文件，共 1.2 GB" },
];
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function useTicker(interval: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), interval); return () => clearInterval(timer); }, [interval]);
  return tick;
}
const Rule = ({ width }: { width: number }) => <Text color="gray">{"─".repeat(Math.max(0, width))}</Text>;
const Keys = ({ items }: { items: Array<[string, string]> }) => (
  <Text>{items.map(([key, label]) => <Text key={key}><Text color="yellowBright" bold>{key}</Text><Text color="gray"> {label}  </Text></Text>)}<Text color="gray">│ 1–6 切换画面</Text></Text>
);
const Title = ({ text, extra }: { text: string; extra?: string }) => (
  <Box><Text backgroundColor="blue" color="whiteBright" bold> {text} </Text>{extra ? <Text color="white">  {extra}</Text> : null}</Box>
);
function Header() {
  return (
    <Box>
      <Text backgroundColor="blue" color="whiteBright" bold> PikPak Downloader </Text>
      <Text color="green">  ● </Text><Text color="white">已登录</Text>
      <Text color="gray">   云盘 </Text><Text color="white">21.0 GB / 10 TB</Text>
      <Text color="gray">   本地剩余 </Text><Text color="white">412 GB</Text>
      <Text color="gray">   剪贴板 </Text><Text color="green">● 监听中</Text>
    </Box>
  );
}
function Bar({ percent, width = 14, paused = false }: { percent: number; width?: number; paused?: boolean }) {
  const filled = Math.round(percent / 100 * width);
  return <Text><Text color={paused ? "yellow" : "cyan"}>{"█".repeat(filled)}</Text><Text color="gray">{"░".repeat(width - filled)}</Text></Text>;
}
const duration = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}分${String(Math.round(seconds % 60)).padStart(2, "0")}秒` : `${Math.round(seconds)}秒`;

type Row = { kind: "share"; share: number } | { kind: "file"; share: number; file: number };
function MainPanel({ paused, confirm }: { paused: boolean; confirm: boolean }) {
  const { columns, rows } = useWindowSize();
  const tick = useTicker(100);
  const [expanded, setExpanded] = useState([true, true, false]);
  const [selected, setSelected] = useState(paused ? 3 : 2);
  const visible: Row[] = shares.flatMap((share, index) => [{ kind: "share", share: index } as Row,
    ...(expanded[index] ? share.files.map((_, file) => ({ kind: "file", share: index, file }) as Row) : [])]);
  useInput((_input, key) => {
    if (key.upArrow) setSelected(value => Math.max(0, value - 1));
    if (key.downArrow) setSelected(value => Math.min(visible.length - 1, value + 1));
    const row = visible[selected];
    if (row && (key.leftArrow || key.rightArrow)) setExpanded(value => value.map((open, index) => index === row.share ? key.rightArrow : open));
  });
  const percent = paused ? 48 : 48 + (tick * 0.3) % 52;
  const speed = 2.4 + 0.6 * Math.abs(Math.sin(tick / 15));
  const nameWidth = Math.max(18, Math.min(44, columns - 72));
  const inner = columns - 2;
  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <Header />
      {paused && <Text><Text backgroundColor="yellow" color="black" bold> ⏸ 队列已暂停 </Text><Text color="yellow">  当前下载已在安全点停止，断点已保存。按 </Text><Text color="yellowBright" bold>p</Text><Text color="yellow"> 继续</Text></Text>}
      <Rule width={inner} />
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((row, index) => {
          const isSelected = index === selected;
          const share = shares[row.share]!;
          if (row.kind === "share") {
            const states = share.files.map(file => paused && file.state === "downloading" ? "paused" : file.state);
            const count = (state: FileState) => states.filter(value => value === state).length;
            return (
              <Box key={`s${row.share}`} backgroundColor={isSelected ? "blue" : undefined}>
                <Text color="gray">{expanded[row.share] ? "▼ " : "▶ "}</Text>
                <Text color="whiteBright" bold>「{share.title}」</Text>
                <Text color="green">  {count("done")}/{share.files.length} 完成</Text>
                {count("downloading") > 0 && <Text color="cyan"> · {count("downloading")} 下载中</Text>}
                {count("paused") > 0 && <Text color="yellow"> · {count("paused")} 暂停</Text>}
                {count("queued") > 0 && <Text color="gray"> · {count("queued")} 排队</Text>}
                {count("failed") > 0 && <Text color="red"> · {count("failed")} 失败</Text>}
                {count("waiting") > 0 && <Text color="yellow"> · {count("waiting")} 等待</Text>}
                <Box flexGrow={1} justifyContent="flex-end"><Text color="gray">{row.share === 0 ? share.path : ""}</Text></Box>
              </Box>
            );
          }
          const file = share.files[row.file]!;
          const state: FileState = paused && file.state === "downloading" ? "paused" : file.state;
          const look = looks[state];
          return (
            <Box key={`f${row.share}-${row.file}`} backgroundColor={isSelected ? "blue" : undefined}>
              <Text color="whiteBright">{isSelected ? "  > " : "    "}</Text>
              <Box width={3}><Text color={look.color}>{look.icon}</Text></Box>
              <Box width={nameWidth} marginRight={1}><Text color={isSelected ? "whiteBright" : "white"} wrap="truncate-middle">{file.name}</Text></Box>
              <Box width={8} marginRight={1}><Text color="gray">{file.size}</Text></Box>
              {state === "downloading" ? (
                <Text><Bar percent={percent} /><Text color="whiteBright">  {Math.floor(percent)}%</Text><Text color="white">  {Math.round(412 * percent / 100)}/412 MB</Text>
                  <Text color="cyan">  {speed.toFixed(1)} MB/s</Text><Text color="gray">  {duration(412 * (100 - percent) / 100 / speed)}</Text></Text>
              ) : state === "paused" ? (
                <Text><Bar percent={percent} paused /><Text color="white">  48%</Text><Text color="yellow">  已暂停</Text></Text>
              ) : <Text color={look.color}>{file.note ?? look.label}</Text>}
            </Box>
          );
        })}
        {confirm && (
          <Box marginLeft={10} marginTop={1} borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} width={60}>
            <Text color="yellowBright" bold>取消任务</Text>
            <Text color="white">取消「纪录片合集」中未完成的 2 个文件？</Text>
            <Text color="gray">本地文件、断点和云端副本都会保留，之后可用 r 恢复。</Text>
            <Text> </Text>
            <Text><Text color="yellowBright" bold>y</Text><Text color="white"> 确认取消    </Text><Text color="yellowBright" bold>n</Text><Text color="white"> 返回</Text></Text>
          </Box>
        )}
      </Box>
      <Rule width={inner} />
      {events.map(event => <Text key={event.time}><Text color="gray">{event.time}  </Text><Text color={event.color}>{event.icon} </Text><Text color="white">{event.text}</Text></Text>)}
      <Rule width={inner} />
      {confirm ? <Keys items={[["y", "确认"], ["n", "返回"]]} />
        : <Keys items={[["↑↓", "选择"], ["←→", "折叠"], ["Enter", "详情"], ["r", "重试"], ["c", "取消"], ["p", paused ? "继续" : "暂停"], ["o", "目录"], ["a", "粘贴"], ["s", "设置"], ["q", "退出"]]} />}
    </Box>
  );
}

function DetailPage() {
  const { columns, rows } = useWindowSize();
  const fields: Array<[string, string, string]> = [
    ["文件", "part1.mp4", "whiteBright"], ["相对路径", "纪录片合集/第一季/part1.mp4", "white"], ["大小", "2.1 GB（2,254,857,830 字节）", "white"],
    ["状态", "✗ 失败", "red"], ["原因", "下载地址连续刷新 3 次后仍被拒绝", "red"], ["建议", "检查网络或代理后按 r 重试；断点已保存，会从 37% 继续", "cyan"],
    ["已重试", "3 次（本轮预算已用完）", "white"], ["断点", "812 MB / 2.1 GB", "white"], ["云端副本", "保留中 · 交付完成后才可能被回收", "white"],
    ["本地目标", "~\\Downloads\\PikPak-Test\\纪录片合集\\第一季\\part1.mp4", "gray"],
  ];
  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <Title text="文件详情" extra="「纪录片合集」" />
      <Rule width={columns - 2} />
      <Box flexDirection="column" flexGrow={1} paddingTop={1}>
        {fields.map(([label, value, color]) => <Box key={label}><Box width={12}><Text color="gray">  {label}</Text></Box><Text color={color}>{value}</Text></Box>)}
      </Box>
      <Rule width={columns - 2} />
      <Keys items={[["r", "重试"], ["c", "取消"], ["o", "打开目录"], ["Esc", "返回"]]} />
    </Box>
  );
}

function PastePage() {
  const { columns, rows } = useWindowSize();
  const dim = (text: string) => <Text color="gray" dimColor>{text}</Text>;
  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <Header />
      <Rule width={columns - 2} />
      {dim("▼「某某合集」  1/3 完成 · 1 下载中 · 1 排队")}
      {dim("    ✓  episode01.mkv              412 MB   已完成")}
      <Box marginLeft={10} marginY={1} borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} width={66}>
        <Text color="cyanBright" bold>粘贴分享文本</Text>
        <Text color="white">https://mypikpak.com/s/VOxxxxxxxxxxxxxxxxxxxxxx</Text>
        <Text> </Text>
        <Text color="white">提取码：ab12</Text>
        <Text color="gray">{"─".repeat(60)}</Text>
        <Text color="green">✓ 识别到 1 个分享 · 提取码 ✓ · 下载到 ~\Downloads\PikPak-Test</Text>
        <Text><Text color="yellowBright" bold>Enter</Text><Text color="gray"> 提交   </Text><Text color="yellowBright" bold>Esc</Text><Text color="gray"> 取消</Text></Text>
      </Box>
      {dim("    ·  episode03.mkv              380 MB   排队中")}
      <Box flexGrow={1} />
      <Rule width={columns - 2} />
      <Keys items={[["Enter", "提交"], ["Esc", "取消"]]} />
    </Box>
  );
}

function SettingsPage() {
  const { columns, rows } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const [watching, setWatching] = useState(true);
  useInput((input, key) => {
    if (key.upArrow || key.downArrow) setSelected(value => 1 - value);
    if (input === " " && selected === 1) setWatching(value => !value);
  });
  const item = (index: number, label: string, value: React.ReactNode, note: string) => (
    <Box key={label} flexDirection="column">
      <Box backgroundColor={selected === index ? "blue" : undefined}>
        <Text color="whiteBright">{selected === index ? "> " : "  "}</Text>
        <Box width={14}><Text color={selected === index ? "whiteBright" : "white"}>{label}</Text></Box>{value}
      </Box>
      <Box marginLeft={16}><Text color="gray">{note}</Text></Box>
    </Box>
  );
  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <Title text="设置" />
      <Rule width={columns - 2} />
      <Box flexDirection="column" flexGrow={1} paddingTop={1} gap={1}>
        {item(0, "下载目录", <Text color="whiteBright">C:\Users\lisid\Downloads\PikPak-Test</Text>, "仅对新接收的分享生效，已有分享沿用原目录")}
        {item(1, "剪贴板监听", <Text color={watching ? "green" : "gray"}>{watching ? "● 开" : "○ 关"}</Text>, "关闭后只能用 a 粘贴分享文本")}
      </Box>
      <Rule width={columns - 2} />
      <Keys items={[["↑↓", "选择"], ["Enter", "修改"], ["Space", "切换"], ["Esc", "返回"]]} />
    </Box>
  );
}

function LoginPage() {
  const { rows } = useWindowSize();
  const tick = useTicker(80);
  return (
    <Box flexDirection="column" height={rows} alignItems="center" justifyContent="center" gap={1}>
      <Text color="cyanBright" bold>PikPak Downloader</Text>
      <Box flexDirection="column" alignItems="center">
        <Text color="yellow">尚未登录</Text>
        <Text color="white">按 <Text color="yellowBright" bold>Enter</Text> 在浏览器中打开 PikPak 官方授权页</Text>
        <Text color="gray">密码只在官方页面输入，本程序不会接触你的密码</Text>
      </Box>
      <Text><Text color="cyan">{spinner[tick % spinner.length]} 正在等待浏览器授权…</Text><Text color="gray">   Esc 取消   │ 1–6 切换画面</Text></Text>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [screen, setScreen] = useState(1);
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) exit();
    else if (/^[1-6]$/.test(input)) setScreen(Number(input));
  });
  if (columns < 60 || rows < 15) return <Text color="yellow">窗口太小（{columns}×{rows}），请放大到至少 60×15</Text>;
  if (screen === 2) return <MainPanel key="paused" paused confirm />;
  if (screen === 3) return <DetailPage />;
  if (screen === 4) return <PastePage />;
  if (screen === 5) return <SettingsPage />;
  if (screen === 6) return <LoginPage />;
  return <MainPanel key="main" paused={false} confirm={false} />;
}

const instance = render(<App />, { exitOnCtrlC: false, alternateScreen: true, maxFps: 10, incrementalRendering: true });
await instance.waitUntilExit();

import { expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";

// 确认 TSX、Ink 与测试渲染工具链可用；界面行为测试随后续任务加入。
test("Ink 组件可在测试中渲染为文本帧", () => {
  const { lastFrame, unmount } = render(<Box><Text color="green">✓ </Text><Text>中文名称.mkv</Text></Box>);
  try { expect(lastFrame()).toContain("✓ 中文名称.mkv"); }
  finally { unmount(); }
});

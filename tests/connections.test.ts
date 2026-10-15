import { expect, test } from "bun:test";
import { DEFAULT_CONNECTIONS, MAX_CONNECTIONS, configuredConnections, parseConnections, saveConnections } from "../src/download/connections";

function memoryConfig(initial: string | null = null) {
  let value = initial;
  return { config: () => value, setConfig: (_key: string, next: string) => { value = next; }, get value() { return value; } };
}

test("连接数只接受 1–8 的整数，未设置或库中值无效时取默认值 4", () => {
  expect([DEFAULT_CONNECTIONS, MAX_CONNECTIONS]).toEqual([4, 8]);
  expect(["1", "4", "8"].map(parseConnections)).toEqual([1, 4, 8]);
  for (const bad of ["0", "-1", "9", "10", "4.5", "04", " 4", "4 ", "", "abc", "1e1"]) expect(parseConnections(bad)).toBe(null);
  expect(configuredConnections(memoryConfig())).toBe(4);
  expect(configuredConnections(memoryConfig("6"))).toBe(6);
  expect(configuredConnections(memoryConfig("12"))).toBe(4);
});

test("保存非法值时报错并保留原值", () => {
  const store = memoryConfig("6");
  for (const bad of [0, -1, 4.5, 9, "x"]) { expect(() => saveConnections(store, bad)).toThrow(); expect(store.value).toBe("6"); }
  expect(saveConnections(store, 8)).toBe(8); expect(store.value).toBe("8");
  expect(saveConnections(store, "1")).toBe(1); expect(store.value).toBe("1");
});

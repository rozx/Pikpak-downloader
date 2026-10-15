// 独立产物的入口：Bun.build 编译的产物中入口模块的 import.meta.main 为 false，不能依赖 cli.ts 的入口判断。
import { main } from "./cli";

await main();

import { author, homepage, version } from "../package.json";

// 名称、版本、作者与项目地址统一取自 package.json，界面与帮助文本共用。
export const about = { name: "PikPak Downloader", version, author, homepage, site: homepage.replace(/^https?:\/\//, "") } as const;

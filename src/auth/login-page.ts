import { about } from "../about";
import { PERMISSIONS, type Permission } from "./permissions";

// 本地授权页面（improve-account-login 决策 4）：只用内联样式，不加载脚本或外部资源；不得包含令牌、授权码等秘密。
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const style = `
:root{color-scheme:light dark;--bg:#f4f6fb;--card:#fff;--text:#1d2433;--muted:#5d6678;--line:#e3e7ef;--accent:#2f6bff;--accent-text:#fff;
--ok:#16865a;--ok-bg:#e6f6ee;--warn:#b25e00;--warn-bg:#fff4e0;--err:#c62f3a;--err-bg:#fdecee;--chip:#eef2fb}
@media (prefers-color-scheme:dark){:root{--bg:#10131a;--card:#191e28;--text:#e7ebf3;--muted:#9aa3b5;--line:#2a3140;--accent:#5b8cff;
--ok:#4cc38a;--ok-bg:#163126;--warn:#f0a94b;--warn-bg:#33270f;--err:#ff6b74;--err-bg:#3a1a1e;--chip:#222a38}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--text);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{width:100%;max-width:560px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px;box-shadow:0 12px 40px rgba(15,23,42,.08)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.logo{width:40px;height:40px;border-radius:10px;background:var(--accent);color:var(--accent-text);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px}
.brand b{display:block;font-size:16px}.brand small{color:var(--muted);font-size:12px}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
.status{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;margin-bottom:12px}
.status.ok{color:var(--ok);background:var(--ok-bg)}.status.warn{color:var(--warn);background:var(--warn-bg)}.status.err{color:var(--err);background:var(--err-bg)}
ol{list-style:none;counter-reset:step;padding:0;margin:0 0 20px}
ol>li{counter-increment:step;position:relative;padding:0 0 14px 40px}
ol>li::before{content:counter(step);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:var(--chip);color:var(--accent);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
ol>li>b{display:block}ol>li>span{color:var(--muted);font-size:14px}
ul.perms{list-style:none;padding:0;margin:8px 0 0;border:1px solid var(--line);border-radius:12px;overflow:hidden}
ul.perms li{display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--line)}ul.perms li:first-child{border-top:0}
ul.perms .name{flex:1}ul.perms .name b{display:block;font-size:14px}ul.perms .name span{color:var(--muted);font-size:13px}
code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--chip);padding:2px 6px;border-radius:6px;color:var(--muted)}
.tag{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
.tag.need{color:var(--err);background:var(--err-bg)}.tag.opt{color:var(--muted);background:var(--chip)}
.button{display:block;text-align:center;background:var(--accent);color:var(--accent-text);text-decoration:none;font-weight:600;padding:12px 16px;border-radius:10px;margin-top:8px}
.button:hover{filter:brightness(1.08)}
.note{font-size:13px;color:var(--muted);margin:16px 0 0;padding-top:16px;border-top:1px solid var(--line)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escape(title)} · ${escape(about.name)}</title><style>${style}</style></head><body><main>`
    + `<div class="brand"><div class="logo">P</div><div><b>${escape(about.name)}</b><small>v${escape(about.version)} · 本地授权入口</small></div></div>`
    + `${body}</main></body></html>`;
}
const permissionList = (permissions: readonly Permission[]) => `<ul class="perms">${permissions.map(permission =>
  `<li><div class="name"><b>${escape(permission.label)} <code>${escape(permission.scope)}</code></b><span>${escape(permission.use)}</span></div>`
  + `<span class="tag ${permission.required ? "need" : "opt"}">${permission.required ? "必须勾选" : "建议勾选"}</span></li>`).join("")}</ul>`;

export function landingPage(authorize: string): string {
  return page("登录", `<h1>登录 PikPak</h1><p>在 PikPak 官方页面登录并授权本工具。密码只在官方页面输入，不会交给本地程序。</p>
<ol><li><b>前往官方页面登录</b><span>点击下方按钮，在 PikPak 官方页面登录你的账号。</span></li>
<li><b>勾选全部权限</b><span>授权页会逐项列出应用权限，请全部勾选。缺少必须的权限时需要重新授权。</span>${permissionList(PERMISSIONS)}</li>
<li><b>自动返回</b><span>授权完成后页面会回到本机，并核对账号与权限。</span></li></ol>
<a class="button" href="${escape(authorize)}">前往 PikPak 登录与授权</a>
<p class="note">此页面由本机终端中的程序提供，只在本次登录期间可用。</p>`);
}
export function successPage(): string {
  return page("登录完成", `<span class="status ok">✓ 已完成</span><h1>登录完成</h1><p>账号身份与授权权限已核对。现在可以关闭此页面，回到终端继续。</p>`);
}
export function insufficientPage(missing: readonly Permission[], authorize: string): string {
  return page("权限不足", `<span class="status warn">! 权限不足</span><h1>授权缺少必须的权限</h1>
<p>这次授权没有保存。请重新授权，并在授权页勾选下列权限：</p>${permissionList(missing)}
<a class="button" href="${escape(authorize)}">重新授权</a>
<p class="note">终端仍在等待授权；不想继续时可在终端取消。</p>`);
}
export function failurePage(message: string): string {
  return page("授权未完成", `<span class="status err">✗ 未完成</span><h1>授权未完成</h1><p>${escape(message)}</p>`);
}

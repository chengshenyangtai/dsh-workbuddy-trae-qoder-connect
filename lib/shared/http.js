/**
 * 宿主侧 HTTP 小工具 —— 面板与三个渠道共用的**唯一一份**实现。
 *
 * 为什么要有这个文件：回环守卫（`loopbackRequest` 那一组）与 `writeJson` 曾经在
 * **四个文件里各有一份逐字相同的副本**（panel + workbuddy + trae + qoder）。
 * 这种重复在安全相关代码上尤其危险 —— 改一处漏三处等于留后门，而且没人会去核对
 * 四份是否还一致。现在只有这一份。
 *
 * 四份原实现里有两处细节差异，这里取**并集里更严的**：
 *   - 空/缺失 Host：原 panel/qoder 靠 `String(host ?? "")` 得到 `""` 再判不在白名单，
 *     结果是 false；这里显式提前返回 false（行为相同，意图更清楚）。
 *   - 端口剥离：原 panel/qoder 用 `replace(/:\d+$/, "")`，workbuddy 额外要求端口是纯数字、
 *     且 IPv6 无方括号时不去尾。这里采用后者的写法（对 `localhost:abc` 这类畸形值更稳）。
 *   - 白名单补上无方括号的 `::1`：它同样是回环地址，之前只有 `[::1]` 能过 —— 是个缺口。
 *
 * `readBody` **故意没有放进来**：三个渠道那份返回 `Buffer`（要自己 parse），
 * 面板那份返回 `string` 且带 64KB 上限 —— 契约不同，强行合并会改变语义。
 */

/** 回环主机名白名单（IPv6 两种写法都收）。 */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Host 头里的主机名：去端口、去大小写、IPv6 方括号保留。
 *
 * `[::1]:3088` → `[::1]`；`127.0.0.1:3088` → `127.0.0.1`；
 * `localhost:abc` → 原样（端口必须是纯数字才剥，否则不猜）。
 */
export function hostnameOfHost(host) {
  const text = String(host ?? "").trim().toLowerCase();
  if (text === "") return "";
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end === -1 ? text : text.slice(0, end + 1);
  }
  const colon = text.lastIndexOf(":");
  if (colon === -1) return text;
  // 冒号前还有冒号 = 无方括号的 IPv6，别把最后一段当端口剥掉。
  if (text.slice(0, colon).includes(":")) return text;
  return /^\d+$/.test(text.slice(colon + 1)) ? text.slice(0, colon) : text;
}

/** Host 头是不是回环地址。空/缺失一律 false。 */
export function hostIsLoopback(host) {
  if (host === undefined || host === null || String(host).trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}

/**
 * Origin 是回环吗。
 *
 * **缺失即放行**：宿主进程内的 fetch 不带 Origin，而浏览器页面一定带 ——
 * 所以这条规则挡住的是 DNS rebinding/第三方页面，不影响自己人。
 */
export function originIsLoopback(origin) {
  if (origin === undefined || origin === null || String(origin).trim() === "") return true;
  try {
    const { hostname } = new URL(String(origin));
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/** 两条一起判：这是"可以信任的本地调用"吗。所有 /plugins/* 路由都用它。 */
export function loopbackRequest(req) {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}

/**
 * 从 Host 头得出"回环基址"（`http://127.0.0.1:<port>`），拿不到端口就 undefined。
 *
 * 为什么需要它：面板把状态/签到**扇出**给各渠道自己的 `/plugins/*` 路由，扇出必须
 * 打回**本进程正在监听的端口**。原实现只认 `DSH_PORT`、缺省写死 3079 —— 那是
 * compose 部署的形状（容器里 compose 钉死了 3079）。桌面宿主（`dsh web --port <n>`）
 * 既不设 `DSH_PORT`、端口也不是 3079，于是每一次扇出都打在无人监听的 3079 上，
 * 面板表现为**所有渠道齐刷刷 `fetch failed`**，而各渠道自己的路由其实完全健康
 * （直接 curl 那些路由是 200 signed-in）。凭据、上游、签到逻辑全都没问题，坏的
 * 只是这台"听诊器"接错了管子。
 *
 * 取 Host 而不是环境变量：**进来的那个请求本来就带着正确的 Host**，它是同源的
 * 事实来源，也不受"宿主是否把端口导出成环境变量"影响。非回环或畸形 Host 一律
 * 返回 undefined，调用方再回退到环境变量 —— 这条路径绝不能凭外部输入猜目标地址。
 */
export function loopbackBaseFrom(host) {
  if (!hostIsLoopback(host)) return undefined;
  const text = String(host).trim();
  // `[::1]:3088` / `127.0.0.1:3088` / `localhost:3088` —— 端口取最后一个冒号之后。
  const colon = text.lastIndexOf(":");
  if (colon === -1) return undefined;
  const port = text.slice(colon + 1);
  if (!/^\d{1,5}$/.test(port)) return undefined;
  const value = Number(port);
  if (value < 1 || value > 65535) return undefined;
  return `http://127.0.0.1:${port}`;
}

/** 回一个 JSON 响应（带 Content-Length）。 */
export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** 错误信息截断：只读装饰/日志用，没必要把整个栈送出去。 */
export function briefMessage(error, limit = 300) {
  return (error instanceof Error ? error.message : String(error)).slice(0, limit);
}

/**
 * 同 `briefMessage`，但先把"看起来像凭据"的片段洗掉。
 *
 * 之所以保留两个函数而不是合成一个：WorkBuddy 那条 shim 会把**上游响应的原文**
 * 塞进 Error.message，再经 `/status` 送回浏览器 —— 那里面可能夹着 JWT 或
 * `?token=`。另外三处（panel / trae / qoder）的错误都是自己构造的短句，
 * 没有这个风险，也没必要为它们跑两趟正则。
 *
 * 洗法两条：JWT 形状的整串，以及 `code=` / `token=` / `refresh_token=` /
 * `access_token=` 这类查询参数的值。
 */
export function safeMessage(error, limit = 500) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]")
    .slice(0, limit);
}

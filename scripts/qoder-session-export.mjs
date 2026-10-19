#!/usr/bin/env node
/**
 * qoder-session-export.mjs —— 从 Qoder 桌面 App 的缓存里导出登录态，
 * 写成插件可读的会话凭据（国区 / 国际版各自独立）。
 *
 * 为什么需要它：插件只认 `$DSH_HOME/connect-auth/<区域>-session.json`
 * （`{token, refreshToken, expiresAt, uid, name, email}`）。上游仓库里这份会话由
 * `scripts/qoder-vault.mjs --install-session` 写出，但发布包里没有那个脚本；
 * 本脚本按同样原理补齐这一环，并同时支持两个区域。
 *
 * 两个区域是**两套完全独立的服务**，App 也是两个独立安装：
 *   国区   `%APPDATA%\com.qodercn.app.stable`  → connect-auth/qoder-session.json
 *   国际版 `%APPDATA%\com.qoder.app.stable`     → connect-auth/qoder-global-session.json
 *
 * App 的登录态落在 Electron userData 里：
 *   auth.v1.dat    Chromium os_crypt 信封
 *   Local State    os_crypt.encrypted_key（DPAPI 保护）
 *
 * 解密两步（都在本机、都用当前 Windows 用户身份，不碰钥匙串、不落明文密钥）：
 *   1. `encrypted_key` = "DPAPI" + 密文 → CryptUnprotectData（PowerShell ProtectedData）
 *      得 32 字节 AES key；
 *   2. `auth.v1.dat` = "v10" + 12 字节 nonce + AES-256-GCM(密文||tag)。
 *      ⚠️ 第 4 个字节是 **nonce 的第一个字节**，不是分隔符 —— 先按 3 字节前缀解，
 *      不行再试 4 字节（两个区域实测都是 3）。
 *
 * 用法：
 *   node scripts/qoder-session-export.mjs                 # 自动挑（国际版优先，其次国区）
 *   node scripts/qoder-session-export.mjs --region cn     # 只导国区
 *   node scripts/qoder-session-export.mjs --region global # 只导国际版
 *   node scripts/qoder-session-export.mjs --check         # 只体检，不写文件
 *   node scripts/qoder-session-export.mjs --user-data "C:\path\to\userData"
 *
 * 会话 token（`dt-` 前缀）由 App 自己续期；快到期时面板会显示未登录 ——
 * 在 App 里重新登录一次（或等它自动续），再跑一遍本脚本即可。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 区域表：userData 目录名 + 落盘文件名。
 * 与 `lib/providers/qoder/index.js` 的 QODER_REGIONS 一一对应（那边是消费侧）。
 */
const REGIONS = {
  cn: {
    id: "cn",
    label: "Qoder CN（国区）",
    userDataName: "com.qodercn.app.stable",
    sessionFile: "qoder-session.json",
  },
  global: {
    id: "global",
    label: "Qoder 国际版",
    userDataName: "com.qoder.app.stable",
    sessionFile: "qoder-global-session.json",
  },
};

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const userDataFlag = args.indexOf("--user-data");
const explicitUserData = userDataFlag !== -1 ? args[userDataFlag + 1] : undefined;
const regionFlag = args.indexOf("--region");
const wantedRegion = regionFlag !== -1 ? String(args[regionFlag + 1] ?? "").trim().toLowerCase() : "";

if (wantedRegion !== "" && !Object.hasOwn(REGIONS, wantedRegion)) {
  console.error(`用法错误：--region 只接受 cn / global（收到 "${wantedRegion}"）`);
  process.exit(2);
}

function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured === undefined || configured === "" ? join(homedir(), ".dsh") : configured;
}

/** App 的 userData 目录（Windows: %APPDATA%；其它平台按 Electron 惯例猜）。 */
function userDataOf(region) {
  if (typeof explicitUserData === "string" && explicitUserData.trim() !== "") return explicitUserData;
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(roaming, region.userDataName);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", region.userDataName);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), region.userDataName);
}

/**
 * 用 PowerShell + ProtectedData 解开 os_crypt 密钥（DPAPI，CurrentUser）。
 * 只把 base64 结果经 stdout 带回来，不写临时文件、不回显。
 */
function unprotectOsKey(localStatePath) {
  const ps = String.raw`
Add-Type -AssemblyName System.Security -ErrorAction Stop
$j = Get-Content -Raw -LiteralPath $env:QODERCN_LOCAL_STATE | ConvertFrom-Json
$enc = [Convert]::FromBase64String($j.os_crypt.encrypted_key)
if ($enc.Length -le 5) { throw "encrypted_key too short" }
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($enc[5..($enc.Length-1)], $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($key)
`;
  const r = spawnSync(process.platform === "win32" ? "pwsh" : "powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, QODERCN_LOCAL_STATE: localStatePath },
  });
  if (r.status !== 0 || !r.stdout?.trim()) {
    throw new Error(`解开 os_crypt 密钥失败${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
  }
  return Buffer.from(r.stdout.trim(), "base64");
}

/** 解 auth.v1.dat：先试 3 字节前缀（两个区域实测都对），再退 4 字节。 */
function decryptAuthFile(file, key) {
  const raw = readFileSync(file);
  for (const prefixLen of [3, 4]) {
    const nonce = raw.subarray(prefixLen, prefixLen + 12);
    const ct = raw.subarray(prefixLen + 12);
    if (ct.length <= 16) continue;
    try {
      const d = createDecipheriv("aes-256-gcm", key, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
      return JSON.parse(plain);
    } catch {
      /* 试下一个前缀长度 */
    }
  }
  throw new Error(`解密失败（${file}）：GCM 校验不通过 —— App 版本格式可能变了`);
}

/** 导出单个区域；返回 `{region, session, out?}`，不可用时返回 `{region, skipped}`。 */
function exportRegion(region) {
  const userData = userDataOf(region);
  const localState = join(userData, "Local State");
  const authFile = join(userData, "auth.v1.dat");
  if (!existsSync(localState) || !existsSync(authFile)) {
    return { region, skipped: `找不到 ${userData}（该区域 App 未安装或从未登录）` };
  }

  const key = unprotectOsKey(localState);
  if (key.length !== 32) throw new Error(`${region.label}: os_crypt 密钥长度异常 ${key.length}（期望 32）`);
  const doc = decryptAuthFile(authFile, key);

  const token = typeof doc?.token === "string" ? doc.token.trim() : "";
  if (!token.startsWith("dt-")) throw new Error(`${region.label}: auth.v1.dat 里的 token 不是 dt- 前缀（实际 ${token.slice(0, 3)}…）`);
  const uid = typeof doc?.user?.id === "string" ? doc.user.id.trim() : "";
  if (uid === "") throw new Error(`${region.label}: auth.v1.dat 里没有 user.id`);

  const session = {
    token,
    refreshToken: typeof doc?.refreshToken === "string" ? doc.refreshToken : "",
    expiresAt: typeof doc?.expiresAt === "string" ? doc.expiresAt : "",
    uid,
    name: typeof doc?.user?.name === "string" ? doc.user.name : "",
    email: typeof doc?.user?.email === "string" ? doc.user.email : "",
  };

  const outDir = join(resolveDshHome(), "connect-auth");
  const out = join(outDir, region.sessionFile);
  if (!checkOnly) {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(out, `${JSON.stringify(session, null, 1)}\n`, { mode: 0o600 });
  }
  return { region, session, out, raw: doc };
}

// ── main ──────────────────────────────────────────────────────────────────
const order = wantedRegion === "" ? ["global", "cn"] : [wantedRegion];
let written = 0;
for (const id of order) {
  const region = REGIONS[id];
  let result;
  try {
    result = exportRegion(region);
  } catch (error) {
    console.log(`\n== ${region.label} ==\n  ✗ ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (result.skipped !== undefined) {
    console.log(`\n== ${region.label} ==\n  · ${result.skipped}`);
    continue;
  }
  const { session, out, raw } = result;
  console.log(`\n== ${region.label} ==`);
  console.log("  uid      :", session.uid);
  console.log("  账号     :", session.name || "(未知)", session.email ? `<${session.email}>` : "");
  console.log("  token    :", `${session.token.slice(0, 6)}…(len ${session.token.length})`);
  console.log("  到期     :", session.expiresAt || "(未知)", "| refresh:", raw?.refreshTokenExpiresAt ?? "-");
  if (session.expiresAt && Date.parse(session.expiresAt) < Date.now()) {
    console.log("  ⚠️ 会话已过期 —— 先在 Qoder 桌面 App 里重新登录，再重跑本脚本");
  }
  if (checkOnly) {
    console.log("  （--check：未写入）");
  } else {
    written += 1;
    console.log("  已写入 (0600):", out);
  }
}

console.log(
  checkOnly
    ? "\n--check：未写入任何文件。"
    : `\n完成：写入 ${written} 份会话凭据。插件按巡检周期重读凭据，不用重启 DSH。`,
);

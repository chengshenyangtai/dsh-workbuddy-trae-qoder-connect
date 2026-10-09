/**
 * 解析"当前装着的这份插件"的目录。
 *
 * 探针只关心**跑着的那份**,所以不写死目录名:改成按 profile 的依赖键找
 * ——包名改过一次(dsh-connect → dsh-workbuddy-trae-qoder-connect),写死的
 * 名字会让整批探针以 ENOENT 变红,而那看起来像"断言失败",实际只是路径没了。
 *
 * 判定用 `lib/providers/workbuddy/index.js` 这个组合,避免撞上其他插件的 lib/。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE = join(homedir(), ".dsh", "profiles", "desktop");

/** @returns {string} 插件包根目录(绝对路径) */
export function installedPackageDir() {
	if (process.env.DSH_CONNECT_DIR) return join(PROFILE, "node_modules", process.env.DSH_CONNECT_DIR);
	const root = join(PROFILE, "node_modules");
	const marker = join("lib", "providers", "workbuddy", "index.js");
	try {
		const deps = JSON.parse(readFileSync(join(PROFILE, "package.json"), "utf8")).dependencies ?? {};
		for (const key of Object.keys(deps)) {
			if (key.includes("connect") && existsSync(join(root, key, marker))) return join(root, key);
		}
	} catch {
		/* profile 读不到就往下兜底 */
	}
	return join(root, "dsh-workbuddy-trae-qoder-connect");
}

/** @returns {string} 插件 lib/ 目录(绝对路径) */
export function installedLibDir() {
	return join(installedPackageDir(), "lib");
}

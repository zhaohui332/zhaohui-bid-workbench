const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = __dirname;
const NODE_MODULES = "/Users/lijunjie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
let marked = null;

const PORT_START = Number(process.env.PORT || 8317);
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const PUBLIC_TOKEN = process.env.PUBLIC_TOKEN || "";
const PUBLIC_COOKIE = "bid_public_token";

const DIRS = [
  { key: "historical", label: "历史标书", dir: "01_历史标书" },
  { key: "profile", label: "企业档案", dir: "02_企业档案" },
  { key: "materials", label: "标书素材库", dir: "03_标书素材库" },
  { key: "tender", label: "招标文件", dir: "04_招标文件" },
  { key: "output", label: "新建标书", dir: "05_新建标书" },
  { key: "records", label: "投标记录", dir: "06_投标记录" },
  { key: "spec", label: "标书规范", dir: "07_标书规范" },
];

const UPLOAD_DIRS = {
  historical: "01_历史标书",
  profile: "02_企业档案",
  materials: "03_标书素材库",
  tender: "04_招标文件",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".rar": "application/x-rar-compressed",
};

function requestToken(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  const queryToken = url.searchParams.get("token") || url.searchParams.get("key");
  if (queryToken) return queryToken;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === PUBLIC_COOKIE) return rest.join("=");
  }
  return "";
}

function hasValidPublicToken(req) {
  if (!PUBLIC_TOKEN) return true;
  return requestToken(req) === PUBLIC_TOKEN;
}

function setPublicTokenCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${PUBLIC_COOKIE}=${PUBLIC_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
  );
}

function loginPage(error) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 标书工作台</title>
<style>
body{margin:0;background:#f3f5f6;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#17212b;display:grid;place-items:center;min-height:100vh}
.box{background:#fff;border:1px solid #dde3e8;border-radius:8px;width:min(360px,90vw);padding:26px}
h1{font-size:18px;margin:0 0 4px}
p{color:#66737f;margin:6px 0 18px;font-size:13px}
input{width:100%;box-sizing:border-box;border:1px solid #dde3e8;border-radius:7px;padding:10px 12px;margin-bottom:12px}
button{width:100%;border:0;background:#0d6b5c;color:#fff;border-radius:7px;padding:10px;font-weight:700;cursor:pointer}
.err{color:#a33a3a;font-size:12px;margin:-4px 0 12px}
</style></head><body>
<form class="box" method="post" action="/login">
<h1>江苏兆辉 · 标书智能工作台</h1>
<p>请输入访问口令</p>
${error ? `<div class="err">口令不正确</div>` : ""}
<input type="password" name="password" placeholder="访问口令" autofocus>
<button type="submit">进入工作台</button>
</form>
</body></html>`;
}

async function handleLogin(req, res) {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(loginPage(""));
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65536) {
      sendJson(res, 413, { ok: false, error: "请求过大" });
      return;
    }
  }
  const params = new URLSearchParams(body);
  if (params.get("password") === PUBLIC_TOKEN) {
    setPublicTokenCookie(res);
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(loginPage("error"));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function safeRelative(rel) {
  if (!rel || rel.includes("\0") || rel.includes("..")) return false;
  const full = path.join(ROOT, rel);
  return full.startsWith(ROOT) && fs.existsSync(full);
}

function fileHref(rel) {
  return "/" + rel.split("/").map(encodeURIComponent).join("/");
}

function collectFiles(relDir) {
  const fullDir = path.join(ROOT, relDir);
  if (!fs.existsSync(fullDir)) return [];
  const out = [];
  const walk = (current, rel) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childFull = path.join(current, entry.name);
      const childRel = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childFull, childRel);
      } else {
        const stat = fs.statSync(childFull);
        out.push({
          kind: "file",
          name: entry.name,
          rel: childRel,
          ext: path.extname(entry.name).slice(1).toLowerCase(),
          size: stat.size,
          mtime: stat.mtimeMs,
          url: fileHref(childRel),
        });
      }
    }
  };
  walk(fullDir, relDir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

function collectDirs(relDir) {
  const fullDir = path.join(ROOT, relDir);
  if (!fs.existsSync(fullDir)) return [];
  return fs
    .readdirSync(fullDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function dirState(dirDef) {
  const files = collectFiles(dirDef.dir);
  const folders = collectDirs(dirDef.dir);
  const mdCount = files.filter((f) => f.ext === "md").length;
  const docCount = files.filter((f) => ["doc", "docx"].includes(f.ext)).length;
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  return {
    key: dirDef.key,
    label: dirDef.label,
    dir: dirDef.dir,
    count: files.length,
    folders,
    files: files.slice(0, 400),
    mdCount,
    docCount,
    totalSize,
    lastModified: files.length ? files[0].mtime : null,
  };
}

function handleState(req, res) {
  const dirs = DIRS.map(dirState);
  sendJson(res, 200, { root: ROOT, dirs });
}

function handleMarkdown(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const rel = (url.searchParams.get("path") || "").replace(/^\/+/, "");
  if (!safeRelative(rel) || !rel.endsWith(".md")) {
    sendJson(res, 400, { ok: false, error: "只能读取工作区内的 Markdown 文件" });
    return;
  }
  const full = path.join(ROOT, rel);
  if (!fs.statSync(full).isFile()) {
    sendJson(res, 404, { ok: false, error: "文件不存在" });
    return;
  }
  let raw = fs.readFileSync(full, "utf8");
  raw = raw
    .replace(/^\s*[-*] \[ \]/gm, "- <input type=\"checkbox\" class=\"md-check\">")
    .replace(/^\s*[-*] \[[xX]\]/gm, "- <input type=\"checkbox\" class=\"md-check\" checked>");
  const html = marked.parse(raw, { gfm: true, breaks: false });
  sendJson(res, 200, { ok: true, path: rel, html });
}

function safeName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTarget(dirFull, name) {
  const parsed = path.parse(name);
  let candidate = path.join(dirFull, parsed.base);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dirFull, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function handleUpload(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const dirKey = url.searchParams.get("dir") || "";
  const rawName = url.searchParams.get("name") || "";
  const folder = safeName(url.searchParams.get("folder") || "");
  const targetDirRel = UPLOAD_DIRS[dirKey];
  if (!targetDirRel) {
    sendJson(res, 400, { ok: false, error: "目录不存在" });
    return;
  }
  const name = safeName(rawName);
  if (!name) {
    sendJson(res, 400, { ok: false, error: "缺少文件名" });
    return;
  }

  let dirFull = path.join(ROOT, targetDirRel);
  if (folder) {
    if (folder.includes("..")) {
      sendJson(res, 400, { ok: false, error: "非法文件夹名称" });
      return;
    }
    dirFull = path.join(dirFull, folder);
  }
  if (!dirFull.startsWith(path.join(ROOT, targetDirRel))) {
    sendJson(res, 400, { ok: false, error: "非法路径" });
    return;
  }
  fs.mkdirSync(dirFull, { recursive: true });
  const target = uniqueTarget(dirFull, name);

  const writeStream = fs.createWriteStream(target);
  let received = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.pipe(writeStream);
  writeStream.on("finish", () => {
    if (tooLarge) {
      fs.unlink(target, () => {});
      sendJson(res, 413, { ok: false, error: "文件超过 300MB" });
      return;
    }
    const rel = path.relative(ROOT, target).split(path.sep).join("/");
    sendJson(res, 200, {
      ok: true,
      file: { name: path.basename(target), rel, url: fileHref(rel), size: fs.statSync(target).size, mtime: fs.statSync(target).mtimeMs, ext: path.extname(target).slice(1) },
      folder,
    });
  });
  writeStream.on("error", (err) => {
    sendJson(res, 500, { ok: false, error: err.message });
  });
  req.on("error", (err) => {
    writeStream.destroy();
    fs.unlink(target, () => {});
    if (!tooLarge) sendJson(res, 500, { ok: false, error: err.message });
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { ok: false, error: "路径无法解析" });
    return;
  }

  let full;
  if (pathname === "/" || pathname === "/index.html") {
    full = path.join(ROOT, "index.html");
  } else if (pathname.startsWith("/vendor/")) {
    if (pathname === "/vendor/marked.min.js") {
      full = path.join(NODE_MODULES, "marked/lib/marked.umd.js");
    } else if (pathname === "/vendor/lucide.min.js") {
      full = path.join(NODE_MODULES, "lucide/dist/umd/lucide.min.js");
    } else {
      full = null;
    }
  } else {
    const rel = pathname.replace(/^\/+/, "");
    if (!rel || rel.includes("\0") || rel.split("/").includes("..")) {
      full = null;
    } else {
      full = path.join(ROOT, rel);
    }
  }

  const allowedRoot = full && full.startsWith(NODE_MODULES) && pathname.startsWith("/vendor/")
    ? NODE_MODULES
    : ROOT;
  if (!full || !full.startsWith(allowedRoot) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const download = [".pdf", ".doc", ".docx", ".xlsx", ".xls", ".pptx", ".zip", ".rar"].includes(ext);
  const headers = { "Content-Type": contentType, "Cache-Control": "no-cache" };
  if (download) {
    const filename = encodeURIComponent(path.basename(full));
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${filename}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer((req, res) => {
  if (PUBLIC_TOKEN) {
    const publicUrl = new URL(req.url, "http://127.0.0.1");
    if (publicUrl.pathname === "/login") {
      handleLogin(req, res).catch(() => sendJson(res, 500, { ok: false, error: "登录失败" }));
      return;
    }
    if (!hasValidPublicToken(req)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(loginPage(""));
      return;
    }
    if (publicUrl.searchParams.get("token") || publicUrl.searchParams.get("key")) {
      setPublicTokenCookie(res);
    }
  }
  const pathname = (new URL(req.url, "http://127.0.0.1")).pathname;
  if (pathname === "/api/state" && req.method === "GET") {
    handleState(req, res);
  } else if (pathname === "/api/md" && req.method === "GET") {
    handleMarkdown(req, res);
  } else if (pathname === "/api/upload" && req.method === "POST") {
    handleUpload(req, res);
  } else if (req.method === "GET") {
    serveStatic(req, res);
  } else {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }
});

async function start() {
  const markedModule = await import(
    pathToFileURL(path.join(NODE_MODULES, "marked/lib/marked.esm.js")).href
  );
  marked = markedModule.marked;

  let port = PORT_START;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < PORT_START + 20) {
      port += 1;
      server.listen(port, "127.0.0.1");
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`标书工作台已启动：http://127.0.0.1:${port}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

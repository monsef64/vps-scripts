const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const requestedFolder = process.argv[2];

if (!requestedFolder) {
  console.error("Usage: node start-svx.js /path/to/folder");
  process.exit(1);
}

let root;
try {
  root = fs.realpathSync(requestedFolder);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error("Not a directory");
  }
} catch {
  console.error(`Folder does not exist or is not a directory: ${requestedFolder}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 8000);

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);

const formatSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const makeHref = (segments, isDir = false) =>
  "/" + segments.map(encodeURIComponent).join("/") +
  (isDir && segments.length ? "/" : "");

function resolveSafe(segments) {
  let current = root;

  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    const stat = fs.lstatSync(current);

    // Do not serve symlinks.
    if (stat.isSymbolicLink()) throw new Error("Symlinks are not served");

    if (i < segments.length - 1 && !stat.isDirectory()) {
      throw new Error("Not a directory");
    }
  }

  return current;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }

  let segments;

  try {
    segments = new URL(req.url, "http://localhost").pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);

    if (segments.some((s) =>
      !s || s === "." || s === ".." || s.includes("/") || s.includes("\\")
    )) {
      throw new Error("Invalid path");
    }
  } catch {
    res.writeHead(400).end("Invalid path");
    return;
  }

  let target;
  let stat;

  try {
    target = resolveSafe(segments);
    stat = fs.lstatSync(target);
  } catch {
    res.writeHead(404).end("Not found");
    return;
  }

  // File download, including support for pausing/resuming via Range requests.
  if (stat.isFile()) {
    const size = stat.size;
    let start = 0;
    let end = size - 1;
    let status = 200;

    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);

      if (!match || size === 0) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }

      if (match[1] === "") {
        const suffixLength = Number(match[2]);

        if (!suffixLength) {
          res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
          return;
        }

        start = Math.max(size - suffixLength, 0);
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      }

      end = Math.min(end, size - 1);

      if (start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }

      status = 206;
    }

    const filename = encodeURIComponent(path.basename(target))
      .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Content-Length": status === 206 ? end - start + 1 : size,
      "X-Content-Type-Options": "nosniff"
    };

    if (status === 206) {
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }

    res.writeHead(status, headers);

    if (req.method === "HEAD" || size === 0) {
      res.end();
    } else {
      fs.createReadStream(
        target,
        status === 206 ? { start, end } : {}
      ).pipe(res);
    }

    return;
  }

  if (!stat.isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }

  let entries;

  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => {
        const childPath = path.join(target, entry.name);
        const childStat = fs.lstatSync(childPath);
        const childSegments = [...segments, entry.name];

        return {
          name: entry.name,
          isDir: childStat.isDirectory(),
          size: childStat.isFile() ? childStat.size : null,
          href: makeHref(childSegments, childStat.isDirectory())
        };
      })
      .sort((a, b) =>
        Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
      );
  } catch {
    res.writeHead(500).end("Could not read folder");
    return;
  }

  const parentHref = makeHref(segments.slice(0, -1), true);

  const rows = entries.map((entry) => `
    <a class="file" href="${escapeHtml(entry.href)}">
      <span class="icon">${entry.isDir ? "📁" : "↓"}</span>
      <span class="name">${escapeHtml(entry.name)}${entry.isDir ? "/" : ""}</span>
      <span class="size">${entry.isDir ? "Folder" : formatSize(entry.size)}</span>
    </a>
  `).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>File downloads</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 20px;
    background: #0b1020;
    color: #edf2ff;
    font: 16px system-ui, sans-serif;
  }
  main { max-width: 760px; margin: auto; }
  h1 { margin-bottom: 8px; font-size: 2rem; }
  .sub {
    color: #9aa8c7;
    margin: 0 0 24px;
    overflow-wrap: anywhere;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px;
    margin: 10px 0;
    border: 1px solid #26324e;
    border-radius: 12px;
    background: #131b30;
    color: inherit;
    text-decoration: none;
  }
  .file:hover { border-color: #7c9cff; background: #192440; }
  .icon { width: 38px; text-align: center; font-size: 22px; }
  .name { flex: 1; overflow-wrap: anywhere; }
  .size { color: #9aa8c7; font-size: 14px; white-space: nowrap; }
  .empty { color: #9aa8c7; padding: 20px 0; }
</style>
</head>
<body>
<main>
  <h1>File downloads</h1>
  <p class="sub">/${escapeHtml(segments.join("/"))}</p>
  ${segments.length
    ? `<a class="file" href="${escapeHtml(parentHref)}">
         <span class="icon">⬆</span><span class="name">Up one folder</span>
       </a>`
    : ""}
  ${rows || '<p class="empty">This folder is empty.</p>'}
</main>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(req.method === "HEAD" ? undefined : html);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Serving ${root} on port ${port}`);
});

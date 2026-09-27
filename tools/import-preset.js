import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";

const app = new Hono();
app.use("/api/*", cors());

const FIREBASE_BASE = "https://firebasestorage.googleapis.com/v0/b/alight-creative.appspot.com/o";
const USER_AGENT = "AlightMotion/6.2.53 (iOS; gzip)";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.join(__dirname, "dist", "index.html");
const packageCacheDir = path.join(__dirname, ".package-cache");
const execFileAsync = promisify(execFile);
mkdirSync(packageCacheDir, { recursive: true });

type PackageEntry = {
  name: string;
  size: number;
  xml: boolean;
  media: boolean;
  mime: string;
};

type PackageData = {
  files: Map<string, { blob: Uint8Array; mime: string }>;
  xmls: { name: string; text: string }[];
  list: PackageEntry[];
  meta: { title: string; description: string; thumb: string };
  fetchedAt: number;
};

const packages = new Map<string, PackageData>();

function cacheFile(pkg: string): string {
  return path.join(packageCacheDir, `${pkg}.zip`);
}

function cacheMetaFile(pkg: string): string {
  return path.join(packageCacheDir, `${pkg}.json`);
}

async function buildPackage(zipBuf: Uint8Array, meta: { title: string; description: string; thumb: string }, fetchedAt: number): Promise<PackageData> {
  const zip = await JSZip.loadAsync(zipBuf);
  const files = new Map<string, { blob: Uint8Array; mime: string }>();
  const xmls: { name: string; text: string }[] = [];
  const list: PackageEntry[] = [];
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const data = new Uint8Array(await entry.async("uint8array"));
    const mime = mimeOf(name);
    files.set(name, { blob: data, mime });
    list.push({
      name,
      size: data.length,
      xml: mime === "application/xml",
      media: mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/"),
      mime,
    });
    if (mime === "application/xml") xmls.push({ name, text: await entry.async("string") });
  }
  return { files, xmls, list, meta, fetchedAt };
}

function persistPackage(pkg: string, zipBuf: Uint8Array, meta: { title: string; description: string; thumb: string }, fetchedAt: number) {
  writeFileSync(cacheFile(pkg), zipBuf);
  writeFileSync(cacheMetaFile(pkg), JSON.stringify({ meta, fetchedAt }));
}

async function loadCachedPackage(pkg: string): Promise<PackageData | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(pkg) || !existsSync(cacheFile(pkg))) return null;
  try {
    const metaFile = cacheMetaFile(pkg);
    const saved = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    const meta = saved.meta || { title: "", description: "", thumb: "" };
    const data = await buildPackage(readFileSync(cacheFile(pkg)), meta, Number(saved.fetchedAt) || Date.now());
    packages.set(pkg, data);
    return data;
  } catch {
    return null;
  }
}

async function getPackage(pkg: string): Promise<PackageData | null> {
  return packages.get(pkg) || loadCachedPackage(pkg);
}


function parseShareLink(link: string): { user: string; pkg: string } | null {
  const m = link.match(
    /(?:alightcreative\.com|alight\.link)\/am\/share\/u\/([A-Za-z0-9_-]+)\/p\/([A-Za-z0-9_\-]+)/i
  );
  return m ? { user: m[1], pkg: m[2] } : null;
}

async function fetchShareMeta(link: string) {
  try {
    const html = await (await fetch(link, { headers: { "User-Agent": USER_AGENT } })).text();
    const title = html.match(/<h1>([^<]+)<\/h1>/)?.[1] ?? "";
    const description = html.match(/property="og:description" content="([^"]+)"/)?.[1] ?? "";
    const thumb = html.match(/property="og:image" content="([^"]+)"/)?.[1] ?? "";
    const projects = [...html.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
    return { title, description, thumb, projects };
  } catch {
    return { title: "", description: "", thumb: "", projects: [] as string[] };
  }
}

async function downloadZip(user: string, pkg: string): Promise<Uint8Array | null> {
  const names = ["projectfiles.zip", "projectFiles.zip", "package.zip", "project.zip"];
  for (const name of names) {
    const url = `${FIREBASE_BASE}/share%2Fu%2F${user}%2Fp%2F${pkg}%2F${name}?alt=media`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
      });
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > 0) return buf;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function mimeOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

app.post("/api/link", async (c) => {
  const body = await c.req.parseBody().catch(() => null);
  const raw = body ? ((body as Record<string, unknown>).link as string) : null;
  const link = raw || (await c.req.json().catch(() => null))?.link;
  if (!link) return c.json({ error: "link required" }, 400);
  const parsed = parseShareLink(link);
  if (!parsed) return c.json({ error: "invalid Alight Motion share link" }, 400);

  const cacheKey = parsed.pkg;
  const existing = await getPackage(cacheKey);
  if (existing && Date.now() - existing.fetchedAt < 1000 * 60 * 30) {
    return c.json({
      packageId: parsed.pkg,
      meta: { ...existing.meta, projects: existing.xmls.map((x) => x.name) },
      projects: existing.xmls.map((x) => ({ name: x.name, size: x.text.length })),
      files: existing.list,
      cached: true,
    });
  }

  const zipBuf = await downloadZip(parsed.user, parsed.pkg);
  if (!zipBuf) {
    if (existing) {
      return c.json({
        packageId: parsed.pkg,
        meta: { ...existing.meta, projects: existing.xmls.map((x) => x.name) },
        projects: existing.xmls.map((x) => ({ name: x.name, size: x.text.length })),
        files: existing.list,
        cached: true,
      });
    }
    return c.json({ error: "package not found / expired" }, 404);
  }

  const meta = await fetchShareMeta(link);
  const fetchedAt = Date.now();
  const data = await buildPackage(zipBuf, { title: meta.title, description: meta.description, thumb: meta.thumb }, fetchedAt);
  packages.set(cacheKey, data);
  try { persistPackage(cacheKey, zipBuf, data.meta, fetchedAt); } catch {}
  return c.json({
    packageId: parsed.pkg,
    meta: { ...meta, projects: data.xmls.map((x) => x.name) },
    projects: data.xmls.map((x) => ({ name: x.name, size: x.text.length })),
    files: data.list,
    cached: false,
  });
});

app.get("/api/link/:packageId/xml/:name", async (c) => {
  const pkg = await getPackage(c.req.param("packageId"));
  if (!pkg) return c.json({ error: "package not loaded, POST /api/link first" }, 404);
  const name = decodeURIComponent(c.req.param("name"));
  const xml = pkg.xmls.find((x) => x.name === name);
  if (!xml) return c.json({ error: "xml not found" }, 404);
  return c.text(xml.text, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "no-cache",
  });
});

app.get("/api/link/:packageId/media/:name", async (c) => {
  const pkg = await getPackage(c.req.param("packageId"));
  if (!pkg) return c.json({ error: "package not loaded, POST /api/link first" }, 404);
  const name = decodeURIComponent(c.req.param("name"));
  const file = pkg.files.get(name);
  if (!file) return c.json({ error: "file not found" }, 404);
  const buf = file.blob.buffer.slice(
    file.blob.byteOffset,
    file.blob.byteOffset + file.blob.byteLength
  );
  const range = c.req.header("range");
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
      if (start >= buf.byteLength || start > end) {
        return c.body(null, 416, { "Content-Range": `bytes */${buf.byteLength}` });
      }
      const chunk = buf.slice(start, end + 1);
      return c.body(chunk as ArrayBuffer, 206, {
        "Content-Type": file.mime,
        "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
        "Content-Length": String(chunk.byteLength),
        "Accept-Ranges": "bytes",
      });
    }
  }
  return c.body(buf as ArrayBuffer, 200, {
    "Content-Type": file.mime,
    "Cache-Control": "public, max-age=86400",
    "Accept-Ranges": "bytes",
  });
});

app.post("/api/export/mp4", async (c) => {
  let input: Buffer;
  try {
    input = Buffer.from(await c.req.arrayBuffer());
  } catch {
    return c.json({ error: "video body required" }, 400);
  }
  if (!input.length) return c.json({ error: "video body required" }, 400);

  const dir = path.join(tmpdir(), `amweb-export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const source = path.join(dir, "input.webm");
  const output = path.join(dir, "output.mp4");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(source, input);
    await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-i",
      source,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      output,
    ], { maxBuffer: 1024 * 1024 * 32 });
    const mp4 = readFileSync(output);
    return c.body(new Uint8Array(mp4), 200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(mp4.byteLength),
      "Content-Disposition": "attachment; filename=alight-motion-export.mp4",
      "Cache-Control": "no-store",
    });
  } catch {
    return c.json({ error: "MP4 conversion failed. Install a working ffmpeg binary on the server." }, 500);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

app.get("/api/health", (c) => c.json({ ok: true }));

// serve built frontend (dist/) single port for API + web
app.get("/", (c) => c.body(readFileSync(distIndex, "utf-8"), 200, { "Content-Type": "text/html; charset=utf-8" }));
app.use("/*", serveStatic({ root: "./dist" }));

const port = Number(process.env.PORT ?? 3000);
console.log(`[server] listening on http://0.0.0.0:${port}`);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
/* ===========================================================================
   文件类型图标（2026-10-20）
   ---------------------------------------------------------------------------
   用户 2026-10-20 的第 4 条：文件模块"呈现不好、质感低、UI 比较丑"。
   这一份只做一件事 —— 把 Orca 的文件探索器那套"按类型取图标"搬过来：
     · 后缀表、文件名表、复合后缀（tar.gz 等）的选择规则；
     · 目录的 folder / folder-open 两态。
   图标**一枚都没有自己画**：path 逐字取自 lucide 0.577.0（与 Orca 依赖的
   lucide-react 0.577 同版本），`FileJson` / `FileVideo` 在 0.577 里已经是
   `FileBraces` / `FilePlay` 的别名 —— Orca 的 import 写的是旧名，实际渲染
   的就是这两枚，这里照实际渲染的那一枚搬。

   许可：
     · 映射表与选择规则搬自 Orca（MIT License, Copyright (c) 2026 Lovecast Inc.）
       src/renderer/src/lib/file-type-icons.ts
       src/renderer/src/lib/file-type-icon-extension-table.ts
       src/renderer/src/lib/file-type-icon-name-table.ts
       全文见 licenses/MIT-Orca.txt
     · 图标 path 来自 Lucide（ISC License, Copyright (c) 2026 Lucide Icons
       and Contributors；含 Feather 派生部分，MIT, Copyright (c) 2013-present
       Cole Bemis）。全文见 licenses/ISC-lucide.txt
   =========================================================================== */

const FILE_ICON_PATHS = {
  "database": '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  "file": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
  "file-archive": '<path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/><circle cx="8" cy="20" r="2"/>',
  "file-axis-3d": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m8 18 4-4"/><path d="M8 10v8h8"/>',
  "file-box": '<path d="M14.5 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v3.8"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M11.7 14.2 7 17l-4.7-2.8"/><path d="M3 13.1a2 2 0 0 0-.999 1.76v3.24a2 2 0 0 0 .969 1.78L6 21.7a2 2 0 0 0 2.03.01L11 19.9a2 2 0 0 0 1-1.76V14.9a2 2 0 0 0-.97-1.78L8 11.3a2 2 0 0 0-2.03-.01z"/><path d="M7 17v5"/>',
  "file-braces": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>',
  "file-chart-column": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 18v-1"/><path d="M12 18v-6"/><path d="M16 18v-3"/>',
  "file-code": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>',
  "file-cog": '<path d="M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z"/><path d="M20 8v12a2 2 0 0 1-2 2h-4.182"/><path d="m3.305 19.53.923-.382"/><path d="M4 10.592V4a2 2 0 0 1 2-2h8"/><path d="m4.228 16.852-.924-.383"/><path d="m5.852 15.228-.383-.923"/><path d="m5.852 20.772-.383.924"/><path d="m8.148 15.228.383-.923"/><path d="m8.53 21.696-.382-.924"/><path d="m9.773 16.852.922-.383"/><path d="m9.773 19.148.922.383"/><circle cx="7" cy="18" r="3"/>',
  "file-diff": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
  "file-image": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><circle cx="10" cy="12" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>',
  "file-key": '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M4 12v6"/><path d="M4 14h2"/><path d="M9.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v4"/><circle cx="4" cy="20" r="2"/>',
  "file-lock": '<path d="M4 9.8V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M9 17v-2a2 2 0 0 0-4 0v2"/><rect width="8" height="5" x="3" y="17" rx="1"/>',
  "file-music": '<path d="M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 20v-7l3 1.474"/><circle cx="6" cy="20" r="2"/>',
  "file-play": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z"/>',
  "file-sliders": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12h8"/><path d="M10 11v2"/><path d="M8 17h8"/><path d="M14 16v2"/>',
  "file-spreadsheet": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
  "file-terminal": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m8 16 2-2-2-2"/><path d="M12 18h4"/>',
  "file-text": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  "file-type": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M11 18h2"/><path d="M12 12v6"/><path d="M9 13v-.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v.5"/>',
  "folder": '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  "folder-open": '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
};

const FILE_ICON_BY_EXTENSION = {
  "7z": "file-archive", aac: "file-music", adoc: "file-text", ai: "file-image",
  asc: "file-key", astro: "file-code", avi: "file-play", avif: "file-image",
  bash: "file-terminal", bat: "file-terminal", blend: "file-axis-3d",
  bmp: "file-image", br: "file-archive", bz2: "file-archive", c: "file-code",
  cc: "file-code", cer: "file-key", cfg: "file-sliders", cjs: "file-code",
  clj: "file-code", cmd: "file-terminal", conf: "file-sliders", cpp: "file-code",
  crt: "file-key", cs: "file-code", css: "file-type", csv: "file-spreadsheet",
  cts: "file-code", cxx: "file-code", dart: "file-code", db: "database",
  diff: "file-diff", dmg: "file-archive", doc: "file-text", docx: "file-text",
  duckdb: "database", eot: "file-type", eps: "file-image", erl: "file-code",
  ex: "file-code", exs: "file-code", fbx: "file-axis-3d", fish: "file-terminal",
  flac: "file-music", fs: "file-code", fsx: "file-code", gif: "file-image",
  glb: "file-axis-3d", gltf: "file-axis-3d", go: "file-code", gpg: "file-key",
  gql: "file-braces", gradle: "file-cog", graphql: "file-braces",
  gz: "file-archive", h: "file-code", hcl: "file-sliders", heic: "file-image",
  hpp: "file-code", hrl: "file-code", hs: "file-code", htm: "file-code",
  html: "file-code", ico: "file-image", ini: "file-sliders",
  ipynb: "file-chart-column", iso: "file-archive", java: "file-code",
  jpeg: "file-image", jpg: "file-image", js: "file-code", json: "file-braces",
  json5: "file-braces", jsonc: "file-braces", jsx: "file-code", key: "file-key",
  kt: "file-code", kts: "file-code", less: "file-type", lock: "file-lock",
  log: "file-text", lua: "file-code", m4a: "file-music", m4v: "file-play",
  md: "file-text", mdx: "file-text", mjs: "file-code", mkv: "file-play",
  mmd: "file-chart-column", mov: "file-play", mp3: "file-music",
  mp4: "file-play", mpeg: "file-play", mpg: "file-play", mts: "file-code",
  nim: "file-code", nu: "file-terminal", obj: "file-axis-3d",
  ods: "file-spreadsheet", ogg: "file-music", opus: "file-music",
  otf: "file-type", p12: "file-lock", patch: "file-diff", pdf: "file-text",
  pem: "file-key", pfx: "file-lock", php: "file-code", pl: "file-code",
  pm: "file-code", png: "file-image", ppt: "file-chart-column",
  pptx: "file-chart-column", prisma: "database", properties: "file-sliders",
  proto: "file-braces", ps1: "file-terminal", psd: "file-image",
  pub: "file-key", py: "file-code", qmd: "file-text", r: "file-code",
  rar: "file-archive", rb: "file-code", rmarkdown: "file-text",
  rmd: "file-text", rst: "file-text", rs: "file-code", rtf: "file-text",
  sass: "file-type", scala: "file-code", scss: "file-type", sh: "file-terminal",
  sol: "file-code", sqlite: "database", sqlite3: "database", sql: "database",
  stl: "file-axis-3d", svelte: "file-code", svg: "file-image",
  swift: "file-code", tar: "file-archive", "tar.bz2": "file-archive",
  "tar.gz": "file-archive", "tar.xz": "file-archive", tbz2: "file-archive",
  tex: "file-text", tf: "file-sliders", tfvars: "file-sliders",
  tgz: "file-archive", tif: "file-image", tiff: "file-image",
  toml: "file-sliders", ts: "file-code", tsx: "file-code",
  tsv: "file-spreadsheet", ttf: "file-type", txt: "file-text",
  txz: "file-archive", vb: "file-code", vue: "file-code", wav: "file-music",
  webm: "file-play", webp: "file-image", woff: "file-type",
  woff2: "file-type", xhtml: "file-code", xls: "file-spreadsheet",
  xlsx: "file-spreadsheet", xml: "file-code", xz: "file-archive",
  yaml: "file-sliders", yml: "file-sliders", zig: "file-code",
  zip: "file-archive", zsh: "file-terminal",
};

const FILE_ICON_BY_NAME = {
  ".babelrc": "file-sliders", ".dockerignore": "file-sliders",
  ".editorconfig": "file-sliders", ".eslintrc": "file-sliders",
  ".eslintrc.cjs": "file-sliders", ".eslintrc.js": "file-sliders",
  ".eslintrc.json": "file-braces", ".eslintrc.yaml": "file-sliders",
  ".eslintrc.yml": "file-sliders", ".gitattributes": "file-sliders",
  ".gitignore": "file-sliders", ".npmrc": "file-sliders",
  ".prettierrc": "file-sliders", ".prettierrc.json": "file-braces",
  ".prettierrc.yaml": "file-sliders", ".prettierrc.yml": "file-sliders",
  "agents.md": "file-text", authors: "file-text",
  "bun.lock": "file-box", "bun.lockb": "file-box",
  "cargo.lock": "file-box", "cargo.toml": "file-box",
  changelog: "file-text", "changelog.md": "file-text",
  "cmakelists.txt": "file-cog", codeowners: "file-key",
  "components.json": "file-sliders", "composer.json": "file-box",
  "composer.lock": "file-box", contributing: "file-text",
  "contributing.md": "file-text", copying: "file-key",
  dockerfile: "file-cog", gemfile: "file-box", "go.mod": "file-box",
  "go.sum": "file-box", license: "file-key", makefile: "file-terminal",
  "meson.build": "file-cog", notice: "file-key",
  "package-lock.json": "file-box", "package.json": "file-box",
  pipfile: "file-box", "pnpm-lock.yaml": "file-box",
  "pnpm-workspace.yaml": "file-box", "poetry.lock": "file-box",
  "pom.xml": "file-box", "postcss.config.cjs": "file-sliders",
  "postcss.config.js": "file-sliders", "postcss.config.mjs": "file-sliders",
  "postcss.config.ts": "file-sliders", "pyproject.toml": "file-box",
  readme: "file-text", "readme.md": "file-text",
  "requirements-dev.txt": "file-box", "requirements.txt": "file-box",
  security: "file-lock", "security.md": "file-lock",
  "settings.gradle": "file-cog", "settings.gradle.kts": "file-cog",
  "tailwind.config.cjs": "file-sliders", "tailwind.config.js": "file-sliders",
  "tailwind.config.mjs": "file-sliders", "tailwind.config.ts": "file-sliders",
  todo: "file-text", "tsconfig.json": "file-sliders",
  "vite.config.js": "file-sliders", "vite.config.mjs": "file-sliders",
  "vite.config.ts": "file-sliders", "vitest.config.js": "file-sliders",
  "vitest.config.mjs": "file-sliders", "vitest.config.ts": "file-sliders",
  "yarn.lock": "file-box",
};

const FILE_COMPOUND_EXTENSIONS = ["tar.bz2", "tar.gz", "tar.xz"];

function fileBaseName(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function fileExtOf(name) {
  const lower = name.toLowerCase();
  for (const ext of FILE_COMPOUND_EXTENSIONS) {
    if (lower.endsWith("." + ext)) return ext;
  }
  // dot <= 0：隐藏文件（.gitignore）不算后缀；末尾是点（foo.）也不算。
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/* 一个路径 → 图标名。规则和 Orca 的 getFileTypeIcon 一字不差（顺序也一样）：
   文件名表 → .env → dockerfile → makefile → 后缀表 → file。 */
function fileIconName(path) {
  const name = fileBaseName(path);
  if (!name) return "file";
  const lower = name.toLowerCase();
  const exact = FILE_ICON_BY_NAME[lower];
  if (exact) return exact;
  if (lower === ".env" || lower.startsWith(".env.")) return "file-lock";
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "file-cog";
  if (lower === "makefile" || lower.startsWith("makefile.")) return "file-terminal";
  return FILE_ICON_BY_EXTENSION[fileExtOf(name)] || "file";
}

function fileIconSvg(path, size) {
  const body = FILE_ICON_PATHS[fileIconName(path)] || FILE_ICON_PATHS.file;
  return `<svg width="${size || 14}" height="${size || 14}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round">${body}</svg>`;
}

/* 目录：合着是 folder、展开是 folder-open（Orca FileExplorerRow 的两态）。 */
function fileDirIconSvg(open, size) {
  const body = open ? FILE_ICON_PATHS["folder-open"] : FILE_ICON_PATHS.folder;
  return `<svg width="${size || 14}" height="${size || 14}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round">${body}</svg>`;
}

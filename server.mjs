// drawio-ai-kit web UI server
// POST /api/generate  { description }  → JSON { filename, preview (SVG data URL) }
// GET  /api/out/:file                  → serve saved .drawio file
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Diagram } from "./src/builder.mjs";
import { icon, frame, group, grid, stage, band, endpoint, renderTree } from "./src/layout-engine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ── Catalog ─────────────────────────────────────────────────────────────────
function loadAllIcons() {
  const dir = join(__dirname, "catalog");
  const byCategory = {};
  const validNames = new Set();
  for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    for (const ic of data.icons ?? []) {
      validNames.add(ic.name);
      (byCategory[ic.category ?? "Other"] ??= []).push(ic.name);
    }
  }
  return { byCategory, validNames };
}
const { byCategory, validNames } = loadAllIcons();
const catalogText = Object.entries(byCategory)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([cat, names]) => `[${cat}] ${names.join(", ")}`)
  .join("\n");

// ── Diagram builder ──────────────────────────────────────────────────────────
function safeIconName(name) { return validNames.has(name) ? name : null; }

function makeIcons(items) {
  return (items ?? []).map(i => {
    const n = safeIconName(i.name);
    if (!n) { console.warn(`Unknown icon: "${i.name}" — skipped`); return null; }
    return icon(i.id, n, i.label ?? "");
  }).filter(Boolean);
}

function buildPipeline(spec, d) {
  const stages = (spec.stages ?? []).map((s, idx) =>
    stage(s.id ?? `s${idx}`, s.index ?? idx, s.label ?? `Stage ${idx + 1}`, makeIcons(s.icons), { gap: 36 })
  );
  const pipe = frame("pipe", "", { dir: "row", gap: 50, align: "top", header: 0, fill: "none", stroke: "none" }, stages);
  const toprow = frame("toprow", "", { dir: "row", gap: 30, align: "center", header: 0, pad: 0, fill: "none", stroke: "none" }, [
    endpoint("src", spec.sourceLabel ?? "SOURCES"), pipe, endpoint("cons", spec.consumerLabel ?? "CONSUMERS"),
  ]);
  const bands = (spec.bands ?? []).map((b, idx) =>
    band(b.id ?? `b${idx}`, b.label ?? "", makeIcons(b.icons), { gap: 40 })
  );
  const root = frame("root", "", { dir: "col", gap: 30, header: 0, pad: 10, fill: "none", stroke: "none" },
    bands.length ? [toprow, ...bands] : [toprow]);
  renderTree(d, root, [40, 80]);
  d.title(spec.title ?? "Architecture Diagram");
  for (const lk of spec.links ?? []) {
    try { d.link(lk.from, lk.to, lk.label ?? "", { flow: lk.flow, role: lk.role }); }
    catch (e) { console.warn(`Link ${lk.from}→${lk.to} skipped:`, e.message); }
  }
}

function buildHubspoke(spec, d) {
  const col = (id, title, items) =>
    group(id, null, title, { dir: "col", gap: 40, fill: "none", stroke: "none", align: "center" }, makeIcons(items));
  const columns = (spec.columns ?? []).map(c => col(c.id, c.label ?? "", c.icons));
  const tree = group("root", null, "", { dir: "row", gap: 200, align: "top", header: 0, pad: 10, fill: "none", stroke: "none" }, columns);
  renderTree(d, tree, [40, 90]);
  if (spec.hub && columns.length >= 2) {
    const hubIcon = safeIconName(spec.hub.icon ?? spec.hub.name ?? "");
    if (hubIcon) {
      d.spanV("hub", { icon: hubIcon, label: spec.hub.label ?? "", w: 140, pad: 0, stroke: "#E7157B" },
        { between: [columns[0].id, columns[1].id], from: columns[0].id, to: columns[0].id });
    }
  }
  d.title(spec.title ?? "Architecture Diagram");
  for (const lk of spec.links ?? []) {
    try { d.link(lk.from, lk.to, lk.label ?? "", { flow: lk.flow, role: lk.role }); }
    catch (e) { console.warn(`Link ${lk.from}→${lk.to} skipped:`, e.message); }
  }
}

function buildLayered(spec, d) {
  const subsystems = spec.subsystems ?? [];
  const layers = spec.layers ?? [];
  const LABEL_W = 90;

  const layerRows = layers.map((layer, li) => {
    const labelBox = {
      kind: "box", id: `lbl_${layer.id ?? `l${li}`}`,
      label: layer.label ?? `Layer ${li + 1}`,
      fill: li % 2 === 0 ? "#e3f2fd" : "#fce4ec",
      stroke: "#9e9e9e", bold: true,
      w: LABEL_W, h: 70,
    };

    const cells = subsystems.map((sub, si) => {
      const cellIcons = makeIcons(layer.cells?.[sub.id] ?? []);
      if (!cellIcons.length) {
        return { kind: "box", id: `empty_${li}_${si}`, label: "",
          fill: "none", stroke: "#e8e8e8", w: 200, h: 70 };
      }
      const cols = Math.min(3, cellIcons.length);
      return grid(`cell_${li}_${si}`, null, "", {
        cols, gap: 24,
        fill: sub.color ? sub.color + "22" : "#fafafa",
        stroke: sub.color ?? "#cccccc",
        pad: 14,
      }, cellIcons);
    });

    return frame(`row_${layer.id ?? `l${li}`}`, "", {
      dir: "row", gap: 4, align: "top",
      fill: li % 2 === 0 ? "#ffffff" : "#f5f5f5",
      stroke: "#cccccc", pad: 8, header: 0,
    }, [labelBox, ...cells]);
  });

  // Footer: subsystem labels
  const ftPlaceholder = { kind: "box", id: "ft_ph", label: "", fill: "none", stroke: "none", w: LABEL_W, h: 36 };
  const footers = subsystems.map((sub, si) =>
    ({ kind: "box", id: `ft_${si}`, label: sub.label ?? sub.id,
       fill: sub.color ?? "#bbdefb", stroke: "#888888", h: 36 })
  );
  const footerRow = frame("footer_row", "", {
    dir: "row", gap: 4, align: "center", fill: "none", stroke: "none", pad: 8, header: 0,
  }, [ftPlaceholder, ...footers]);

  const root = frame("root", "", {
    dir: "col", gap: 2, header: 0, pad: 10, fill: "none", stroke: "none",
  }, [...layerRows, footerRow]);

  renderTree(d, root, [40, 80]);
  d.title(spec.title ?? "Architecture Diagram");
  for (const lk of spec.links ?? []) {
    try { d.link(lk.from, lk.to, lk.label ?? "", { flow: lk.flow, role: lk.role }); }
    catch (e) { console.warn(`Link ${lk.from}→${lk.to} skipped:`, e.message); }
  }
}

// Returns { xml, d } so the diagram object (with R registry) is available for SVG preview
function buildDiagram(spec) {
  const type = spec.type === "hubspoke" ? "hubspoke" : spec.type === "layered" ? "layered" : "pipeline";
  const d = new Diagram(type);
  if (spec.type === "hubspoke") buildHubspoke(spec, d);
  else if (spec.type === "layered") buildLayered(spec, d);
  else buildPipeline(spec, d);
  const { ok, errors } = d.validate();
  if (!ok) console.warn("Validation warnings:", errors);
  return { xml: d.mxfile(spec.title ?? "Architecture"), d };
}

// ── SVG preview from raw .drawio XML ────────────────────────────────────────
// Parses mxCell elements, reconstructs absolute positions, renders SVG.

function parseMxCells(xml) {
  const cells = {};
  // Match both self-closing and wrapped mxCell tags
  const re = /<mxCell\b([^>]*)>([\s\S]*?)<\/mxCell>|<mxCell\b([^\/]*?)\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? m[3] ?? "";
    const inner = m[2] ?? "";
    const get = name => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const id = get("id");
    if (!id || id === "0" || id === "1") continue;
    const geom = inner.match(/<mxGeometry\b([^>]*)\/>/);
    const gGet = name => {
      if (!geom) return 0;
      return parseFloat(geom[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[ 1] ?? "0");
    };
    cells[id] = {
      label: htmlDec(get("value") ?? ""),
      style: get("style") ?? "",
      parent: get("parent") ?? "1",
      x: gGet("x"), y: gGet("y"), w: gGet("width"), h: gGet("height"),
      isEdge: attrs.includes('edge="1"'),
      source: get("source"), target: get("target"),
    };
  }
  return cells;
}

function absolutePositions(cells) {
  const abs = {};
  function resolve(id) {
    if (abs[id]) return abs[id];
    const c = cells[id];
    if (!c || c.parent === "0" || c.parent === "1" || !cells[c.parent]) {
      return (abs[id] = { x: c?.x ?? 0, y: c?.y ?? 0 });
    }
    const p = resolve(c.parent);
    return (abs[id] = { x: p.x + c.x, y: p.y + c.y });
  }
  for (const id of Object.keys(cells)) resolve(id);
  return abs;
}

function svgFromParsed(cells, absPos) {
  const vertices = Object.entries(cells).filter(([, c]) => !c.isEdge && c.w > 0 && c.h > 0);
  const edges    = Object.entries(cells).filter(([, c]) => c.isEdge);
  if (!vertices.length) return null;

  const maxX = Math.max(...vertices.map(([id, c]) => (absPos[id]?.x ?? 0) + c.w)) + 40;
  const maxY = Math.max(...vertices.map(([id, c]) => (absPos[id]?.y ?? 0) + c.h)) + 40;
  const S = Math.min(1, 900 / maxX);
  const W = Math.round(maxX * S), H = Math.round(maxY * S);

  const sorted = [...vertices].sort(([, a], [, b]) => (b.w * b.h) - (a.w * a.h));
  const elements = sorted.map(([id, c]) => {
    const ax = (absPos[id]?.x ?? 0), ay = (absPos[id]?.y ?? 0);
    const sx = Math.round(ax * S), sy = Math.round(ay * S);
    const sw = Math.max(2, Math.round(c.w * S)), sh = Math.max(2, Math.round(c.h * S));
    const fillM   = c.style.match(/fillColor=([^;]+)/);
    const strokeM = c.style.match(/strokeColor=([^;]+)/);
    const fill    = fillM   ? (fillM[1]   === "none" ? "transparent" : fillM[1])   : "#f5f5f5";
    const stroke  = strokeM ? (strokeM[1] === "none" ? "transparent" : strokeM[1]) : "#999";
    const isIcon  = c.style.includes("shape=mxgraph.");
    const isBold  = c.style.includes("fontStyle=1");
    const firstLine = c.label.split("\n")[0];
    const fs = Math.max(9, Math.round(10 * S));

    if (isIcon) {
      const r  = Math.round(Math.min(sw, sh) * 0.4);
      const cx = sx + Math.round(sw / 2), cy = sy + Math.round(sh / 2);
      const col = stroke !== "transparent" ? stroke : "#888";
      return `<rect x="${cx-r}" y="${cy-r}" width="${r*2}" height="${r*2}" rx="4" fill="${col}22" stroke="${col}" stroke-width="1.5"/>` +
        (firstLine ? `<text x="${cx}" y="${sy+sh+Math.round(11*S)}" text-anchor="middle" font-size="${Math.max(8,Math.round(9*S))}" font-family="system-ui,sans-serif" fill="#333">${esc(firstLine)}</text>` : "");
    }
    return `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
      (firstLine ? `<text x="${sx+8}" y="${sy+Math.round(15*S)}" font-size="${fs}" font-weight="${isBold?"600":"400"}" font-family="system-ui,sans-serif" fill="#1a1a1a">${esc(firstLine)}</text>` : "");
  }).join("\n");

  const edgeLines = edges.map(([, c]) => {
    const s = c.source && absPos[c.source] && cells[c.source];
    const t = c.target && absPos[c.target] && cells[c.target];
    if (!s || !t) return "";
    const x1 = Math.round((absPos[c.source].x + cells[c.source].w/2) * S);
    const y1 = Math.round((absPos[c.source].y + cells[c.source].h/2) * S);
    const x2 = Math.round((absPos[c.target].x + cells[c.target].w/2) * S);
    const y2 = Math.round((absPos[c.target].y + cells[c.target].h/2) * S);
    const mx = Math.round((x1+x2)/2), my = Math.round((y1+y2)/2);
    const lbl = c.label;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#arr)"/>` +
      (lbl ? `<text x="${mx}" y="${my-4}" text-anchor="middle" font-size="${Math.max(8,Math.round(9*S))}" font-family="system-ui,sans-serif" fill="#64748b">${esc(lbl)}</text>` : "");
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#94a3b8"/></marker></defs>
<rect width="${W}" height="${H}" fill="#ffffff"/>
${elements}
${edgeLines}
</svg>`;
}

function generatePreviewSVGFromXML(xml) {
  const cells = parseMxCells(xml);
  const abs   = absolutePositions(cells);
  return svgFromParsed(cells, abs);
}

// ── SVG preview generator ───────────────────────────────────────────────────
// Uses d.R (absolute positions) and d.cells (labels + styles) — no extra deps.

const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const htmlDec = s => String(s ?? "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#xa;/g,"\n");

function parseCellMeta(cells) {
  // cells is an array of mxCell XML strings produced by builder.mjs
  const meta = {};
  for (const cell of cells) {
    const id   = (cell.match(/\bid="([^"]*)"/) ?? [])[1];
    const val  = (cell.match(/\bvalue="([^"]*)"/) ?? [])[1];
    const sty  = (cell.match(/\bstyle="([^"]*)"/) ?? [])[1] ?? "";
    if (!id) continue;
    const fill   = (sty.match(/fillColor=([^;]+)/) ?? [])[1] ?? "#f5f5f5";
    const stroke = (sty.match(/strokeColor=([^;]+)/) ?? [])[1] ?? "#999999";
    const isIcon = sty.includes("shape=mxgraph.");
    const isBold = sty.includes("fontStyle=1");
    meta[id] = { label: htmlDec(val), fill, stroke, isIcon, isBold };
  }
  return meta;
}

function generatePreviewSVG(d) {
  const entries = Object.entries(d.R).filter(([id]) => id !== "0" && id !== "1");
  if (!entries.length) return null;

  const meta = parseCellMeta(d.cells);

  const maxX = Math.max(...entries.map(([, c]) => c.x + c.w)) + 40;
  const maxY = Math.max(...entries.map(([, c]) => c.y + c.h)) + 40;

  // Scale to max 900px wide
  const S = Math.min(1, 900 / maxX);
  const W = Math.round(maxX * S), H = Math.round(maxY * S);

  // Render largest cells first (containers behind icons)
  const sorted = [...entries].sort(([, a], [, b]) => (b.w * b.h) - (a.w * a.h));

  const elements = sorted.map(([id, { x, y, w, h }]) => {
    const m = meta[id] ?? { label: "", fill: "#f5f5f5", stroke: "#999", isIcon: false };
    const sx = Math.round(x * S), sy = Math.round(y * S);
    const sw = Math.max(2, Math.round(w * S)), sh = Math.max(2, Math.round(h * S));
    const fill   = m.fill   === "none" ? "transparent" : m.fill;
    const stroke = m.stroke === "none" ? "transparent" : m.stroke;
    const firstLine = m.label.split("\n")[0];

    if (m.isIcon) {
      // Icon: small colored square with label below
      const r = Math.round(Math.min(sw, sh) * 0.4);
      const cx = sx + Math.round(sw / 2), cy = sy + Math.round(sh / 2);
      const color = stroke !== "transparent" ? stroke : "#888";
      const fs = Math.max(8, Math.round(9 * S));
      return [
        `<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" rx="4" fill="${color}22" stroke="${color}" stroke-width="1.5"/>`,
        firstLine ? `<text x="${cx}" y="${sy + sh + Math.round(11 * S)}" text-anchor="middle" font-size="${fs}" font-family="system-ui,sans-serif" fill="#333">${esc(firstLine)}</text>` : "",
      ].join("\n");
    }

    // Container/box: rectangle + label at top
    const fs = Math.max(9, Math.round(10 * S));
    const fw = m.isBold ? "600" : "400";
    return [
      `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`,
      firstLine ? `<text x="${sx + 8}" y="${sy + Math.round(15 * S)}" font-size="${fs}" font-weight="${fw}" font-family="system-ui,sans-serif" fill="#1a1a1a">${esc(firstLine)}</text>` : "",
    ].join("\n");
  }).join("\n");

  // Draw edges (links) as simple lines — extract source/target from edge cells
  const edgeLines = d.cells
    .filter(c => c.includes('edge="1"'))
    .map(c => {
      const src = (c.match(/\bsource="([^"]*)"/) ?? [])[1];
      const tgt = (c.match(/\btarget="([^"]*)"/) ?? [])[1];
      const lbl = htmlDec((c.match(/\bvalue="([^"]*)"/) ?? [])[1] ?? "");
      if (!src || !tgt || !d.R[src] || !d.R[tgt]) return "";
      const s = d.R[src], t = d.R[tgt];
      const x1 = Math.round((s.x + s.w / 2) * S), y1 = Math.round((s.y + s.h / 2) * S);
      const x2 = Math.round((t.x + t.w / 2) * S), y2 = Math.round((t.y + t.h / 2) * S);
      const mx = Math.round((x1 + x2) / 2), my = Math.round((y1 + y2) / 2);
      const fs = Math.max(8, Math.round(9 * S));
      return [
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#arr)"/>`,
        lbl ? `<text x="${mx}" y="${my - 4}" text-anchor="middle" font-size="${fs}" font-family="system-ui,sans-serif" fill="#64748b">${esc(lbl)}</text>` : "",
      ].join("\n");
    }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
    <path d="M0,0 L0,6 L8,3 z" fill="#94a3b8"/>
  </marker>
</defs>
<rect width="${W}" height="${H}" fill="#ffffff"/>
${elements}
${edgeLines}
</svg>`;
}

// ── Claude CLI call ──────────────────────────────────────────────────────────
function buildPrompt(description, annotations = []) {
  let extra = "";
  if (annotations.length) {
    extra = "\n\nANNOTATIONS — changes requested by the user on the current diagram:\n"
      + annotations.map((a, i) => `${i + 1}. [${a.position ?? "area"}] ${a.text}`).join("\n")
      + "\n\nIncorporate ALL annotation changes into the updated diagram. Keep unchanged parts intact.";
  }
  return `You are an expert Solution Architecture Diagram Designer.
Output ONLY a valid JSON object — no markdown fences, no explanation.${extra}

The JSON must have exactly two top-level keys:
• "spec": the diagram specification (schema below)
• "docs": a markdown string documenting the architecture (escape newlines as \\n in the JSON string)

DOCS FORMAT (for the "docs" string — viết hoàn toàn bằng Tiếng Việt):
# <Tên kiến trúc>
## Tổng quan
2-3 câu mô tả mục đích hệ thống và đặc điểm chính.
## Các thành phần
Danh sách bullet — mỗi thành phần và vai trò của nó.
## Luồng dữ liệu
Các bước đánh số — dữ liệu di chuyển end-to-end qua hệ thống như thế nào.
## Các quyết định thiết kế quan trọng
2-3 bullet về các lựa chọn kiến trúc đáng chú ý và sự đánh đổi.

DIAGRAM TYPES
• pipeline  — left-to-right data flow (Ingest → Process → Store → Serve).
  Use for: data pipelines, ETL, analytics, ML training.
• hubspoke  — hub in center with spoke columns.
  Use for: event buses (EventBridge, Kafka), API gateways as central routers.
• layered   — horizontal layers (rows) × vertical subsystems (columns).
  Use for: multi-system architectures with layers like Cloud, Proxy, Presentation, Business, Storage
  and multiple independent subsystems side by side.

PIPELINE JSON SCHEMA
{
  "title": "...",
  "type": "pipeline",
  "sourceLabel": "SOURCES\\n\\nDB · Apps",
  "consumerLabel": "CONSUMERS\\n\\nAPIs · ML",
  "stages": [{ "id": "s0", "index": 0, "label": "1 · Ingest", "icons": [{"id":"kds","name":"kinesis_data_streams","label":"Kinesis"}] }],
  "bands": [{ "id": "b0", "label": "Monitoring · Security", "icons": [{"id":"cw","name":"cloudwatch_2","label":"CloudWatch"}] }],
  "links": [{"from":"src","to":"kds","label":"stream","flow":true,"role":"fanout"}]
}

HUBSPOKE JSON SCHEMA
{
  "title": "...",
  "type": "hubspoke",
  "hub": { "icon": "eventbridge", "label": "Amazon EventBridge" },
  "columns": [{ "id": "producers", "label": "PRODUCERS", "icons": [{"id":"p_api","name":"api_gateway","label":"API Gateway"}] }],
  "links": [{"from":"p_api","to":"hub","label":"PutEvents"}]
}

LAYERED JSON SCHEMA
{
  "title": "...",
  "type": "layered",
  "subsystems": [
    {"id": "sys1", "label": "Hệ thống A", "color": "#dae8fc"},
    {"id": "sys2", "label": "Hệ thống B", "color": "#d5e8d4"}
  ],
  "layers": [
    {
      "id": "proxy", "label": "Proxy",
      "cells": {
        "sys1": [{"id":"ng1","name":"elastic_load_balancing","label":"NGINX Proxy"}],
        "sys2": [{"id":"ng2","name":"elastic_load_balancing","label":"NGINX Proxy"}]
      }
    },
    {
      "id": "business", "label": "Business",
      "cells": {
        "sys1": [{"id":"kafka1","name":"kinesis_data_streams","label":"Kafka"},{"id":"redis1","name":"elasticache","label":"Redis"}],
        "sys2": [{"id":"redis2","name":"elasticache","label":"Redis"}]
      }
    },
    {
      "id": "storage", "label": "Storage",
      "cells": {
        "sys1": [{"id":"db1","name":"aurora","label":"MongoDB"}],
        "sys2": [{"id":"db2","name":"aurora","label":"MongoDB"}]
      }
    }
  ],
  "links": [{"from":"ng1","to":"kafka1","label":"routes"},{"from":"ng2","to":"redis2"}]
}

RULES
• IDs must be unique snake_case (e.g. kds, lambda_1, s3_raw).
• Use 3-6 icons per stage / 2-5 icons per column / up to 6 icons per cell.
• "flow":true marks the primary animated data path (main spine only).
• "role":"fanout" for 1→many or many→1 edges.
• Always include a monitoring/security band for production architectures (pipeline only).
• For layered type: cells object keys must exactly match subsystem ids. Omit empty cells.
• Use EXACT icon names from this catalog:

${catalogText}

Architecture to diagram:
${description}`;
}

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

function findClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    for (const ext of exts) {
      const full = join(dir, `claude${ext}`);
      try { readFileSync(full); return full; } catch {}
    }
  }
  const vscodeExt = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".vscode", "extensions");
  try {
    for (const dir of readdirSync(vscodeExt)) {
      if (!dir.startsWith("anthropic.claude-code")) continue;
      const candidate = join(vscodeExt, dir, "resources", "native-binary", "claude.exe");
      try { readFileSync(candidate); return candidate; } catch {}
    }
  } catch {}
  return "claude";
}

const CLAUDE_BIN = findClaude();
console.log(`[init] claude CLI: ${CLAUDE_BIN}`);

async function generateSpec(description, annotations = []) {
  const prompt = buildPrompt(description, annotations);
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, ["--model", "claude-sonnet-4-6", "--permission-mode", "bypassPermissions", "--print"],
      { timeout: 120_000 });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });
    proc.stdin.write(prompt);
    proc.stdin.end();
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`Claude CLI exited ${code}: ${stderr.slice(0, 300)}`));
      const raw = extractJSON(stdout);
      if (!raw) { console.error("[generate] raw:", stdout.slice(0, 500)); return reject(new Error("No JSON in Claude output")); }
      try {
        const parsed = JSON.parse(raw);
        // Support both new { spec, docs } format and legacy direct-spec format
        const spec = parsed.spec ?? parsed;
        const docs = typeof parsed.docs === "string" ? parsed.docs : null;
        resolve({ spec, docs });
      }
      catch (e) { console.error("[generate] bad JSON:", raw.slice(0, 300)); reject(new Error("JSON parse: " + e.message)); }
    });
    proc.on("error", err => reject(new Error("claude CLI not found: " + err.message)));
  });
}

// ── Anthropic SDK — image vision ─────────────────────────────────────────────
function buildImagePrompt(description = "", annotations = []) {
  let extra = "";
  if (annotations.length) {
    extra = "\n\nANNOTATIONS — changes requested by the user on the current diagram:\n"
      + annotations.map((a, i) => `${i + 1}. [${a.position ?? "area"}] ${a.text}`).join("\n")
      + "\n\nIncorporate ALL annotation changes into the updated diagram. Keep unchanged parts intact.";
  }
  const descHint = description?.trim() ? `\n\nAdditional context from user: ${description}` : "";

  return `You are an expert Solution Architecture Diagram Designer.
Carefully analyze the architecture diagram shown in the image.
Identify every component, service, data store, and all connections/flows between them.
Then output ONLY a valid JSON object — no markdown fences, no explanation.${extra}${descHint}

The JSON must have exactly two top-level keys:
• "spec": the diagram specification (schema below)
• "docs": a markdown string documenting the architecture (escape newlines as \\n in the JSON string)

DOCS FORMAT (for the "docs" string — viết hoàn toàn bằng Tiếng Việt):
# <Tên kiến trúc>
## Tổng quan
2-3 câu mô tả mục đích hệ thống và đặc điểm chính.
## Các thành phần
Danh sách bullet — mỗi thành phần và vai trò của nó.
## Luồng dữ liệu
Các bước đánh số — dữ liệu di chuyển end-to-end qua hệ thống như thế nào.
## Các quyết định thiết kế quan trọng
2-3 bullet về các lựa chọn kiến trúc đáng chú ý và sự đánh đổi.

DIAGRAM TYPES
• pipeline  — left-to-right data flow (Ingest → Process → Store → Serve).
  Use for: data pipelines, ETL, analytics, ML training.
• hubspoke  — hub in center with spoke columns.
  Use for: event buses (EventBridge, Kafka), API gateways as central routers.
• layered   — horizontal layers (rows) × vertical subsystems (columns).
  Use for: multi-system architectures with layers like Cloud, Proxy, Presentation, Business, Storage
  and multiple independent subsystems side by side.

PIPELINE JSON SCHEMA
{
  "title": "...",
  "type": "pipeline",
  "sourceLabel": "SOURCES\\n\\nDB · Apps",
  "consumerLabel": "CONSUMERS\\n\\nAPIs · ML",
  "stages": [{ "id": "s0", "index": 0, "label": "1 · Ingest", "icons": [{"id":"kds","name":"kinesis_data_streams","label":"Kinesis"}] }],
  "bands": [{ "id": "b0", "label": "Monitoring · Security", "icons": [{"id":"cw","name":"cloudwatch_2","label":"CloudWatch"}] }],
  "links": [{"from":"src","to":"kds","label":"stream","flow":true,"role":"fanout"}]
}

HUBSPOKE JSON SCHEMA
{
  "title": "...",
  "type": "hubspoke",
  "hub": { "icon": "eventbridge", "label": "Amazon EventBridge" },
  "columns": [{ "id": "producers", "label": "PRODUCERS", "icons": [{"id":"p_api","name":"api_gateway","label":"API Gateway"}] }],
  "links": [{"from":"p_api","to":"hub","label":"PutEvents"}]
}

LAYERED JSON SCHEMA
{
  "title": "...",
  "type": "layered",
  "subsystems": [
    {"id": "sys1", "label": "Hệ thống A", "color": "#dae8fc"},
    {"id": "sys2", "label": "Hệ thống B", "color": "#d5e8d4"}
  ],
  "layers": [
    {
      "id": "proxy", "label": "Proxy",
      "cells": {
        "sys1": [{"id":"ng1","name":"elastic_load_balancing","label":"NGINX Proxy"}],
        "sys2": [{"id":"ng2","name":"elastic_load_balancing","label":"NGINX Proxy"}]
      }
    },
    {
      "id": "business", "label": "Business",
      "cells": {
        "sys1": [{"id":"kafka1","name":"kinesis_data_streams","label":"Kafka"},{"id":"redis1","name":"elasticache","label":"Redis"}],
        "sys2": [{"id":"redis2","name":"elasticache","label":"Redis"}]
      }
    },
    {
      "id": "storage", "label": "Storage",
      "cells": {
        "sys1": [{"id":"db1","name":"aurora","label":"MongoDB"}],
        "sys2": [{"id":"db2","name":"aurora","label":"MongoDB"}]
      }
    }
  ],
  "links": [{"from":"ng1","to":"kafka1","label":"routes"},{"from":"ng2","to":"redis2"}]
}

RULES
• IDs must be unique snake_case (e.g. kds, lambda_1, s3_raw).
• Use 3-6 icons per stage / 2-5 icons per column / up to 6 icons per cell.
• "flow":true marks the primary animated data path (main spine only).
• "role":"fanout" for 1→many or many→1 edges.
• Always include a monitoring/security band for production architectures (pipeline only).
• For layered type: cells object keys must exactly match subsystem ids. Omit empty cells.
• Use EXACT icon names from this catalog:

${catalogText}

Recreate the architecture shown in the image above as a draw.io diagram.`;
}

async function generateSpecFromImage(imageBase64, mediaType, description = "", annotations = []) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Để phân tích ảnh cần ANTHROPIC_API_KEY trong biến môi trường. Hãy thiết lập ANTHROPIC_API_KEY=sk-ant-... trước khi khởi động server.");
  }
  const anthropic = new Anthropic();

  // ── Bước 1: Claude Vision mô tả ảnh bằng ngôn ngữ tự nhiên ─────────────────
  console.log(`[image-generate] bước 1 — đọc ảnh (${mediaType})`);
  const describeResp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: `Analyze this software architecture diagram image carefully.

List every component, service, data store, queue, and external system you can see.
Describe all connections, arrows, and data flows between them — include direction and labels if visible.
Note the overall architecture pattern (data pipeline, event-driven, microservices, hub-spoke, etc.).
Include any stage labels, group names, or section titles visible in the diagram.

Be exhaustive and precise. This description will be used to recreate the diagram as a draw.io file.` }
      ]
    }]
  });
  const imageDescription = describeResp.content[0]?.text ?? "";
  console.log(`[image-generate] bước 1 xong — ${imageDescription.length} ký tự`);

  // ── Bước 2: Dùng mô tả để sinh spec qua CLI ─────────────────────────────────
  const parts = ["Kiến trúc được trích xuất từ ảnh tải lên:\n" + imageDescription];
  if (description?.trim()) parts.push("Bối cảnh bổ sung từ người dùng: " + description);
  console.log(`[image-generate] bước 2 — sinh spec từ mô tả`);
  return generateSpec(parts.join("\n\n"), annotations);
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.static(join(__dirname, "public")));

// List .drawio files in out/
app.get("/api/out", (req, res) => {
  const outDir = join(__dirname, "out");
  try {
    const files = readdirSync(outDir)
      .filter(f => f.endsWith(".drawio"))
      .map(f => ({ name: f, mtime: statSync(join(outDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name);
    res.json(files);
  } catch {
    res.json([]);
  }
});

// Generate preview SVG from a saved .drawio file  GET /api/preview?file=xxx.drawio
app.get("/api/preview", (req, res) => {
  const safe = (req.query.file ?? "").replace(/[^a-z0-9._-]/gi, "_");
  if (!safe) return res.status(400).json({ error: "file param required" });
  const filePath = join(__dirname, "out", safe);
  try {
    const xml = readFileSync(filePath, "utf-8");
    const svg = generatePreviewSVGFromXML(xml);
    if (!svg) return res.status(422).json({ error: "Could not generate preview" });
    const preview = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    res.json({ filename: safe, preview });
  } catch (e) {
    console.error("[preview] error:", e.message, "path:", filePath);
    res.status(500).json({ error: e.message });
  }
});

// Serve saved .drawio files for download
app.get("/api/out/:file", (req, res) => {
  const safe = req.params.file.replace(/[^a-z0-9._-]/gi, "_");
  const filePath = join(__dirname, "out", safe);
  try {
    const content = readFileSync(filePath);
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
    res.send(content);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// Generate docs for an existing .drawio file that has no .md yet
app.post("/api/generate-docs", async (req, res) => {
  const { filename } = req.body ?? {};
  if (!filename) return res.status(400).json({ error: "filename required" });
  const safe = filename.replace(/[^a-z0-9._-]/gi, "_");
  const drawioPath = join(__dirname, "out", safe);
  try { readFileSync(drawioPath); } catch { return res.status(404).json({ error: "File not found" }); }

  // Extract title from filename (strip trailing timestamp if any)
  const title = safe.replace(".drawio", "").replace(/_\d{13}$/, "").replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());

  const xml = readFileSync(drawioPath, "utf-8");
  // Extract component labels from mxCell value attributes for context
  const labels = [];
  const re = /\bvalue="([^"]{2,60})"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const v = m[1].replace(/&#xa;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").trim();
    if (v && !v.startsWith("<") && !labels.includes(v)) labels.push(v);
  }

  const prompt = `You are a technical writer for software architecture. Write entirely in Vietnamese.
Viết tài liệu markdown mô tả kiến trúc hệ thống sau.
Chỉ xuất ra nội dung markdown — không có code fence, không có JSON wrapper.

Tên kiến trúc: ${title}

Các thành phần tìm thấy trong sơ đồ:
${labels.slice(0, 60).map(l => `- ${l}`).join("\n")}

Viết các phần sau:
# ${title}

## Tổng quan
2-3 câu mô tả mục đích hệ thống.

## Các thành phần
Danh sách bullet mỗi thành phần và vai trò của nó.

## Luồng dữ liệu
Các bước đánh số mô tả hệ thống xử lý yêu cầu end-to-end.

## Các quyết định thiết kế quan trọng
2-3 bullet về các lựa chọn kiến trúc đáng chú ý và sự đánh đổi.`;

  try {
    console.log(`[generate-docs] ${safe}`);
    const docs = await new Promise((resolve, reject) => {
      const proc = spawn(CLAUDE_BIN, ["--model", "claude-sonnet-4-6", "--permission-mode", "bypassPermissions", "--print"],
        { timeout: 60_000 });
      let out = "", err = "";
      proc.stdout.on("data", d => { out += d; });
      proc.stderr.on("data", d => { err += d; });
      proc.stdin.write(prompt); proc.stdin.end();
      proc.on("close", code => code !== 0 ? reject(new Error(`Claude CLI exited ${code}: ${err.slice(0,200)}`)) : resolve(out.trim()));
      proc.on("error", e => reject(new Error("claude CLI not found: " + e.message)));
    });
    const mdFile = safe.replace(".drawio", ".md");
    writeFileSync(join(__dirname, "out", mdFile), docs, "utf-8");
    console.log(`[generate-docs] saved → out/${mdFile}`);
    res.json({ content: docs });
  } catch (err) {
    console.error("[generate-docs] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Serve .md docs for a generated file  GET /api/docs?file=xxx.md
app.get("/api/docs", (req, res) => {
  const safe = (req.query.file ?? "").replace(/[^a-z0-9._-]/gi, "_");
  if (!safe) return res.status(400).json({ error: "file param required" });
  const mdPath = join(__dirname, "out", safe);
  try {
    const content = readFileSync(mdPath, "utf-8");
    res.json({ content });
  } catch {
    res.status(404).json({ error: "Documentation not found for this file." });
  }
});

app.post("/api/generate", async (req, res) => {
  const { description, annotations = [], imageBase64, imageMediaType } = req.body ?? {};
  if (!description?.trim() && !imageBase64) return res.status(400).json({ error: "description hoặc ảnh là bắt buộc" });

  try {
    const { spec, docs } = imageBase64
      ? await generateSpecFromImage(imageBase64, imageMediaType || "image/png", description, annotations)
      : await generateSpec(description, annotations);
    console.log(`[generate] type=${spec.type}, title="${spec.title}", hasDocs=${!!docs}, fromImage=${!!imageBase64}`);

    const { xml, d } = buildDiagram(spec);
    const slug = (spec.title ?? "architecture").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    const filename = slug + ".drawio";

    const outDir = join(__dirname, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, filename), xml);

    // Save markdown documentation alongside the .drawio file
    if (docs) {
      writeFileSync(join(outDir, slug + ".md"), docs, "utf-8");
      console.log(`[generate] saved → out/${slug}.md`);
    }
    console.log(`[generate] saved → out/${filename}`);

    const svg = generatePreviewSVG(d);
    const preview = svg ? "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64") : null;

    res.json({ filename, preview });
  } catch (err) {
    console.error("[generate] error:", err);
    res.status(500).json({ error: err.message ?? "Generation failed" });
  }
});

app.listen(PORT, () => {
  console.log(`\n  drawio-ai-kit UI  →  http://localhost:${PORT}\n`);
});

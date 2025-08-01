// app.js (v5-aligned; fixes pdfjs legacy warning; renders stage4_raw; Safety prompt UI)
// - Stages 1–4 per v5 workflow (no skip-portfolio rule)
// - Multimodal: PDF page images + image-dominant batched sweep
// - ZIP & DOCX support, UTF-8 SSE, aligned file list, log folding
// - Visualization renders v5 structured JSON; also supports v3 JSON and stage4_raw
// - Safety & Transparency section with copyable prompt and Claude link
// - Merged with Render-hosting configuration (CORS, /tmp uploads)
// - Updated to latest model versions (Claude 4 Opus, Claude 4 Sonnet, Claude 3.5 Haiku)

"use strict";

const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const EventEmitter = require("events");
const cors = require("cors");

// Optional deps (safe fallbacks)
function safeRequire(m) { try { return require(m); } catch { return null; } }
const AdmZip = safeRequire("adm-zip");
const mammoth = safeRequire("mammoth");

// Use pdfjs legacy build in Node to avoid warning
let pdfjsLib = null;
try { pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js"); } catch {}
let createCanvas, loadImage;
const napiCanvas = safeRequire("@napi-rs/canvas");
if (napiCanvas) { createCanvas = napiCanvas.createCanvas; loadImage = napiCanvas.loadImage; }
if (pdfjsLib) {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = require("pdfjs-dist/legacy/build/pdf.worker.js");
  } catch {}
}

const app = express();
app.use(cors({ origin: "*" })); // Public access for Render hosting

const upload = multer({
  dest: "/tmp", // Render’s writable directory
  limits: { fileSize: 10 * 1024 * 1024, files: 20 }, // 10 MB, 20 files
});
const port = process.env.PORT || 3001;

app.use(express.static("public"));

const sessions = new Map();

/* -------------------------- Vision & batching limits -------------------------- */
const PDF_PREVIEW_PAGES = 3;                 // quick preview images everywhere
const IMAGE_MAX_DIM = 1600;                  // px longest side
const STAGE1_MAX_IMAGES = 6;                 // total images attached for Stage 1
const STAGE2B_MAX_IMAGES = 3;                // default for non image-dominant items
const RAW_IMAGE_SIZE_BYTES_LIMIT = 1.5 * 1024 * 1024;

/* Image-dominant detection & sweep */
const IMAGE_PDF_TEXT_PER_PAGE_THRESHOLD = 400;  // chars/page; below => image-dominant
const IMAGE_PDF_MAX_PAGES = 24;                 // total pages to sweep (cap)
const IMAGE_PDF_BATCH_PAGES = 6;                // pages per call
const MAX_PDF_BUFFER_BYTES = 25 * 1024 * 1024;  // keep PDF buffer only if <= 25MB

/* --------------------------------- Prompts --------------------------------- */
function readText(p) { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } }
function loadPromptFile(name) {
  const p = path.join(__dirname, "prompts", name);
  const t = readText(p);
  return (t && t.trim()) || null;
}
function interpolate(t, vars) {
  let out = t;
  for (const [k, v] of Object.entries(vars || {})) {
    const re = new RegExp(`{{\\s*${k}\\s*}}`, "g");
    out = out.replace(re, v);
  }
  return out;
}
function ensureInjected(templateOrNull, key, textToInject, heading, emitter, tag) {
  if (!templateOrNull) return null;
  const has = new RegExp(`{{\\s*${key}\\s*}}`).test(templateOrNull);
  if (has) {
    emitter.emit("log", `Using prompts/${tag}.txt (placeholder ${key}=true)`);
    return interpolate(templateOrNull, { [key]: textToInject });
  } else {
    emitter.emit("log", `Using prompts/${tag}.txt (placeholder ${key}=false; appended)`);
    return `${templateOrNull}\n\n${heading}\n${textToInject}`;
  }
}

/* ---------------------------------- Home ---------------------------------- */
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
'<!DOCTYPE html>\n' +
'<html lang="en"><head>\n' +
'<meta charset="UTF-8"/>\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0"/>\n' +
'<title>Anthropic Candidate Screening (v5)</title>\n' +
'<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"/>\n' +
'<style>\n' +
'  .border-dashed { border-style: dashed !important; }\n' +
'  .file-row { display:flex; align-items:center; gap:.75rem; }\n' +
'  .file-name { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n' +
'  .file-size { flex:0 0 100px; text-align:right; color:#6c757d; font-variant-numeric: tabular-nums; }\n' +
'  .kv { white-space: pre-wrap; }\n' +
'</style>\n' +
'</head>\n' +
'<body class="bg-light">\n' +
'  <div class="container mt-5">\n' +
'    <div class="card shadow">\n' +
'      <div class="card-body">\n' +
'        <h3 class="card-title mb-4">Anthropic Candidate Screening (v5)</h3>\n' +
'\n' +
'        <div class="mb-3">\n' +
'          <button class="btn btn-outline-secondary" data-bs-toggle="collapse" data-bs-target="#safetyInfo">Safety & Transparency</button>\n' +
'          <div id="safetyInfo" class="collapse mt-3">\n' +
'            <div class="card card-body bg-light">\n' +
'              <ul class="mb-3">\n' +
'                <li>No server-side API key storage; ephemeral use only.</li>\n' +
'                <li>Files are parsed then deleted from disk.</li>\n' +
'                <li>Stateless sessions in-memory; no analytics/telemetry.</li>\n' +
'                <li>Prompts read from <code>/prompts</code> with safe fallbacks.</li>\n' +
'              </ul>\n' +
'              <div class="mb-2"><strong>Safety prompt (copy & paste into Claude):</strong></div>\n' +
'              <textarea id="safetyPrompt" class="form-control" rows="6" readonly>Review this Node.js app for security & privacy. Confirm no API keys or candidate files are persisted, no telemetry, and that SSE endpoints don\'t leak secrets. Check PDF/image parsing, ZIP expansion, and Anthropic API usage. Look for risky dependencies or unsafe string concat in HTML. Assume deployment on Vercel/serverless. I will paste app.js next.</textarea>\n' +
'              <div class="mt-2 d-flex gap-2">\n' +
'                <button id="copySafety" class="btn btn-sm btn-secondary">Copy prompt</button>\n' +
'                <a class="btn btn-sm btn-primary" href="https://claude.ai/new" target="_blank" rel="noopener">Open Claude</a>\n' +
'                <a href="/app.js" download class="btn btn-sm btn-outline-secondary" title="This file is downloaded directly from the page you are on. Check the address bar above to confirm it is the real version.">Download app.js (from this exact page)</a>\n' +
'              </div>\n' +
'            </div>\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <form id="uploadForm">\n' +
'          <div class="mb-3">\n' +
'            <label class="form-label">Anthropic API Key</label>\n' +
'            <input id="apiKey" type="password" class="form-control" required placeholder="sk-ant-..." />\n' +
'          </div>\n' +
'          <div class="mb-3">\n' +
'            <label class="form-label">Model</label>\n' +
'            <select id="model" class="form-select">\n' +
'              <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>\n' +
'              <option value="claude-4-opus-20250514">Claude 4 Opus</option>\n' +
'            </select>\n' +
'          </div>\n' +
'          <div class="mb-3">\n' +
'            <label class="form-label">Upload Files (PDF, DOCX, TXT/MD, ZIP, JSON, CSV — max 20)</label>\n' +
'            <div id="dropZone" class="border border-2 border-dashed p-4 text-center bg-white rounded">\n' +
'              Drag & drop files here or click to select<br/>\n' +
'              <small class="text-muted">ZIP expanded server-side; PDFs get page-vision</small>\n' +
'            </div>\n' +
'            <ul id="fileList" class="list-group mt-2"></ul>\n' +
'          </div>\n' +
'          <button id="submitBtn" type="submit" class="btn btn-primary w-100" disabled>Start Screening</button>\n' +
'        </form>\n' +
'\n' +
'        <hr class="my-4"/>\n' +
'\n' +
'        <h5>Visualize a Previous JSON</h5>\n' +
'        <form id="jsonForm" class="mb-4">\n' +
'          <div class="mb-3">\n' +
'            <label class="form-label">Upload JSON File</label>\n' +
'            <input id="jsonFile" type="file" class="form-control" accept=".json" required>\n' +
'          </div>\n' +
'          <button id="jsonBtn" class="btn btn-secondary w-100" disabled>Visualize JSON</button>\n' +
'        </form>\n' +
'\n' +
'        <div class="accordion" id="samplesAccordion">\n' +
'          <div class="accordion-item">\n' +
'            <h2 class="accordion-header">\n' +
'              <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#samples">\n' +
'                Sample Profiles (No API key required)\n' +
'              </button>\n' +
'            </h2>\n' +
'            <div id="samples" class="accordion-collapse collapse show">\n' +
'              <div class="accordion-body">\n' +
'                <ul class="list-group">\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Ejnar Håkonsen</div><div class="small text-muted">Behavioral Systems Architect</div></div>\n' +
'                    <div>\n' +
'                      <a href="https://ejnar.notion.site/Anthropic-Strategic-Assessment-Ejnar-H-konsen-Strategic-Research-Advisor-Founding-UX-Researche-231a06b717c8805b91b7f2e2d19957b2?source=copy_link" target="_blank" rel="noopener" class="btn btn-sm btn-success me-1">🌍 Explore Profile Overview</a>\n' +
'                      <button onclick="loadSample(\'ejnar.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/ejnar.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/drive/folders/1BOfyhvcGpyj4_qA9VyBD30P9YwQV4JSG?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Percy Liang (Public CV)</div><div class="small text-muted">Leading academic in ML &amp; safety</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'Percy-Liang-results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/Percy-Liang-results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1iPDkvymJozz1LH9dfpvp-66llFAJ7n3d/view?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Young Turing (modern equivalent)</div><div class="small text-muted">Claude‑generated</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'turing results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/turing results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1Ksd_KpL8iAJAwm8KCSlr3jS8wSgWCrZV/view?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Pre-Nobel Kahneman (modern equivalent)</div><div class="small text-muted">Claude‑generated</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'Kahneman-results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/Kahneman-results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1LqybtG6AG-EXv37vXugVUJiaowp_Jyxh/view?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Practitioner-Innovator</div><div class="small text-muted">Claude‑generated</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'practitioner-innovator-results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/practitioner-innovator-results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1BzhT4cvj-N8zXgYTgDK0M4tYMK4m6wqK/view?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Modern Polymath</div><div class="small text-muted">Claude‑generated</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'modernPolymath-results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/modernPolymath-results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1Ksd_KpL8iAJAwm8KCSlr3jS8wSgWCrZV/view?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Nobel-Trajectory Physicist</div><div class="small text-muted">Claude‑generated</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'nobelTrajectory-results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/nobelTrajectory-results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1HegmI2ETlBG-Scaho0cG7JYACcCLjGe1/view?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Researcher at Priority Review Threshold</div><div class="small text-muted">Claude‑generated</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'liu-results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/liu-results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1uTIfE3GAmjrETQdjT_Vj0LFPQ2Tj7S-g/view?usp=sharing" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                  <li class="list-group-item d-flex justify-content-between align-items-center">\n' +
'                    <div><div>Solid Researcher Below Threshold</div><div class="small text-muted">Claude‑generated</div></div>\n' +
'                    <div>\n' +
'                      <button onclick="loadSample(\'park-results.json\')" class="btn btn-sm btn-primary me-1">Load Profile</button>\n' +
'                      <a href="/samples/park-results.json" download class="btn btn-sm btn-secondary me-1">JSON</a>\n' +
'                      <a href="https://drive.google.com/file/d/1XiVEajPIr3WfrjZsPvuQPhvXaiGEHJQy/view?usp=drive_link" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">CV Materials (Drive)</a>\n' +
'                    </div>\n' +
'                  </li>\n' +
'                </ul>\n' +
'              </div>\n' +
'            </div>\n' +
'          </div>\n' +
'        </div>\n' +
'      </div> \n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'<script>\n' +
'  const apiKeyInput = document.getElementById("apiKey");\n' +
'  const modelSelect = document.getElementById("model");\n' +
'  // --- Patch: Model selector (client-side) ---\n' +
'  try {\n' +
'    const ms = document.getElementById("model");\n' +
'    if (ms && !ms.dataset.enhanced) {\n' +
'      const desired = [\n' +
'        { value: "claude-4-opus-20250514", label: "Claude 4 Opus (~$0.5–$10)" },\n' +
'        { value: "claude-4-sonnet-latest", label: "Claude 4 Sonnet (~$0.1–$2)" },\n' +
'        { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku (~$0.04 — debug only)" }\n' +
'      ];\n' +
'      while (ms.firstChild) ms.removeChild(ms.firstChild);\n' +
'      desired.forEach(function(o){ const opt = document.createElement("option"); opt.value = o.value; opt.textContent = o.label; ms.appendChild(opt); });\n' +
'      ms.value = desired[0].value; // Opus default\n' +
'      ms.dataset.enhanced = "1";\n' +
'    }\n' +
'  } catch (e) {}\n' +
'  // --- End patch ---\n' +
'  const dropZone = document.getElementById("dropZone");\n' +
'  const fileListEl = document.getElementById("fileList");\n' +
'  const submitBtn = document.getElementById("submitBtn");\n' +
'  const form = document.getElementById("uploadForm");\n' +
'\n' +
'  const jsonForm = document.getElementById("jsonForm");\n' +
'  const jsonFileInput = document.getElementById("jsonFile");\n' +
'  const jsonBtn = document.getElementById("jsonBtn");\n' +
'\n' +
'  const copySafety = document.getElementById("copySafety");\n' +
'  const safetyPrompt = document.getElementById("safetyPrompt");\n' +
'\n' +
'  let selectedFiles = [];\n' +
'\n' +
'  if (copySafety) { copySafety.onclick = function(){ navigator.clipboard.writeText(safetyPrompt.value); copySafety.textContent = "Copied"; setTimeout(function(){ copySafety.textContent = "Copy prompt"; }, 1500); }; }\n' +
'\n' +
'  apiKeyInput.value = localStorage.getItem("anthropicApiKey") || "";\n' +
'  apiKeyInput.addEventListener("input", function(){ localStorage.setItem("anthropicApiKey", apiKeyInput.value); });\n' +
'\n' +
'  function checkFormValid() { submitBtn.disabled = !apiKeyInput.value.trim() || selectedFiles.length === 0; }\n' +
'  apiKeyInput.addEventListener("input", checkFormValid);\n' +
'\n' +
'  dropZone.addEventListener("click", function(){ const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.onchange = function(e){ addFiles(e.target.files); }; input.click(); });\n' +
'  dropZone.addEventListener("dragover", function(e){ e.preventDefault(); dropZone.classList.add("border-primary"); });\n' +
'  dropZone.addEventListener("dragleave", function(){ dropZone.classList.remove("border-primary"); });\n' +
'  dropZone.addEventListener("drop", function(e){ e.preventDefault(); dropZone.classList.remove("border-primary"); addFiles(e.dataTransfer.files); });\n' +
'\n' +
'  function addFiles(newFiles) { selectedFiles = selectedFiles.concat(Array.from(newFiles)); updateFileList(); }\n' +
'  function formatKB(bytes) { return (bytes/1024).toFixed(1) + " KB"; }\n' +
'  function escapeHtml(s){ return String(s||"").replace(/[&<>\\"\\\']/g, function(c){ return ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\\\'":"&#39;" })[c]; }); }\n' +
'\n' +
'  function updateFileList() {\n' +
'    fileListEl.innerHTML = "";\n' +
'    selectedFiles.forEach(function(file, index){\n' +
'      const li = document.createElement("li");\n' +
'      li.className = "list-group-item";\n' +
'      li.innerHTML = \'<div class="file-row">\' +\n' +
'        \'<span class="file-name">\' + escapeHtml(file.name) + \'</span>\' +\n' +
'        \'<span class="file-size">\' + formatKB(file.size) + \'</span>\' +\n' +
'        \'<button class="btn btn-sm btn-danger" data-index="\' + index + \'">Remove</button>\' +\n' +
'      \'</div>\';\n' +
'      li.querySelector("button").onclick = function(){ selectedFiles.splice(index, 1); updateFileList(); };\n' +
'      fileListEl.appendChild(li);\n' +
'    });\n' +
'    checkFormValid();\n' +
'  }\n' +
'\n' +
'  form.addEventListener("submit", async function(e){\n' +
'    e.preventDefault(); submitBtn.disabled = true; submitBtn.innerText = "Processing...";\n' +
'    const fd = new FormData(); fd.append("apiKey", apiKeyInput.value); fd.append("model", modelSelect.value);\n' +
'    selectedFiles.forEach(function(f){ fd.append("files", f); });\n' +
'    try { const res = await fetch("/process", { method: "POST", body: fd }); const data = await res.json(); window.location = "/results?sessionId=" + data.sessionId; }\n' +
'    catch (err) { alert("Submission failed: " + err.message); submitBtn.disabled = false; submitBtn.innerText = "Start Screening"; }\n' +
'  });\n' +
'\n' +
'  jsonFileInput.addEventListener("change", function(){ jsonBtn.disabled = !jsonFileInput.files.length; });\n' +
'  jsonForm.addEventListener("submit", async function(e){ e.preventDefault(); jsonBtn.disabled = true; jsonBtn.innerText = "Loading..."; const fd = new FormData(); fd.append("jsonFile", jsonFileInput.files[0]); try { const res = await fetch("/visualize-json", { method: "POST", body: fd }); const data = await res.json(); window.location = "/results?sessionId=" + data.sessionId; } catch (err) { alert("JSON upload failed: " + err.message); jsonBtn.disabled = false; jsonBtn.innerText = "Visualize JSON"; } });\n' +
'\n' +
'  async function loadSample(filename) { try { const res = await fetch("/visualize-sample?file=" + encodeURIComponent(filename)); const data = await res.json(); window.location = "/results?sessionId=" + data.sessionId; } catch (err) { alert("Failed to load sample: " + err.message); } }\n' +
'  window.loadSample = loadSample;\n' +
'  // --- Patch: Make \"Explore Profile Overview\" stand left of other buttons (Ejnar only) ---\\n' +
'  try {\\n' +
'    document.addEventListener(\\"DOMContentLoaded\\", function(){\\n' +
'      var list = document.querySelectorAll(\\"#samples .list-group-item\\");\\n' +
'      var ejnarRow = Array.prototype.find && Array.prototype.find.call(list, function(li){ return li.textContent.indexOf(\\"Ejnar H\\") !== -1; }) || null;\\n' +
'      if (ejnarRow) {\\n' +
'        var exploreBtn = ejnarRow.querySelector(\\"a.btn.btn-sm.btn-success\\");\\n' +
'        if (exploreBtn) {\\n' +
'          var btnBox = exploreBtn.parentElement;\\n' +
'          if (btnBox) {\\n' +
'            btnBox.classList.add(\\"d-flex\\", \\\"align-items-center\\\");\\n' +
'            var cluster = document.createElement(\\"div\\");\\n' +
'            cluster.className = \\\"d-inline-flex align-items-center ms-3\\\";\\n' +
'            var children = Array.prototype.slice.call(btnBox.children);\\n' +
'            for (var i=0; i<children.length; i++){ if (children[i] !== exploreBtn) { cluster.appendChild(children[i]); } }\\n' +
'            while (btnBox.firstChild) { btnBox.removeChild(btnBox.firstChild); }\\n' +
'            btnBox.appendChild(exploreBtn);\\n' +
'            btnBox.appendChild(cluster);\\n' +
'          }\\n' +
'        }\\n' +
'      }\\n' +
'    });\\n' +
'  } catch (e) {}\\n' +
'  // --- End patch ---\\n' +
'</script>\n' +
'<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>\n' +
'</body></html>'
  );
});

/* ------------------------------ JSON Visualize ------------------------------ */
app.post("/visualize-json", upload.single("jsonFile", 1), (req, res) => {
  const sessionId = uuidv4();
  const emitter = new EventEmitter();
  sessions.set(sessionId, { emitter, logs: [], results: null });
  try {
    const p = req.file.path;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    fs.unlinkSync(p);
    const s = sessions.get(sessionId);
    s.logs.push("Loaded JSON for visualization.");
    s.results = data;
    s.emitter.emit("log", "JSON parsed successfully.");
    s.emitter.emit("done", data);
    res.json({ sessionId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------- Samples --------------------------------- */
app.get("/visualize-sample", (req, res) => {
  const filename = req.query.file;
  const jsonPath = path.join(__dirname, "public", "samples", filename || "");
  try {
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const nameMap = {"ejnar.json":"Ejnar Håkonsen","Percy-Liang-results.json":"Percy Liang (Public CV)","turing results.json":"Young Turing (modern equivalent)","Kahneman-results.json":"Pre-Nobel Kahneman (modern equivalent)","practitioner-innovator-results.json":"Practitioner-Innovator","modernPolymath-results.json":"Modern Polymath","nobelTrajectory-results.json":"Nobel-Trajectory Physicist","liu-results.json":"Researcher at Priority Review Threshold","park-results.json":"Solid Researcher Below Threshold"};
    const wrapped = Object.assign({ _sample_meta: { name: nameMap[filename] || filename } }, jsonData);
    const sessionId = uuidv4();
    const emitter = new EventEmitter();
    sessions.set(sessionId, { emitter, logs: ["Loading sample JSON..."], results: wrapped });
    const s = sessions.get(sessionId);
    s.logs.push("Sample loaded successfully.");
    s.emitter.emit("log", "Sample loaded successfully.");
    s.emitter.emit("done", jsonData);
    res.json({ sessionId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------- Process API -------------------------------- */
app.post("/process", upload.array("files", 20), (req, res) => {
  const sessionId = uuidv4();
  const emitter = new EventEmitter();
  sessions.set(sessionId, { emitter, logs: [], results: null });
  res.json({ sessionId });
  processCandidate(req, sessionId).catch(err => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.logs.push(`Fatal error: ${err.message}`);
    s.emitter.emit("log", `Fatal error: ${err.message}`);
    s.emitter.emit("done", { error: err.message });
  });
});

/* -------------------------------- Pipeline --------------------------------- */
async function processCandidate(req, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const { emitter } = session;

  const apiKey = req.body.apiKey;
  const model = req.body.model || "claude-4-opus-20250514";
  const uploads = req.files || [];

  emitter.emit("log", `Received API key: ${!!apiKey}`);
  emitter.emit("log", `Received files: ${uploads.length}`);
  emitter.emit("log", "Starting processing...");

  if (!apiKey || uploads.length === 0) {
    emitter.emit("done", { error: "API key and files required." });
    return;
  }

  const anthropic = new Anthropic({ apiKey });

  // Expand ZIPs
  const files = [];
  for (const file of uploads) {
    const lower = (file.originalname || "").toLowerCase();
    if (lower.endsWith(".zip") && AdmZip) {
      try {
        const zip = new AdmZip(file.path);
        const entries = zip.getEntries();
        let added = 0;
        for (const e of entries) {
          if (added >= 100) { emitter.emit("log", "ZIP file limit reached (100 entries)"); break; }
          if (e.isDirectory) continue;
          const inner = e.entryName;
          const l = inner.toLowerCase();
          const buf = e.getData();
          const ok =
            l.endsWith(".pdf") || l.endsWith(".txt") || l.endsWith(".md") ||
            l.endsWith(".json") || l.endsWith(".csv") || l.endsWith(".html") ||
            l.endsWith(".css") || l.endsWith(".js") || l.endsWith(".ts") ||
            l.endsWith(".docx") || l.endsWith(".png") || l.endsWith(".jpg") ||
            l.endsWith(".jpeg") || l.endsWith(".webp");
          if (!ok) continue;
          const tmp = path.join("/tmp", uuidv4());
          fs.writeFileSync(tmp, buf);
          files.push({ ...file, path: tmp, originalname: `[ZIP] ${file.originalname} :: ${inner}`, mimetype: guessMime(l) });
          added++;
        }
        emitter.emit("log", `Expanded ZIP ${file.originalname} → total items: ${files.length}`);
      } catch (err) {
        emitter.emit("log", `Failed to read ZIP ${file.originalname}: ${err.message}`);
        files.push(file); // fallback
      } finally { try { fs.unlinkSync(file.path); } catch {} }
    } else {
      files.push(file);
    }
  }

  // Parse → { name, type, text, images[], meta? }
  const processedFiles = await Promise.all(files.map(async f => {
    try {
      const d = await readFileData(f, emitter);
      try { fs.unlinkSync(f.path); } catch {}
      emitter.emit("log", `Processed file: ${f.originalname}`);
      return { name: f.originalname, type: f.mimetype, text: d.text, images: d.images || [], meta: d.meta || {} };
    } catch (err) {
      emitter.emit("log", `Error processing ${f.originalname}: ${err.message}`);
      try { fs.unlinkSync(f.path); } catch {}
      return null;
    }
  })).then(r => r.filter(Boolean));

  if (!processedFiles.length) {
    emitter.emit("done", { error: "No files processed successfully." });
    return;
  }

  const stageResults = {};
  let accumulatedProfile = "";

  /* -------------------------------- Stage 1 -------------------------------- */
  emitter.emit("log", "Stage 1: Material Intake & Domain Identification");
  const stage1MaterialsText = processedFiles
    .map(f => `File: ${f.name}\nContent: ${(f.text || "").slice(0, 10000)}...`)
    .join("\n\n");
  const st1Template = loadPromptFile("stage1.txt");
  const st1Fallback = (
`You are screening candidate materials for Anthropic. Catalog all uploaded files and identify assessment domains.

[FILES BELOW]
${stage1MaterialsText}`
  ).trim();
  const stage1Prompt = st1Template
    ? ensureInjected(st1Template, "materials", stage1MaterialsText, "Materials:", emitter, "stage1")
    : st1Fallback;
  const stage1Images = collectImages(processedFiles, STAGE1_MAX_IMAGES);
  stageResults[1] = await callClaudeMM(anthropic, model, stage1Prompt, stage1Images, emitter);
  emitter.emit("log", `Stage 1 completed. (images: ${stage1Images.length})`);

  // Identify "core" vs "portfolio"
  const coreFiles = processedFiles.filter(f =>
    f.name.toLowerCase().includes("resume") || f.name.toLowerCase().includes("cv") || f.name.toLowerCase().includes("cover")
  );
  const portfolioFiles = processedFiles.filter(f => !coreFiles.includes(f));
  emitter.emit("log", `Detected ${coreFiles.length} core files, ${portfolioFiles.length} portfolio files.`);

  /* -------------------------------- Stage 2A -------------------------------- */
  emitter.emit("log", "Stage 2A: Initial Profile with Expert Persona (recalibrated scoring)");
  const coreContent = coreFiles.map(f => `${f.name}:\n${f.text || ""}`).join("\n\n");
  const st2aTemplate = loadPromptFile("stage2a.txt");
  const st2aFallback = (
`Adopt expert personas based on identified domains from Stage 1 (v5 calibration: zero baseline; only exceptional earns points).

[STAGE 1 OUTPUT]
${stageResults[1]}

Analyze this resume/CV with TRANSFORMATIVE VALUE DISCOVERY and v5 scoring bands.

[CORE CONTENT]
${coreContent}`
  ).trim();
  const stage2APrompt = st2aTemplate
    ? ensureInjected(st2aTemplate, "core_content", coreContent, "Content:", emitter, "stage2a")
    : st2aFallback;
  const stage2AImages = collectImages(coreFiles, Math.min(3, STAGE1_MAX_IMAGES));
  const st2aOut = await callClaudeMM(anthropic, model, stage2APrompt, stage2AImages, emitter);
  stageResults[2] = stageResults[2] || {};
  stageResults[2].initialProfile = st2aOut;
  accumulatedProfile = st2aOut;

  /* -------------------------------- Stage 2B -------------------------------- */
  emitter.emit("log", "Stage 2B: Sequential Portfolio Analysis (transformative-only scoring)");
  stageResults[2].portfolioAnalyses = [];

  for (let i = 0; i < portfolioFiles.length; i++) {
    const file = portfolioFiles[i];

    const isImgDomPdf = file.meta && file.meta.isImageDominant && file.meta.pdfBuffer;
    let analysisCombined = "";

    if (isImgDomPdf) {
      const totalPages = Math.min(file.meta.pageCount || IMAGE_PDF_MAX_PAGES, IMAGE_PDF_MAX_PAGES);
      emitter.emit("log", `Image-dominant PDF: sweeping ${file.name} up to ${totalPages} pages (batches of ${IMAGE_PDF_BATCH_PAGES}).`);
      for (let start = 1; start <= totalPages; start += IMAGE_PDF_BATCH_PAGES) {
        const count = Math.min(IMAGE_PDF_BATCH_PAGES, totalPages - start + 1);
        const batchImages = await renderPdfPagesToImages(file.meta.pdfBuffer, start, count, IMAGE_MAX_DIM);

        const st2bTemplate = loadPromptFile("stage2b.txt");
        const header = `\n\n[Analyzing "${file.name}" pages ${start}-${start + count - 1}]`;
        const st2bFallback = (
`Continue with expert personas and v5 calibrated scoring (zero baseline; high bar).

${header}

Analyze these pages for TRANSFORMATIVE signals only; update tracking of exceptional dimensions (>=4 points), vital marker exceptions (rare bonuses or deficiencies), and true synergies.

Profile so far:
${accumulatedProfile}`
        ).trim();
        const prompt = st2bTemplate
          ? interpolate(st2bTemplate, {
              accumulated_profile: accumulatedProfile,
              item_name: `${file.name} (pages ${start}-${start + count - 1})`,
              item_content: (file.text || "").slice(0, 2000),
            })
          : st2bFallback;

        const partial = await callClaudeMM(anthropic, model, prompt, batchImages, emitter);
        analysisCombined += (analysisCombined ? "\n\n" : "") + partial;
        accumulatedProfile = (accumulatedProfile + "\n" + partial).trim();
      }
    } else {
      const st2bTemplate = loadPromptFile("stage2b.txt");
      const st2bFallback = (
`Continue with expert personas and v5 calibrated scoring (zero baseline).

Now analyze this specific item: ${file.name}

- TRANSFORMATIVE ONLY: breakthrough detection & high-bar synergies
- Vital markers: only innovative positives or below-baseline negatives

Profile so far:
${accumulatedProfile}

Content:
${file.text || ""}`
      ).trim();

      const stage2BPrompt = st2bTemplate
        ? interpolate(st2bTemplate, {
            accumulated_profile: accumulatedProfile,
            item_name: file.name,
            item_content: file.text || "",
          })
        : st2bFallback;

      const itemImages = collectImages([file], STAGE2B_MAX_IMAGES);
      const analysis = await callClaudeMM(anthropic, model, stage2BPrompt, itemImages, emitter);
      analysisCombined = analysis;
      accumulatedProfile = (accumulatedProfile + "\n" + analysis).trim();
    }

    stageResults[2].portfolioAnalyses.push({ file: file.name, analysis: analysisCombined });

    if ((i + 1) % 3 === 0) {
      emitter.emit("log", "Stage 2C synthesis checkpoint");
      const st2cTemplate = loadPromptFile("stage2c.txt");
      const st2cFallback = (
`Perform v5 synthesis with baseline validation (typical strong candidates score low). Summarize only truly exceptional dimensions (>=4 points), true synergies, and whether the candidate exceeds typical baselines.

Profile so far:
${accumulatedProfile}`
      ).trim();
      const st2cPrompt = st2cTemplate
        ? ensureInjected(st2cTemplate, "accumulated_profile", accumulatedProfile, "Profile so far:", emitter, "stage2c")
        : st2cFallback;

      const synthOut = await callClaudeMM(anthropic, model, st2cPrompt, [], emitter);
      stageResults[2].syntheses = stageResults[2].syntheses || [];
      stageResults[2].syntheses.push(synthOut);
      accumulatedProfile = (accumulatedProfile + "\n" + synthOut).trim();
    }
  }

  /* -------------------------------- Stage 3 -------------------------------- */
  emitter.emit("log", "Stage 3: Vital Marker Assessment");
  const st3Template = loadPromptFile("stage3.txt");
  const st3Fallback = (
`Using accumulated evidence, assess vital markers with v5 baselines (table stakes = 0; deficiencies penalize; exceptional demonstrations rare positive points).

Accumulated profile and tracking notes:
${accumulatedProfile}`
  ).trim();
  const stage3Prompt = st3Template
    ? ensureInjected(st3Template, "full_profile", accumulatedProfile, "Full profile:", emitter, "stage3")
    : st3Fallback;
  stageResults[3] = await callClaudeMM(anthropic, model, stage3Prompt, [], emitter);
  accumulatedProfile = (accumulatedProfile + "\n" + stageResults[3]).trim();

  /* -------------------------------- Stage 4 -------------------------------- */
  emitter.emit("log", "Stage 4: Final Synthesis & Structured Output (v5 JSON)");
  const st4Template = loadPromptFile("stage4.txt");
  const analysisJson = JSON.stringify(stageResults, null, 2);
  const st4Fallback = (
`Generate the final v5 structured JSON exactly as specified in the schema.
Return ONLY valid JSON (no markdown fences, no commentary).

[ACCUMULATED ANALYSIS JSON CONTEXT]
${analysisJson}`
  ).trim();
  const stage4Prompt = st4Template
    ? interpolate(st4Template, { analysis_json: analysisJson })
    : st4Fallback;

  const stage4Raw = await callClaudeMM(anthropic, model, stage4Prompt, [], emitter);

  // Try to parse JSON (even if it's embedded inside text/fences)
  const parsed = tryParseJson(stage4Raw);
  if (!parsed) {
    emitter.emit("log", "Stage 4 output not valid JSON; storing under 'stage4_raw'.");
    stageResults[4] = { stage4_raw: stage4Raw };
  } else {
    stageResults[4] = parsed;
  }

  session.results = stageResults;
  emitter.emit("log", "Processing complete.");
  emitter.emit("done", stageResults);

  setTimeout(() => sessions.delete(sessionId), 10 * 60 * 1000);
}

/* ----------------------------------- SSE ----------------------------------- */
app.get("/progress/:sessionId", (req, res) => {
  const id = req.params.sessionId;
  const session = sessions.get(id);
  if (!session) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  (session.logs || []).forEach(l => send("log", l));

  if (session.results != null) { send("done", session.results); return; }

  const onLog = (l) => send("log", l);
  const onDone = (r) => { send("done", r); res.end(); };
  session.emitter.on("log", onLog);
  session.emitter.on("done", onDone);

  req.on("close", () => {
    session.emitter.off("log", onLog);
    session.emitter.off("done", onDone);
  });
});

/* --------------------------------- Results --------------------------------- */
app.get("/results", (req, res) => {
  const sessionId = req.query.sessionId || "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
'<!DOCTYPE html>\n' +
'<html lang="en"><head>\n' +
'<meta charset="UTF-8"/>\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0"/>\n' +
'<title>Screening Results</title>\n' +
'<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"/>\n' +
'<style>.kv { white-space: pre-wrap; }</style>\n' +
'</head>\n' +
'<body class="bg-light">\n' +
'<div class="container mt-5">\n' +
'  <div class="card shadow">\n' +
'    <div class="card-body">\n' +
'      <h3 id="processingHeader" class="card-title mb-4">Processing in Progress</h3>\n' +
'\n' +
'      <div class="accordion mb-4" id="logAccordion">\n' +
'        <div class="accordion-item">\n' +
'          <h2 class="accordion-header">\n' +
'            <button class="accordion-button" id="logToggle" type="button" data-bs-toggle="collapse" data-bs-target="#logCollapse">\n' +
'              Live Processing Logs\n' +
'            </button>\n' +
'          </h2>\n' +
'          <div id="logCollapse" class="accordion-collapse collapse show">\n' +
'            <div class="accordion-body">\n' +
'              <ul id="logList" class="list-group"></ul>\n' +
'            </div>\n' +
'          </div>\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div id="resultsOverview" style="display:none;"></div>\n' +
'      <a id="downloadLink" style="display:none;" class="btn btn-outline-primary mb-3" download="results.json">Download JSON</a>\n' +
'      <a href="/" class="btn btn-secondary mt-3">Back to Form</a>\n' +
'    </div>\n' +
'  </div>\n' +
'</div>\n' +
'\n' +
'<script>\n' +
'  const es = new EventSource("/progress/' + sessionId.replace(/"/g, '\\"') + '");\n' +
'  const logList = document.getElementById("logList");\n' +
'  const logCollapse = document.getElementById("logCollapse");\n' +
'  const processingHeader = document.getElementById("processingHeader");\n' +
'  const resultsOverview = document.getElementById("resultsOverview");\n' +
'  const downloadLink = document.getElementById("downloadLink");\n' +
'\n' +
'  es.addEventListener("log", function(e){\n' +
'    const li = document.createElement("li");\n' +
'    li.className = "list-group-item";\n' +
'    li.textContent = JSON.parse(e.data);\n' +
'    logList.appendChild(li);\n' +
'    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });\n' +
'  });\n' +
'\n' +
'  es.addEventListener("done", function(e){\n' +
'    const results = JSON.parse(e.data);\n' +
'    if (results.error) {\n' +
'      const li = document.createElement("li");\n' +
'      li.className = "list-group-item list-group-item-danger";\n' +
'      li.textContent = results.error;\n' +
'      logList.appendChild(li);\n' +
'    } else {\n' +
'      processingHeader.textContent = (results && results._sample_meta && results._sample_meta.name) ? "Results — " + results._sample_meta.name : "Results";\n' +
'      const bsCollapse = new bootstrap.Collapse(logCollapse, { toggle: false });\n' +
'      bsCollapse.hide();\n' +
'      renderResults(results);\n' +
'      // Inject name into the single results header and top title\n' +
'      try {\n' +
'        const dn = (results && results._sample_meta && results._sample_meta.name) || results.candidate_name || (results.executive_summary && results.executive_summary.candidate_name) || "";\n' +
'        if (dn) {\n' +
'          const h4 = resultsOverview.querySelector("h4");\n' +
'          if (h4 && !/—\s*.+$/.test(h4.textContent)) { h4.textContent = h4.textContent + " — " + dn; }\n' +
'          processingHeader.textContent = h4 ? (h4.textContent) : ("Results Overview — " + dn);\n' +
'        }\n' +
'      } catch(e) {}\n' +
'      const jsonStr = JSON.stringify(results, null, 2);\n' +
'      downloadLink.href = "data:text/json;charset=utf-8," + encodeURIComponent(jsonStr);\n' +
'      downloadLink.style.display = "inline-block";\n' +
'      resultsOverview.scrollIntoView({ behavior: "smooth", block: "start" });\n' +
'    }\n' +
'    es.close();\n' +
'  });\n' +
'\n' +
'  function renderResults(data) {\n' +
'    resultsOverview.style.display = "block";\n' +
'    let v5 = null, v3 = null;\n' +
'\n' +
'    if (data && data.transformative_value_only && data.vital_marker_assessment) v5 = data;\n' +
'    else if (data && data["4"] && typeof data["4"] === "object" && data["4"].transformative_value_only) v5 = data["4"];\n' +
'    else if (data && data[4] && typeof data[4] === "object" && data[4].transformative_value_only) v5 = data[4];\n' +
'\n' +
'    if (!v5) {\n' +
'      if (data && data["4"] && data["4"].stage4_raw) v5 = tryExtractV5FromRaw(data["4"].stage4_raw);\n' +
'      else if (data && data[4] && data[4].stage4_raw) v5 = tryExtractV5FromRaw(data[4].stage4_raw);\n' +
'    }\n' +
'\n' +
'    if (!v5) {\n' +
'      if (data && data.complete_value_breakdown && data.vital_markers) v3 = data;\n' +
'      else if (data && data["4"] && data["4"].complete_value_breakdown) v3 = data["4"];\n' +
'      else if (data && data[4] && data[4].complete_value_breakdown) v3 = data[4];\n' +
'    }\n' +
'\n' +
'    if (v5) return renderV5(v5, data);\n' +
'    if (v3) return renderV3(v3, data);\n' +
'\n' +
'    resultsOverview.innerHTML = \'<div class="alert alert-warning">No recognized results to visualize.</div>\';\n' +
'  }\n' +
'\n' +
'  function tryExtractV5FromRaw(s) {\n' +
'    if (!s) return null; const txt = String(s);\n' +
'    // 1) fenced JSON\n' +
'    let start = txt.indexOf("```json");\n' +
'    if (start !== -1) {\n' +
'      start = txt.indexOf("\\n", start);\n' +
'      if (start !== -1) {\n' +
'        let end = txt.indexOf("```", start + 1);\n' +
'        if (end !== -1) {\n' +
'          const json = txt.slice(start + 1, end);\n' +
'          try { const obj = JSON.parse(json); if (obj && obj.transformative_value_only) return obj; } catch {}\n' +
'        }\n' +
'      }\n' +
'    }\n' +
'    // 2) first { ... } block\n' +
'    const first = txt.indexOf("{"); const last = txt.lastIndexOf("}");\n' +
'    if (first !== -1 && last !== -1 && last > first) {\n' +
'      const json2 = txt.slice(first, last + 1);\n' +
'      try { const obj2 = JSON.parse(json2); if (obj2 && obj2.transformative_value_only) return obj2; } catch {}\n' +
'    }\n' +
'    // fallback: show raw\n' +
'    resultsOverview.innerHTML = \'<div class="alert alert-info">Stage 4 returned narrative with embedded JSON. Showing raw.</div><pre class="kv">\' + escapeHtml(txt) + \'</pre>\';\n' +
'    return null;\n' +
'  }\n' +
'\n' +
'  function accItem(id, title, bodyHtml, expanded) {\n' +
'    return (\n' +
'      \'<div class="accordion-item">\' +\n' +
'        \'<h2 class="accordion-header">\' +\n' +
'          \'<button class="accordion-button \' + (expanded ? "" : "collapsed") + \'" type="button" data-bs-toggle="collapse" data-bs-target="#c_\' + id + \'">\' + title + \'</button>\' +\n' +
'        \'</h2>\' +\n' +
'        \'<div id="c_\' + id + \'" class="accordion-collapse collapse \' + (expanded ? "show" : "") + \'">\' +\n' +
'          \'<div class="accordion-body">\' + bodyHtml + \'</div>\' +\n' +
'        \'</div>\' +\n' +
'      \'</div>\'\n' +
'    );\n' +
'  }\n' +
'\n' +
'  function safe(v){ return (v == null ? "N/A" : String(v)); }\n' +
'  function escapeHtml(s){ return String(s || "").replace(/[&<>\"\\\']/g, function(c){ return ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\\\'":"&#39;" })[c]; }); }\n' +
'\n' +
'  /* ---------------------------- v5 Renderer ---------------------------- */\n' +
'  function renderV5(obj, rawAll, displayName) {\n' +
'    const s = obj.scoring_summary || {};\n' +
'    const tv = obj.transformative_value_only || {};\n' +
'    const vma = obj.vital_marker_assessment || {};\n' +
'    const bc = obj.baseline_comparison || {};\n' +
'    const exec = obj.executive_summary || {};\n' +
'    const validation = obj.validation_report || {};\n' +
'\n' +
'    let html = "";\n' +
'    html += \'<h4 class="mb-3">Results Overview (v5)</h4>\';\n' +
'    html += \'<div class="d-flex flex-wrap gap-2 mb-3">\' +\n' +
'              \'<span class="badge bg-primary">Risk: \' + safe(s.risk_score) + \'</span>\' +\n' +
'              \'<span class="badge bg-secondary">Confidence: \' + safe(s.confidence_percentage) + \'%</span>\' +\n' +
'              \'<span class="badge bg-info text-dark">Urgency: \' + safe(s.urgency) + \'</span>\' +\n' +
'              \'<span class="badge bg-success">Recommendation: \' + safe(s.recommendation) + \'</span>\' +\n' +
'            \'</div>\';\n' +
'\n' +
'    html += \'<table class="table table-striped mb-4"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>\' +\n' +
'              row("Risk Score (0-100)", s.risk_score) +\n' +
'              row("Raw Score", s.raw_score) +\n' +
'              row("Exceeds Anthropic’s Baseline By", s.exceeds_baseline_by) +\n' +
'              row("Threshold Context", s.threshold_context) +\n' +
'              row("Confidence %", s.confidence_percentage == null ? "N/A" : s.confidence_percentage + "%") +\n' +
'              row("Urgency (0-10)", s.urgency) +\n' +
'              row("Recommendation", s.recommendation) +\n' +
'            \'</tbody></table>\';\n' +
'\n' +
'    html += \'<div class="accordion" id="acc">\';\n' +
'\n' +
'    html += accItem("exec", "Executive Summary",\n' +
'      \'<div><strong>Summary:</strong><br>\' + escapeHtml(exec.one_paragraph || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Key Breakthrough:</strong><br>\' + escapeHtml(exec.key_breakthrough || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Why Transformative:</strong><br>\' + escapeHtml(exec.why_transformative || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Recommendation:</strong> \' + escapeHtml(exec.recommendation || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Decision Rationale:</strong><br>\' + escapeHtml(exec.decision_rationale || "N/A") + \'</div>\' +\n' +
'      (exec.pass_rationale ? \'<div class="mt-2"><strong>Pass Rationale:</strong><br>\' + escapeHtml(exec.pass_rationale) + \'</div>\' : ""),\n' +
'      true\n' +
'    );\n' +
'\n' +
'    html += accItem("tv", "Transformative Value (Exceptional Only)", renderV5Value(tv), true);\n' +
'    html += accItem("vma", "Vital Marker Assessment (Baselines & Exceptions)", renderV5VMA(vma), false);\n' +
'    html += accItem("bc", "Baseline Comparison", renderV5Baseline(bc), false);\n' +
'    html += accItem("validation", "Validation Report", \'<pre class="kv">\'+ escapeHtml(JSON.stringify(validation, null, 2)) +\'</pre>\', false);\n' +
'    html += accItem("raw", "Full Raw Details (All Stages JSON)", \'<pre class="kv">\'+ escapeHtml(JSON.stringify(rawAll, null, 2)) +\'</pre>\', false);\n' +
'\n' +
'    html += "</div>";\n' +
'    resultsOverview.innerHTML = html;\n' +
'\n' +
'    function row(k, v){ return "<tr><td>" + escapeHtml(k) + "</td><td>" + escapeHtml(safe(v)) + "</td></tr>"; }\n' +
'  }\n' +
'\n' +
'  function renderV5Value(tv){\n' +
'    let html = "";\n' +
'    const dims = (tv.breakthrough_dimensions || []);\n' +
'    if (dims.length) {\n' +
'      html += \'<h6>Breakthrough Dimensions (score ≥ 4)</h6>\';\n' +
'      html += \'<div class="table-responsive"><table class="table table-striped table-sm"><thead><tr><th>Dimension</th><th>Score</th><th>Evidence</th><th>Why Transformative</th></tr></thead><tbody>\';\n' +
'      for (const d of dims) { html += \'<tr><td>\' + escapeHtml(d.dimension || "") + \'</td><td>\' + escapeHtml(String(d.score ?? "")) + \'</td><td class="kv">\'+ escapeHtml(d.evidence || "") +\'</td><td class="kv">\'+ escapeHtml(d.why_transformative || "") +\'</td></tr>\'; }\n' +
'      html += "</tbody></table></div>";\n' +
'    }\n' +
'    const syn = (tv.synergy_breakthroughs || []);\n' +
'    if (syn.length) {\n' +
'      html += \'<h6 class="mt-3">Synergy Breakthroughs</h6><ul>\';\n' +
'      for (const s of syn) { html += \'<li><strong>\' + escapeHtml(s.combination || "") + \':</strong> \' + escapeHtml(s.breakthrough_enabled || "") + \' (+\' + escapeHtml(String(s.points ?? "")) + \')</li>\'; }\n' +
'      html += "</ul>";\n' +
'    }\n' +
'    if (tv.total_exceptional_points != null) { html += \'<div class="mt-2"><strong>Total Exceptional Points:</strong> \'+ escapeHtml(String(tv.total_exceptional_points)) +\'</div>\'; }\n' +
'    return html || "<em>No transformative dimensions provided.</em>";\n' +
'  }\n' +
'\n' +
'  function renderV5VMA(vma){\n' +
'    let html = "";\n' +
'    const base = vma.baseline_met || {};\n' +
'    html += \'<h6>Baseline Met</h6>\';\n' +
'    html += \'<table class="table table-sm table-bordered"><thead><tr><th>Area</th><th>Meets Baseline?</th></tr></thead><tbody>\' +\n' +
'            \'<tr><td>Safety Awareness</td><td>\' + escapeHtml(String(base.safety_awareness ?? "")) + \'</td></tr>\' +\n' +
'            \'<tr><td>Epistemic Rigor</td><td>\' + escapeHtml(String(base.epistemic_rigor ?? "")) + \'</td></tr>\' +\n' +
'            \'<tr><td>Ethical Alignment</td><td>\' + escapeHtml(String(base.ethical_alignment ?? "")) + \'</td></tr>\' +\n' +
'            "</tbody></table>";\n' +
'\n' +
'    const penalties = vma.penalties_applied || [];\n' +
'    if (penalties.length) { html += \'<h6 class="mt-3">Penalties Applied</h6><ul>\'; for (const p of penalties) html += \'<li>\' + escapeHtml(p.issue || "") + \' ( \' + escapeHtml(String(p.penalty ?? "")) + \' )</li>\'; html += "</ul>"; }\n' +
'\n' +
'    const exc = vma.exceptional_contributions || [];\n' +
'    if (exc.length) { html += \'<h6 class="mt-3">Exceptional Contributions (rare)</h6><ul>\'; for (const x of exc) { html += \'<li><strong>\' + escapeHtml(x.area || "") + \':</strong> \' + escapeHtml(x.innovation || "") + \' (+\' + escapeHtml(String(x.points ?? "")) + \')</li>\'; } html += "</ul>"; }\n' +
'    return html;\n' +
'  }\n' +
'\n' +
'  function renderV5Baseline(bc){\n' +
'    let html = "";\n' +
'    html += \'<table class="table table-sm table-bordered"><tbody>\';\n' +
'    html += \'<tr><td>Typical Strong Candidate Score</td><td>\' + escapeHtml(String(bc.typical_strong_candidate_score ?? "")) + \'</td></tr>\';\n' +
'    html += \'<tr><td>This Candidate Score</td><td>\' + escapeHtml(String(bc.this_candidate_score ?? "")) + \'</td></tr>\';\n' +
'    html += \'<tr><td>Percentile Estimate</td><td>\' + escapeHtml(String(bc.percentile_estimate ?? "")) + \'</td></tr>\';\n' +
'    html += \'<tr><td>Hiring Pool Context</td><td>\' + escapeHtml(String(bc.hiring_pool_context ?? "")) + \'</td></tr>\';\n' +
'    html += "</tbody></table>";\n' +
'    return html;\n' +
'  }\n' +
'\n' +
'  /* ---------------------------- v3 Renderer ---------------------------- */\n' +
'  function renderV3(obj, rawAll, displayName) {\n' +
'    const s = obj.scoring_summary || {};\n' +
'    const vital = obj.vital_markers || {};\n' +
'    const breakdown = obj.complete_value_breakdown || {};\n' +
'    const strat = obj.strategic_assessment || {};\n' +
'    const exec = obj.executive_summary || {};\n' +
'    const validation = obj.validation_report || {};\n' +
'\n' +
'    let html = "";\n' +
'    html += \'<h4 class="mb-3">Results Overview (v3)</h4>\';\n' +
'    html += \'<div class="d-flex flex-wrap gap-2 mb-3">\'+\n' +
'              \'<span class="badge bg-primary">Risk: \' + (s.risk_score ?? "N/A") + \'</span>\' +\n' +
'              \'<span class="badge bg-secondary">Confidence: \' + (s.confidence_percentage ?? "N/A") + \'%</span>\' +\n' +
'              \'<span class="badge bg-info text-dark">Urgency: \' + (s.urgency ?? "N/A") + \'</span>\' +\n' +
'              \'<span class="badge bg-success">Culture Fit: \' + (s.culture_fit ?? "N/A") + \'</span>\' +\n' +
'              \'<span class="badge bg-dark">Dimensions: \' + (s.total_dimensions_evaluated ?? "N/A") + \'</span>\' +\n' +
'            \'</div>\';\n' +
'\n' +
'    html += \'<table class="table table-striped mb-4"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>\' +\n' +
'              \'<tr><td>Risk Score (0-100)</td><td>\' + (s.risk_score ?? "N/A") + \'</td></tr>\' +\n' +
'              \'<tr><td>Raw Score (uncapped)</td><td>\' + (s.raw_score ?? "N/A") + \'</td></tr>\' +\n' +
'              \'<tr><td>Confidence %</td><td>\' + (s.confidence_percentage ?? "N/A") + \'</td></tr>\' +\n' +
'              \'<tr><td>Urgency (0-10)</td><td>\' + (s.urgency ?? "N/A") + \'</td></tr>\' +\n' +
'              \'<tr><td>Culture Fit (0-10)</td><td>\' + (s.culture_fit ?? "N/A") + \'</td></tr>\' +\n' +
'              \'<tr><td>Total Dimensions</td><td>\' + (s.total_dimensions_evaluated ?? "N/A") + \'</td></tr>\' +\n' +
'            \'</tbody></table>\';\n' +
'\n' +
'    html += \'<div class="accordion" id="acc">\';\n' +
'    html += accItem("exec", "Executive Summary",\n' +
'      \'<div><strong>Summary:</strong><br>\' + escapeHtml(exec.one_paragraph || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Transformative Potential:</strong><br>\' + escapeHtml(exec.transformative_potential || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Primary Risks:</strong><br>\' + escapeHtml(exec.primary_risks || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Recommendation:</strong> \' + escapeHtml(exec.recommendation || "N/A") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Next Steps:</strong><br>\' + escapeHtml(exec.next_steps || "N/A") + \'</div>\',\n' +
'      true\n' +
'    );\n' +
'    html += accItem("vital", "Vital Markers", renderV3Vital(vital), true);\n' +
'    html += accItem("breakdown", "Complete Value Breakdown", renderV3Breakdown(breakdown), false);\n' +
'    html += accItem("strat", "Strategic Assessment",\n' +
'      \'<div><strong>Best Fit Roles:</strong><br>\' + escapeHtml((strat.best_fit_roles || []).join("\\n")) + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Unique Value Proposition:</strong><br>\' + escapeHtml(strat.unique_value_proposition || "") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Screener Level:</strong> \' + escapeHtml(strat.screener_level || "") + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Market Competition:</strong> \' + escapeHtml((strat.market_competition || []).join(", ")) + \'</div>\' +\n' +
'      \'<div class="mt-2"><strong>Timing Factors:</strong><br>\' + escapeHtml(strat.timing_factors || "") + \'</div>\',\n' +
'      false\n' +
'    );\n' +
'    html += accItem("validation", "Validation Report", \'<pre class="kv">\'+ escapeHtml(JSON.stringify(validation, null, 2)) +\'</pre>\', false);\n' +
'    html += accItem("raw", "Full Raw Details (All Stages JSON)", \'<pre class="kv">\'+ escapeHtml(JSON.stringify(rawAll, null, 2)) +\'</pre>\', false);\n' +
'    html += "</div>";\n' +
'    resultsOverview.innerHTML = html;\n' +
'  }\n' +
'\n' +
'  function renderV3Vital(v){\n' +
'    const rows = [];\n' +
'    function row(label, obj){ const score = (obj && obj.score != null) ? obj.score : "N/A"; const ev = (obj && obj.evidence_summary) ? obj.evidence_summary : ""; rows.push("<tr><td>"+escapeHtml(label)+"</td><td>"+escapeHtml(String(score))+"</td><td>"+escapeHtml(ev)+"</td></tr>"); }\n' +
'    row("Safety Mindset (-20 to +20)", v.safety_mindset);\n' +
'    row("Epistemic Rigor (-30 to +20)", v.epistemic_rigor);\n' +
'    row("Ethical Alignment (-40 to +20)", v.ethical_alignment);\n' +
'    let html = \'<table class="table table-sm table-bordered"><thead><tr><th>Marker</th><th>Score</th><th>Evidence Summary</th></tr></thead><tbody>\' + rows.join("") + \'</tbody></table>\';\n' +
'    return html;\n' +
'  }\n' +
'\n' +
'  function renderV3Breakdown(b){\n' +
'    let html = "";\n' +
'    const dims = (b.all_dimensions || []);\n' +
'    if (dims.length) {\n' +
'      html += \'<h6>All Dimensions (score ≥ 5)</h6>\';\n' +
'      html += \'<div class="table-responsive"><table class="table table-striped table-sm"><thead><tr><th>Dimension</th><th>Score</th><th>Evidence</th><th>Expert Note</th></tr></thead><tbody>\';\n' +
'      for (const d of dims) { html += \'<tr><td>\' + escapeHtml(d.dimension || "") + \'</td><td>\' + escapeHtml(String(d.score ?? "")) + \'</td><td class="kv">\'+ escapeHtml(d.evidence || "") +\'</td><td class="kv">\'+ escapeHtml(d.expert_note || "") +\'</td></tr>\'; }\n' +
'      html += "</tbody></table></div>";\n' +
'    }\n' +
'    const syn = (b.synergy_bonuses || []);\n' +
'    if (syn.length) { html += \'<h6 class="mt-3">Synergy Bonuses</h6><ul>\'; for (const s of syn) { html += \'<li><strong>\' + escapeHtml(s.combination || "") + \':</strong> +\' + escapeHtml(String(s.bonus_points ?? "")) + \' — \' + escapeHtml(s.impact || "") + \'</li>\'; } html += "</ul>"; }\n' +
'    if (b.polymath_bonus) { html += \'<h6 class="mt-3">Polymath Bonus</h6>\'; html += \'<div>Breath Score: \'+ escapeHtml(String(b.polymath_bonus.breadth_score ?? "")) +\'</div>\'; html += \'<div class="kv">Rationale: \'+ escapeHtml(b.polymath_bonus.rationale || "") +\'</div>\'; }\n' +
'    if (b.total_positive_points != null) { html += \'<div class="mt-2"><strong>Total Positive Points:</strong> \'+ escapeHtml(String(b.total_positive_points)) +\'</div>\'; }\n' +
'    return html || "<em>No transformative dimensions provided.</em>";\n' +
'  }\n' +
'</script>\n' +
'<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>\n' +
'</body></html>'
  );
});

/* --------------------------- Asset convenience --------------------------- */
app.get("/app.js", (req, res) => { res.download(path.join(__dirname, "app.js")); });

/* -------------------------- File read & model calls -------------------------- */
function guessMime(lower) {
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js")) return "application/javascript";
  if (lower.endsWith(".ts")) return "text/plain";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

// Return { text, images: [{media_type,data}], meta?: {isImageDominant,pageCount,pdfBuffer?} }
async function readFileData(file, emitter) {
  const lower = (file.originalname || "").toLowerCase();

  if (file.mimetype === "application/pdf" || lower.endsWith(".pdf")) {
    const buf = fs.readFileSync(file.path);
    const pdf = await pdfParse(buf);
    const text = (pdf.text || "").normalize("NFC");

    let pageCount = 0;
    if (pdfjsLib) { try { pageCount = await getPdfPageCount(buf); } catch {} }

    const charsPerPage = pageCount ? text.length / pageCount : text.length;
    const isImageDominant = pageCount > 0 && charsPerPage < IMAGE_PDF_TEXT_PER_PAGE_THRESHOLD;

    let images = [];
    if (pdfjsLib && createCanvas) {
      try {
        const preview = Math.min(PDF_PREVIEW_PAGES, Math.max(1, pageCount || PDF_PREVIEW_PAGES));
        images = await renderPdfPagesToImages(buf, 1, preview, IMAGE_MAX_DIM);
        emitter.emit("log", `Rendered PDF preview (${images.length}) for ${file.originalname}`);
      } catch (err) {
        emitter.emit("log", `PDF image render failed for ${file.originalname}: ${err.message}`);
      }
    } else {
      emitter.emit("log", "PDF image render unavailable (install 'pdfjs-dist' + '@napi-rs/canvas').");
    }

    const meta = { isImageDominant, pageCount };
    if (isImageDominant && buf.length <= MAX_PDF_BUFFER_BYTES) meta.pdfBuffer = buf;
    return { text, images, meta };
  }

  if (lower.endsWith(".docx")) {
    if (!mammoth) return { text: `DOCX file (${file.originalname}). Install 'mammoth' for text.`, images: [] };
    const buffer = fs.readFileSync(file.path);
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: (value || "").normalize("NFC"), images: [] };
  }

  if (file.mimetype.startsWith("image/")) {
    const part = await imageFileToClaudePart(file);
    return { text: `Image uploaded (${file.originalname}).`, images: part ? [part] : [] };
  }

  if (file.mimetype.startsWith("text/") ||
      lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".json") ||
      lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".py") ||
      lower.endsWith(".html") || lower.endsWith(".css") || lower.endsWith(".csv")) {
    const text = fs.readFileSync(file.path, "utf-8").normalize("NFC");
    return { text, images: [] };
  }

  if (lower.endsWith(".zip")) {
    return { text: `ZIP uploaded (${file.originalname}). Install 'adm-zip' to expand server-side.`, images: [] };
  }

  return { text: `Unsupported file type for ${file.originalname} (${file.mimetype}).`, images: [] };
}

async function getPdfPageCount(buffer) {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  return pdf.numPages || 0;
}

async function imageFileToClaudePart(file) {
  try {
    const buf = fs.readFileSync(file.path);
    const ext = (file.originalname || "").toLowerCase();
    const mt = ext.endsWith(".png") ? "image/png" : ext.endsWith(".webp") ? "image/webp" : "image/jpeg";

    if (loadImage && createCanvas) {
      const img = await loadImage(buf);
      const { w, h } = fitWithin(img.width, img.height, IMAGE_MAX_DIM);
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const base64 = dataUrl.split(",")[1];
      return { media_type: "image/jpeg", data: base64 };
    } else {
      if (buf.length <= RAW_IMAGE_SIZE_BYTES_LIMIT) return { media_type: mt, data: buf.toString("base64") };
      return null;
    }
  } catch { return null; }
}

function fitWithin(w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

async function renderPdfPagesToImages(pdfBuffer, startPage, count, maxDim) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
  const pdf = await loadingTask.promise;

  const CanvasFactory = {
    create: (w, h) => { const canvas = createCanvas(w, h); const context = canvas.getContext("2d"); return { canvas, context }; },
    reset: (cc, w, h) => { cc.canvas.width = w; cc.canvas.height = h; },
    destroy: (cc) => { cc.canvas.width = 0; cc.canvas.height = 0; },
  };

  const out = [];
  const endPage = Math.min(startPage + count - 1, pdf.numPages);
  for (let i = startPage; i <= endPage; i++) {
    const page = await pdf.getPage(i);
    const viewport0 = page.getViewport({ scale: 1.0 });
    const scale = Math.min(1, maxDim / Math.max(viewport0.width, viewport0.height));
    const viewport = page.getViewport({ scale });
    const { canvas, context } = CanvasFactory.create(viewport.width, viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    out.push({ media_type: "image/jpeg", data: dataUrl.split(",")[1] });
    CanvasFactory.destroy({ canvas, context });
  }
  return out;
}

function collectImages(fileList, limit) {
  const images = [];
  for (const f of fileList) {
    if (f.images && f.images.length) {
      for (const img of f.images) {
        images.push(img);
        if (images.length >= limit) return images;
      }
    }
  }
  return images;
}

// Model call (text + optional images)
async function callClaudeMM(anthropic, model, promptText, images, emitter) {
  try {
    const content = [{ type: "text", text: promptText }];
    if (images && images.length) {
      for (const img of images) {
        content.push({ type: "input_image", source: { type: "base64", media_type: img.media_type, data: img.data } });
      }
    }
    emitter.emit("log", `Calling model: ${model}${images && images.length ? " (with "+images.length+" image(s))" : ""}`);
    const resp = await anthropic.messages.create({
      model, max_tokens: 4000, temperature: 0.2,
      messages: [{ role: "user", content }],
    });
    const parts = (resp && resp.content) || [];
    const text = parts.map(p => (p && p.type === "text" && p.text) ? p.text : "").filter(Boolean).join("\n").trim();
    emitter.emit("log", `Model returned ${text.length} chars`);
    return text.normalize("NFC");
  } catch (err) {
    const msg = `Model call failed: ${err.message}`;
    emitter.emit("log", msg);
    return `ERROR: ${msg}`;
  }
}

// Smarter JSON extraction: fenced or first { ... } block
function tryParseJson(maybe) {
  if (!maybe) return null;
  let s = String(maybe).trim();

  // 1) Look for ```json ... ```
  let idx = s.indexOf("```json");
  if (idx !== -1) {
    const nl = s.indexOf("\n", idx);
    if (nl !== -1) {
      const end = s.indexOf("```", nl + 1);
      if (end !== -1) {
        const candidate = s.slice(nl + 1, end);
        try { return JSON.parse(candidate); } catch {}
      }
    }
  }
  // 2) Plain fences ```
  idx = s.indexOf("```");
  if (idx !== -1) {
    const nl = s.indexOf("\n", idx);
    if (nl !== -1) {
      const end = s.indexOf("```", nl + 1);
      if (end !== -1) {
        const candidate = s.slice(nl + 1, end);
        try { return JSON.parse(candidate); } catch {}
      }
    }
  }
  // 3) First { ... } block
  const first = s.indexOf("{"); const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = s.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  // 4) Nothing worked
  return null;
}

/* --------------------------------- Listen --------------------------------- */
app.listen(port, () => { console.log(`Server listening on http://localhost:${port}`); });
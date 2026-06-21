const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const CHROME_DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9224);
let chromeProcess = null;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(content);
  });
}

function extractPlayerResponse(html) {
  const marker = "ytInitialPlayerResponse = ";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  const end = html.indexOf(";</script>", jsonStart);
  if (end === -1) return null;
  const raw = html.slice(jsonStart, end);
  return JSON.parse(raw);
}

function extractInitialData(html) {
  const markers = ["var ytInitialData = ", "ytInitialData = "];
  for (const marker of markers) {
    const start = html.indexOf(marker);
    if (start === -1) continue;
    const jsonStart = start + marker.length;
    const end = html.indexOf(";</script>", jsonStart);
    if (end === -1) continue;
    return JSON.parse(html.slice(jsonStart, end));
  }
  return null;
}

function pickCaptionTrack(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return null;
  return tracks.find(track => track.languageCode === "ko") ||
    tracks.find(track => track.languageCode?.startsWith("ko")) ||
    tracks.find(track => track.kind === "asr") ||
    tracks[0];
}

function decodeXml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function transcriptFromJson3(data) {
  const lines = [];
  for (const event of data.events || []) {
    if (!event.segs) continue;
    const text = event.segs.map(seg => seg.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (text) {
      lines.push({
        startMs: event.tStartMs || 0,
        text
      });
    }
  }
  return lines;
}

function transcriptFromXml(xml) {
  const lines = [];
  const pattern = /<text[^>]*start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  for (const match of xml.matchAll(pattern)) {
    const startMs = Math.round(Number(match[1]) * 1000);
    const text = decodeXml(match[2]).replace(/\s+/g, " ").trim();
    if (text) lines.push({ startMs, text });
  }
  return lines;
}

function plainText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(" ");
  if (value.simpleText) return value.simpleText;
  if (value.text) return value.text;
  if (value.runs) return value.runs.map(run => run.text || "").join("");
  return "";
}

function normalizeProductText(value) {
  return String(value || "")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPriceText(value) {
  return normalizeProductText(value).match(/₩\s?[\d,]+|[\d,]+\s?원/)?.[0] || "";
}

function extractPriceAmount(value) {
  const priceText = extractPriceText(value);
  const amount = Number(priceText.replace(/[^\d]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function isLikelyProductPrice(value) {
  return extractPriceAmount(value) >= 1000;
}

function isLikelyProductTitle(value) {
  const text = normalizeProductText(value);
  if (text.length < 2 || text.length > 90) return false;
  if (!/[가-힣A-Za-z0-9]/.test(text)) return false;
  if (/자세히|알아보기|구매|장바구니|광고|제품|수수료|태그|youtube|http|www\.|₩|원$|KRW/i.test(text)) return false;
  if (/취소|확인|답글|댓글|구독|공유|저장|좋아요|싫어요/i.test(text)) return false;
  if (/[👍👏😂🤣😍😭🔥💯✨]/u.test(text)) return false;
  if ((text.match(/[~!?.ㆍ…]/g) || []).length >= 5) return false;
  return true;
}

function collectProductObjects(node, products = []) {
  if (!node || typeof node !== "object") return products;
  if (Array.isArray(node)) {
    node.forEach(item => collectProductObjects(item, products));
    return products;
  }

  const values = Object.values(node).map(plainText).filter(Boolean);
  const price = values.find(value => isLikelyProductPrice(value));
  const title = values.find(value => isLikelyProductTitle(value));
  if (price && title) {
    products.push({
      title: normalizeProductText(title),
      priceText: extractPriceText(price),
      evidence: `${normalizeProductText(title)} / ${extractPriceText(price)}`
    });
  }

  Object.values(node).forEach(value => collectProductObjects(value, products));
  return products;
}

function collectProductsNearPrices(html) {
  const products = [];
  const pricePattern = /₩\s?[\d,]+|[\d,]+\s?원/g;
  for (const match of html.matchAll(pricePattern)) {
    if (!isLikelyProductPrice(match[0])) continue;
    const start = Math.max(0, match.index - 1400);
    const end = Math.min(html.length, match.index + 400);
    const chunk = html.slice(start, end);
    const textMatches = [...chunk.matchAll(/"text":"([^"]{2,90})"/g)]
      .map(item => normalizeProductText(item[1]))
      .filter(isLikelyProductTitle);
    const title = textMatches.reverse().find(value => !/^\d+$/.test(value));
    if (title) {
      products.push({
        title,
        priceText: normalizeProductText(match[0]),
        evidence: `${title} / ${normalizeProductText(match[0])}`
      });
    }
  }
  return products;
}

function uniqueProducts(products) {
  const seen = new Set();
  return products.filter(product => {
    const key = product.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isValidProduct(product) {
  const title = normalizeProductText(product?.title || "");
  const priceText = normalizeProductText(product?.priceText || "");
  const amount = Number(priceText.replace(/[^\d]/g, ""));
  if (!title || !Number.isFinite(amount) || amount < 1000) return false;
  if (/취소|확인|답글|댓글|구독|공유|저장|좋아요|싫어요/i.test(title)) return false;
  if (/[👍👏😂🤣😍😭🔥💯✨]/u.test(title)) return false;
  if ((title.match(/[~!?.ㆍ…]/g) || []).length >= 5) return false;
  return isLikelyProductTitle(title);
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("브라우저 디버그 포트에 연결하지 못했습니다.");
}

async function ensureChrome() {
  try {
    await waitForJson(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`, 1000);
    return;
  } catch {}

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error("Chrome 또는 Edge 실행 파일을 찾지 못했습니다.");
  }

  const profileDir = path.join(os.tmpdir(), "youtube-book-transcript-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--disable-gpu",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--disable-background-networking",
    "about:blank"
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  chromeProcess.unref();
  await waitForJson(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`, 15000);
}

async function createCdpPage(url) {
  await ensureChrome();
  await closeBlankCdpPages();
  let response = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/new?${encodeURIComponent(url)}`);
  }
  if (!response.ok) throw new Error(`브라우저 탭 생성 실패 (${response.status})`);
  return response.json();
}

async function closeCdpPage(pageId) {
  try {
    await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/close/${pageId}`);
  } catch {}
}

async function listCdpPages() {
  try {
    const response = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`);
    if (!response.ok) return [];
    return response.json();
  } catch {
    return [];
  }
}

async function closeBlankCdpPages() {
  const pages = await listCdpPages();
  await Promise.all(pages
    .filter(page => page.type === "page" && (!page.url || page.url === "about:blank"))
    .map(page => closeCdpPage(page.id)));
}

function connectRawWebSocket(wsUrl, onMessage) {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== "ws:") {
    throw new Error("ws:// CDP URL만 지원합니다.");
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(Number(parsed.port), parsed.hostname);
    const key = crypto.randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    let isOpen = false;
    let fragmentedText = "";

    function sendFrame(text) {
      const payload = Buffer.from(text);
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        masked[i] = payload[i] ^ mask[i % 4];
      }
      socket.write(Buffer.concat([header, mask, masked]));
    }

    function parseFrames() {
      while (buffer.length >= 2) {
        const first = buffer[0];
        const opcode = first & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1] & 0x80) !== 0;
        const maskOffset = masked ? 4 : 0;
        if (buffer.length < offset + maskOffset + length) return;
        let payload = buffer.slice(offset + maskOffset, offset + maskOffset + length);
        if (masked) {
          const mask = buffer.slice(offset, offset + 4);
          payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
        }
        buffer = buffer.slice(offset + maskOffset + length);
        const isFinal = (first & 0x80) !== 0;
        if (opcode === 0x1) {
          if (isFinal) {
            onMessage(payload.toString("utf8"));
          } else {
            fragmentedText = payload.toString("utf8");
          }
        }
        if (opcode === 0x0) {
          fragmentedText += payload.toString("utf8");
          if (isFinal) {
            onMessage(fragmentedText);
            fragmentedText = "";
          }
        }
        if (opcode === 0x8) socket.end();
      }
    }

    socket.on("connect", () => {
      socket.write([
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
        `Host: ${parsed.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });

    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!isOpen) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = buffer.slice(0, headerEnd).toString("utf8");
        if (!/^HTTP\/1\.1 101/.test(header)) {
          reject(new Error("CDP WebSocket handshake 실패"));
          socket.destroy();
          return;
        }
        buffer = buffer.slice(headerEnd + 4);
        isOpen = true;
        resolve({
          send: sendFrame,
          close: () => socket.end()
        });
      }
      parseFrames();
    });
    socket.on("error", reject);
  });
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const pending = new Map();
    let id = 0;
    let connection;

    function handleMessage(message) {
      const data = JSON.parse(message);
      if (!data.id || !pending.has(data.id)) return;
      const { res, rej } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) rej(new Error(data.error.message || "CDP command failed"));
      else res(data.result);
    }

    connectRawWebSocket(wsUrl, handleMessage).then(wsConnection => {
      connection = wsConnection;
      resolve({
        send(method, params = {}) {
          const messageId = ++id;
          connection.send(JSON.stringify({ id: messageId, method, params }));
          return new Promise((res, rej) => {
            pending.set(messageId, { res, rej });
          });
        },
        close() {
          connection.close();
        }
      });
    }).catch(reject);
  });
}

async function fetchBrowserTranscript(videoId) {
  const page = await createCdpPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ko`);
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(5500);
    const transcriptButtonResult = await cdp.send("Runtime.evaluate", {
      expression: `(${function () {
        const textOf = el => [el?.innerText, el?.textContent, el?.getAttribute?.("aria-label"), el?.getAttribute?.("title")]
          .filter(Boolean)
          .join(" ");
        const section = document.querySelector("ytd-video-description-transcript-section-renderer");
        const candidates = Array.from((section || document).querySelectorAll("button, yt-button-shape, yt-button-shape button, tp-yt-paper-button, ytd-button-renderer, a, [role='button']"));
        const exact = candidates.find(el => /(^|[ \t\r\n])스크립트 표시([ \t\r\n]|$)|Show transcript/i.test(textOf(el)));
        const target = exact || candidates.find(el => /스크립트 표시|Show transcript/i.test(textOf(el)));
        if (!target) return null;
        const clickable = target.shadowRoot?.querySelector?.("button, a, [role='button']") ||
          target.querySelector?.("button, a, [role='button']") ||
          target.closest?.("button, a, tp-yt-paper-button, ytd-button-renderer, yt-button-shape, [role='button']") ||
          target;
        clickable.scrollIntoView({ block: "center" });
        clickable.focus?.();
        const rect = clickable.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height
        };
      }})()`,
      returnByValue: true
    });
    const transcriptButton = transcriptButtonResult.result?.value;
    if (transcriptButton?.width && transcriptButton?.height) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: transcriptButton.x,
        y: transcriptButton.y
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: transcriptButton.x,
        y: transcriptButton.y,
        button: "left",
        clickCount: 1
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: transcriptButton.x,
        y: transcriptButton.y,
        button: "left",
        clickCount: 1
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: "Enter",
        code: "Enter"
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: "Enter",
        code: "Enter"
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        windowsVirtualKeyCode: 32,
        nativeVirtualKeyCode: 32,
        key: " ",
        code: "Space"
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 32,
        nativeVirtualKeyCode: 32,
        key: " ",
        code: "Space"
      });
      await sleep(3000);
    }
    const expression = `(${async function () {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const visibleText = el => (el?.innerText || el?.textContent || "").replace(/[ \t\r\n]+/g, " ").trim();
      const hasText = (el, patterns) => {
        const text = visibleText(el);
        const label = el?.getAttribute?.("aria-label") || "";
        const title = el?.getAttribute?.("title") || "";
        return patterns.some(pattern => pattern.test(text) || pattern.test(label) || pattern.test(title));
      };
      const clickElement = async (target) => {
        if (!target) return false;
        const clickable = target.shadowRoot?.querySelector?.("button, a, [role='button']") ||
          target.querySelector?.("button, a, [role='button']") ||
          target.closest?.("button, a, tp-yt-paper-button, ytd-button-renderer, yt-button-shape, [role='button']") ||
          target;
        clickable.scrollIntoView({ block: "center" });
        const rect = clickable.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        };
        clickable.dispatchEvent(new PointerEvent("pointerdown", eventInit));
        clickable.dispatchEvent(new MouseEvent("mousedown", eventInit));
        clickable.dispatchEvent(new PointerEvent("pointerup", eventInit));
        clickable.dispatchEvent(new MouseEvent("mouseup", eventInit));
        clickable.dispatchEvent(new MouseEvent("click", eventInit));
        clickable.click?.();
        await sleep(1000);
        return true;
      };
      const clickByText = async (patterns, scope = document) => {
        const elements = Array.from(scope.querySelectorAll("button, yt-button-shape, yt-button-shape button, tp-yt-paper-button, ytd-button-renderer, a, [role='button'], yt-formatted-string, span"))
          .filter(el => hasText(el, patterns))
          .sort((a, b) => visibleText(a).length - visibleText(b).length);
        const target = elements[0];
        return clickElement(target);
      };
      const collectSegments = () => {
        const nodes = Array.from(document.querySelectorAll([
          "ytd-transcript-segment-renderer",
          "yt-formatted-string.segment-text",
          ".segment-text",
          "[class*='segment-text']"
        ].join(",")));
        const rows = [];
        for (const node of nodes) {
          const container = node.closest("ytd-transcript-segment-renderer") || node.closest("[class*='segment']") || node;
          const time = visibleText(container.querySelector?.(".segment-timestamp, yt-formatted-string.segment-timestamp, [class*='timestamp']"));
          let text = visibleText(container.querySelector?.(".segment-text, yt-formatted-string.segment-text, [class*='segment-text']")) || visibleText(node);
          text = text.replace(time, "").trim();
          if (text && !/^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$/.test(text) && !rows.some(row => row.text === text && row.time === time)) {
            rows.push({ time, text });
          }
        }
        return rows;
      };
      const collectPanelText = () => {
        const panels = Array.from(document.querySelectorAll([
          "#engagement-panel-searchable-transcript",
          "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']",
          "ytd-transcript-renderer",
          "ytd-transcript-search-panel-renderer"
        ].join(",")));
        return panels.map(visibleText).filter(Boolean).join("\\n");
      };
      const secondsFromTime = (time) => {
        const parts = String(time || "").split(":").map(Number);
        if (parts.some(Number.isNaN)) return null;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
      };
      const collectBodyTranscript = () => {
        const raw = document.body?.innerText || "";
        const markerIndex = raw.indexOf("스크립트 검색") >= 0
          ? raw.indexOf("스크립트 검색") + "스크립트 검색".length
          : raw.indexOf("Search transcript") >= 0
            ? raw.indexOf("Search transcript") + "Search transcript".length
            : -1;
        if (markerIndex < 0) return [];
        const durationSeconds = secondsFromTime(document.querySelector(".ytp-time-duration")?.textContent?.trim());
        const lines = raw.slice(markerIndex).split(String.fromCharCode(10)).map(line => line.trim()).filter(Boolean);
        const rows = [];
        for (let i = 0; i < lines.length; i += 1) {
          const time = lines[i];
          if (!/^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$/.test(time)) continue;
          const currentSeconds = secondsFromTime(time);
          if (durationSeconds !== null && rows.length && currentSeconds !== null && currentSeconds > durationSeconds) break;
          if (durationSeconds !== null && currentSeconds !== null && currentSeconds > durationSeconds && rows.length === 0) continue;
          let textIndex = i + 1;
          if (/^[0-9]+초$/.test(lines[textIndex] || "")) textIndex += 1;
          const text = lines[textIndex] || "";
          if (!text || /^조회수|^구독자|^새 동영상$|^자동 더빙$/.test(text)) {
            if (rows.length) break;
            continue;
          }
          rows.push({ time, text });
        }
        return rows;
      };
      const waitForTranscriptText = async () => {
        for (let i = 0; i < 20; i += 1) {
          const segments = collectSegments();
          const bodySegments = collectBodyTranscript();
          const panelText = collectPanelText();
          if (segments.length || bodySegments.length || /[0-9]{1,2}:[0-9]{2}/.test(panelText)) {
            return { segments: segments.length ? segments : bodySegments, panelText };
          }
          await sleep(700);
        }
        const segments = collectSegments();
        return { segments: segments.length ? segments : collectBodyTranscript(), panelText: collectPanelText() };
      };

      const metadata = document.querySelector("ytd-watch-metadata") || document.querySelector("#below");
      metadata?.scrollIntoView({ block: "start" });
      await sleep(1000);

      await clickElement(document.querySelector("tp-yt-paper-button#expand, ytd-text-inline-expander tp-yt-paper-button#expand, #description tp-yt-paper-button#expand"));
      await clickByText([/^더보기$/, /^Show more$/i]);
      await sleep(1500);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const transcriptSection = document.querySelector("ytd-video-description-transcript-section-renderer");
        if (transcriptSection) {
          await clickByText([/스크립트 표시/, /스크립트/, /Show transcript/i, /Transcript/i], transcriptSection);
        }
        await clickByText([/스크립트 표시/, /스크립트/, /Show transcript/i, /Transcript/i]);
        const current = await waitForTranscriptText();
        if (current.segments.length || current.panelText) break;
        window.scrollBy(0, 450);
        await sleep(900);
      }

      const collected = await waitForTranscriptText();
      const segments = collected.segments;

      let text = segments.map(segment => segment.text).join("\\n");
      if (!text) {
        text = collected.panelText;
      }
      if (/^스크립트$|^Transcript$/i.test(text.trim())) text = "";
      text = text
        .split("\\n")
        .map(line => line.trim())
        .filter(line => line && !/^스크립트$|^Transcript$/i.test(line))
        .join("\\n");

      return {
        status: text ? "available" : "unavailable",
        text: text.slice(0, 120000),
        segments: segments.slice(0, 3000),
        title: document.title,
        url: location.href,
        bodySample: visibleText(document.body).slice(0, 3000),
        hasTranscriptButton: Array.from(document.querySelectorAll("button, [role='button'], a"))
          .some(el => hasText(el, [/스크립트/, /Transcript/i, /Show transcript/i])),
        segmentNodeCount: document.querySelectorAll("ytd-transcript-segment-renderer, .segment-text, [class*='segment-text']").length,
        panelNodeCount: document.querySelectorAll("#engagement-panel-searchable-transcript, ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript'], ytd-transcript-renderer").length
      };
    }})()`;

    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000
    });
    const value = result.result?.value || {};
    const hasTranscriptButton = Boolean(value.hasTranscriptButton);
    const status = value.status === "unavailable" && hasTranscriptButton ? "button_only" : (value.status || "unavailable");
    return {
      videoId,
      status,
      language: "",
      source: "browser_dom",
      text: value.text || "",
      segments: value.segments || [],
      debug: {
        title: value.title || "",
        url: value.url || "",
        hasTranscriptButton,
        segmentNodeCount: Number(value.segmentNodeCount || 0),
        panelNodeCount: Number(value.panelNodeCount || 0),
        bodySample: value.status === "available" ? "" : (value.bodySample || "")
      }
    };
  } finally {
    cdp.close();
    await closeCdpPage(page.id);
    await closeBlankCdpPages();
  }
}

async function fetchProductTags(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ko`;
  const watchResponse = await fetch(watchUrl, {
    headers: {
      "accept-language": "ko,en;q=0.8",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!watchResponse.ok) {
    throw new Error(`YouTube 페이지 요청 실패 (${watchResponse.status})`);
  }

  const html = await watchResponse.text();
  let products = [];
  try {
    const initialData = extractInitialData(html);
    products = collectProductObjects(initialData);
  } catch {
    products = [];
  }

  products = uniqueProducts(products).filter(isValidProduct).slice(0, 8);

  return {
    videoId,
    status: products.length ? "available" : "unavailable",
    products
  };
}

async function fetchTranscript(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ko`;
  const watchResponse = await fetch(watchUrl, {
    headers: {
      "accept-language": "ko,en;q=0.8",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!watchResponse.ok) {
    throw new Error(`YouTube 페이지 요청 실패 (${watchResponse.status})`);
  }

  const html = await watchResponse.text();
  const playerResponse = extractPlayerResponse(html);
  const track = pickCaptionTrack(playerResponse);
  if (!track?.baseUrl) {
    return {
      videoId,
      status: "unavailable",
      language: "",
      text: "",
      segments: []
    };
  }

  const captionUrl = new URL(track.baseUrl);
  captionUrl.searchParams.set("fmt", "json3");
  const captionResponse = await fetch(captionUrl, {
    headers: {
      "accept-language": "ko,en;q=0.8",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!captionResponse.ok) {
    throw new Error(`자막 요청 실패 (${captionResponse.status})`);
  }

  const contentType = captionResponse.headers.get("content-type") || "";
  let segments = [];
  if (contentType.includes("json")) {
    segments = transcriptFromJson3(await captionResponse.json());
  } else {
    segments = transcriptFromXml(await captionResponse.text());
  }

  if (!segments.length) {
    const fallbackResponse = await fetch(track.baseUrl, {
      headers: {
        "accept-language": "ko,en;q=0.8",
        "user-agent": "Mozilla/5.0"
      }
    });
    if (fallbackResponse.ok) {
      segments = transcriptFromXml(await fallbackResponse.text());
    }
  }

  return {
    videoId,
    status: segments.length ? "available" : "empty",
    language: track.languageCode || "",
    name: track.name?.simpleText || "",
    isAutoGenerated: track.kind === "asr",
    reason: segments.length ? "" : "caption_track_found_but_empty",
    text: segments.map(segment => segment.text).join("\n"),
    segments
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type"
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/transcript/")) {
      const videoId = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
        sendJson(res, 400, { error: "유효하지 않은 videoId입니다." });
        return;
      }
      const transcript = await fetchTranscript(videoId);
      sendJson(res, 200, transcript);
      return;
    }

    if (url.pathname.startsWith("/api/product-tags/")) {
      const videoId = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
        sendJson(res, 400, { error: "유효하지 않은 videoId입니다." });
        return;
      }
      const productTags = await fetchProductTags(videoId);
      sendJson(res, 200, productTags);
      return;
    }

    if (url.pathname.startsWith("/api/browser-transcript/")) {
      const videoId = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
        sendJson(res, 400, { error: "유효하지 않은 videoId입니다." });
        return;
      }
      const transcript = await fetchBrowserTranscript(videoId);
      sendJson(res, 200, transcript);
      return;
    }

    const filePath = url.pathname === "/"
      ? path.join(ROOT, "youtube-book-impact-dashboard.html")
      : path.join(ROOT, path.basename(url.pathname));
    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dashboard server: http://127.0.0.1:${PORT}/youtube-book-impact-dashboard.html`);
  console.log(`Transcript API:   http://127.0.0.1:${PORT}/api/transcript/VIDEO_ID`);
  console.log(`Product API:      http://127.0.0.1:${PORT}/api/product-tags/VIDEO_ID`);
  console.log(`Browser API:      http://127.0.0.1:${PORT}/api/browser-transcript/VIDEO_ID`);
});

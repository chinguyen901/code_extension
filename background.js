let intervalId = null;
let isPaused = false;
let send_Sudden = false;
let time_focus = 0;
let warnedDueToInactivity = false; // ✅ THÊM VÀO
let suddenTimeoutId = null;        // ✅ THÊM VÀO
const time_limit = 600;
let ws = null;
const pendingMessages = [];

const WS_URL = "wss://chromextension-production.up.railway.app";

function getLocalStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key]));
  });
}

async function hashScreenshot(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function initWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("✅ WebSocket connected (background.js)");
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      ws.send(msg);
    }
  };

  ws.onerror = (err) => console.error("❌ WebSocket error:", err);
  ws.onclose = () => console.warn("⚠️ WebSocket disconnected");

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'ping') {
      const isActive = await checkTabActive();
      if (isActive) {
        const account_id = await getLocalStorage("account_id");
        const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        safeSend(JSON.stringify({
          type: "pong",
          account_id,
          created_at: timestamp
        }));
      } else {
        console.log("⚠️ Tab không active - không phản hồi pong");
      }
    }
  };
}

initWebSocket();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.command) {
    case "start":
      if (intervalId) clearInterval(intervalId);
      handleScreenshot();
      intervalId = setInterval(handleScreenshot, msg.interval * 1000);
      sendResponse({ success: true });
      return true;
    case "stop":
      clearInterval(intervalId);
      intervalId = null;
      isPaused = false;
      send_Sudden = false;
      time_focus = 0;
      warnedDueToInactivity = false;
      if (suddenTimeoutId) {
        clearTimeout(suddenTimeoutId);
        suddenTimeoutId = null;
      }
      sendResponse({ success: true });
      return true;
    case "checkin-again-done":
      warnedDueToInactivity = false;
      time_focus = 0;
      isPaused = false;
      if (suddenTimeoutId) {
        clearTimeout(suddenTimeoutId);
        suddenTimeoutId = null;
      }
      sendResponse({ success: true });
      return true;
    default:
      sendResponse({ success: false, error: "Unknown command" });
      return false;
  }
});

async function handleScreenshot() {
  chrome.tabs.captureVisibleTab({ format: "png" }, async (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) return;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const hash = await hashScreenshot(blob);
      const accountId = await getLocalStorage("account_id");
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");

      safeSend(JSON.stringify({
        type: "log-screenshot",
        account_id: accountId,
        hash,
        created_at: timestamp
      }));

      chrome.downloads.download({
        url: dataUrl,
        filename: `screenshots/screenshot_${Date.now()}.png`,
        conflictAction: "uniquify",
        saveAs: false,
      });
    } catch (err) {
      console.error("Screenshot error:", err);
    }
  });
}


function checkTabActive() {
  return new Promise((resolve) => {
    chrome.windows.getCurrent({ populate: true }, (window) => {
      if (!window) return resolve(false);
      const activeTab = window.tabs.find(tab => tab.active);
      if (!activeTab) return resolve(false);
      chrome.windows.get(window.id, (win) => resolve(win.focused));
    });
  });
}

function safeSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  } else {
    if (ws.readyState === WebSocket.CLOSED) {
      console.warn("❌ WebSocket CLOSED. Queued message.");
    }
    pendingMessages.push(payload);
  }
}

let intervalId = null;
let warnedDueToInactivity = false; // ✅ THÊM VÀO
let previousStatus = null;
let suddenTimeoutId = null; // ✅ THÊM VÀO
let ws = null;
const pendingMessages = [];

const WS_URL = "wss://chromextension-production.up.railway.app";

// setInterval(() => {
//   if (ws && ws.readyState === WebSocket.OPEN) {
//     console.log("Sending ping to keep WebSocket open");
//     ws.send(JSON.stringify({ type: "ping" }));
//   }
// }, 10000);

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
      console.log("Received ping from server");
      const account_id = await getLocalStorage("account_id");
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      safeSend({
        type: "pong",
        account_id,
        created_at: timestamp
      });
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
      warnedDueToInactivity = false;
      if (suddenTimeoutId) {
        clearTimeout(suddenTimeoutId);
        suddenTimeoutId = null;
      }
      sendResponse({ success: true });
      return true;
    case "checkin-again-done":
      warnedDueToInactivity = false;
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
  const accountId = await getLocalStorage("account_id");
  const isActive = await checkTabActive();

  // Nếu trạng thái thay đổi (active -> noactive hoặc noactive -> active)
  if (isActive !== previousStatus) {
    // Chỉ gửi "noactive" nếu tab trước đó là active
    if (!isActive && previousStatus === true) {
      safeSend(JSON.stringify({
        type: "log-distraction",
        account_id: accountId,
        status: "NO_ACTIVE",
        note: "NO WORK ON TAB",
        created_at: new Date().toISOString().slice(0, 19).replace("T", " ")
      }));
    }

    // Chỉ gửi "active" nếu tab trước đó là inactive
    if (isActive && previousStatus === false) {
      safeSend(JSON.stringify({
        type: "log-distraction",
        account_id: accountId,
        status: "ACTIVE",
        note: 0, 
        created_at: new Date().toISOString().slice(0, 19).replace("T", " ")
      }));
    }

    // Cập nhật trạng thái trước đó
    previousStatus = isActive;
  }

  if (isActive) {
    // Nếu tab đang active, thực hiện chụp ảnh
    chrome.tabs.captureVisibleTab({ format: "png" }, async (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) return;
      try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const hash = await hashScreenshot(blob);
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

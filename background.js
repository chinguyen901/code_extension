let intervalId = null;
let warnedDueToInactivity = false;
let previousStatus = null;
let suddenTimeoutId = null;
let ws = null;
const pendingMessages = [];

const WS_URL = "wss://chromextension-production.up.railway.app?source=background";

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

function safeSend(payload) {
  // Payload phải là object, convert ở đây
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  } else {
    console.warn("❌ WebSocket not open. Queuing message.");
    pendingMessages.push(message);
  }
}

function reconnectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  
  console.log("🔄 Reconnecting WebSocket...");
  ws = new WebSocket(WS_URL);

  ws.onopen = async () => {
    console.log("✅ WebSocket connected (background.js)");
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      ws.send(msg);
    }
  };

  ws.onerror = (err) => console.error("❌ WebSocket error:", err);

  ws.onclose = () => {
    console.warn("⚠️ WebSocket disconnected, retrying in 3s...");
    setTimeout(reconnectWebSocket, 3000);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ping') {
        console.log("Received ping from server");
        const account_id = await getLocalStorage("account_id");
        if (!account_id) {
          console.warn("⚠️ No account_id in localStorage, can't send pong");
          return;
        }
        const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        safeSend({
          type: "pong",
          account_id,
          created_at: timestamp
        });
      }
    } catch (err) {
      console.error("❌ Error handling WebSocket message:", err);
    }
  };
}

async function handleScreenshot() {
  const accountId = await getLocalStorage("account_id");
  if (!accountId) {
    console.warn("⚠️ No account_id found, skipping screenshot.");
    return;
  }
  const isActive = await checkTabActive();

  if (isActive !== previousStatus) {
    if (!isActive && previousStatus === true) {
      safeSend({
        type: "log-distraction",
        account_id: accountId,
        status: "NO_ACTIVE",
        note: "NO WORK ON TAB",
        created_at: new Date().toISOString().slice(0, 19).replace("T", " ")
      });
    }

    if (isActive && previousStatus === false) {
      safeSend({
        type: "log-distraction",
        account_id: accountId,
        status: "ACTIVE",
        note: 0,
        created_at: new Date().toISOString().slice(0, 19).replace("T", " ")
      });
    }
    previousStatus = isActive;
  }

  if (isActive) {
    chrome.tabs.captureVisibleTab({ format: "png" }, async (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) return;
      try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const hash = await hashScreenshot(blob);

        safeSend({
          type: "log-screenshot",
          account_id: accountId,
          hash,
          created_at: new Date().toISOString().slice(0, 19).replace("T", " ")
        });

        // Nếu không cần tải về file local thì có thể comment đoạn này lại
        chrome.downloads.download({
          url: dataUrl,
          filename: `screenshots/screenshot_${Date.now()}.png`,
          conflictAction: "uniquify",
          saveAs: false,
        });
      } catch (err) {
        console.error("❌ Screenshot processing error:", err);
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

// Khởi tạo WebSocket khi background chạy
reconnectWebSocket();

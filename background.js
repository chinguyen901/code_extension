// ===== Biến toàn cục =====
let intervalId = null;
let warnedDueToInactivity = false;
let previousStatus = null;
let suddenTimeoutId = null;
let ws = null;
const pendingMessages = [];

const WS_URL = "wss://chromextension-production.up.railway.app?source=background";

// ===== WebSocket giữ kết nối định kỳ =====
// setInterval(async () => {
//   if (ws && ws.readyState === WebSocket.OPEN) {
//     const account_id = await getLocalStorage("account_id");
//     if (!account_id) return;

//     ws.send(JSON.stringify({
//       type: "pong",
//       account_id,
//       created_at: new Date().toISOString().slice(0, 19).replace("T", " ")
//     }));

//     console.log("📡 Sent keepalive pong manually");
//   }
// }, 10000); // 10 giây

// ===== Hàm trợ giúp =====
function getLocalStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key]));
  });
}

async function hashScreenshot(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ===== Khởi tạo WebSocket =====
function initWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("✅ WebSocket connected (background.js)");
    while (pendingMessages.length > 0) {
      ws.send(pendingMessages.shift());
    }
  };

  ws.onerror = (err) => console.error("❌ WebSocket error:", err);
  ws.onclose = () => console.warn("⚠️ WebSocket disconnected");

  // ws.onmessage = async (event) => {
  //   const msg = JSON.parse(event.data);

  //   // Server gửi ping → phản hồi lại bằng pong
  //   if (msg.type === 'ping') {
  //     const account_id = await getLocalStorage("account_id");
  //     const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  //     safeSend({
  //       type: "pong",
  //       account_id,
  //       created_at: timestamp
  //     });
  //   }
  // };
}

// Gọi khởi tạo WebSocket ngay khi load
initWebSocket();

// ===== Nghe lệnh từ popup hoặc content script =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.command) {
    case "start":
      if (intervalId) clearInterval(intervalId);
      handleScreenshot(); // chụp ngay lần đầu
      intervalId = setInterval(handleScreenshot, msg.interval * 1000);
      sendResponse({ success: true });
      return true;

    case "stop":
    case "checkin-again-done":
      clearInterval(intervalId);
      intervalId = null;
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

// ===== Hàm xử lý chụp màn hình + gửi log hoạt động =====
async function handleScreenshot() {
  const accountId = await getLocalStorage("account_id");
  const isActive = await checkTabActive();

  // Gửi log nếu trạng thái có thay đổi (hoạt động <=> không hoạt động)
  if (isActive !== previousStatus) {
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const logType = {
      true: { status: "ACTIVE", note: "0" },
      false: { status: "NO_ACTIVE", note: "NO WORK ON TAB" }
    }[isActive];

    safeSend(JSON.stringify({
      type: "log-distraction",
      account_id: accountId,
      status: logType.status,
      note: logType.note,
      created_at: timestamp
    }));

    previousStatus = isActive;
  }

  // Nếu đang hoạt động, chụp ảnh màn hình và gửi log
  if (isActive) {
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
          saveAs: false
        });
      } catch (err) {
        console.error("❌ Screenshot error:", err);
      }
    });
  }
}

// ===== Kiểm tra tab có đang active và window có đang focus không =====
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

// ===== Gửi tin nhắn WebSocket an toàn =====
function safeSend(payload) {
  if (!payload) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  } else {
    console.warn("⚠️ WebSocket chưa mở, tin nhắn đang được lưu chờ.");
    pendingMessages.push(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
}


// ===== Giữ cho Service Worker không bị dừng (Chrome MV3) =====
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    console.log("🔁 keepAlive triggered");

    // Tự động kết nối lại nếu socket đóng
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      console.log("🔄 Reinitializing WebSocket...");
      initWebSocket();
    }
  }
});

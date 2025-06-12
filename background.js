// ===== Biến toàn cục =====
let intervalId = null;
let warnedDueToInactivity = false;
let previousStatus = null;
let suddenTimeoutId = null;
let ws = null;
const pendingMessages = [];

const WS_URL = "wss://chromextension-production.up.railway.app?source=background";

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

  // ws.onopen = () => {
  //   console.log("✅ WebSocket connected (background.js)");
  //   while (pendingMessages.length > 0) {
  //     ws.send(pendingMessages.shift());
  //   }
  // };
  ws.onopen = async () => {
    console.log("✅ WebSocket connected (background.js)");

    // Gửi các message tồn trước đó (không liên quan đến authenticate)
    while (pendingMessages.length > 0) {
      ws.send(pendingMessages.shift());
    }

    // 🆔 Thêm đoạn này:
    const accountId = await getLocalStorage("account_id");
    if (accountId) {
      ws.send(JSON.stringify({
        type: "authenticate",
        account_id: accountId
      }));
      console.log(`📤 Sent authenticate for account_id=${accountId}`);
    }
  };

  ws.onerror = (err) => console.error("❌ WebSocket error:", err);
  ws.onclose = () => console.warn("⚠️ WebSocket disconnected");

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'force-checkin') {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('images/bell.png'),
        title: '⚠️ Check In Again',
        message: msg.message,
        priority: 2
      });
      // Thiết lập state để popup có thể đọc
      chrome.storage.local.set({ currentState: 'force-checkin' });
      // Gửi message nếu popup đang mở
      chrome.runtime.sendMessage({ type: 'force-checkin', message: msg.message }).catch(() => {});
    }
  };

}

// Gọi khởi tạo WebSocket ngay khi load
initWebSocket();

// ===== Nghe lệnh từ popup hoặc content script =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.command) {
    case "start":
      if (intervalId) clearInterval(intervalId);
      previousStatus = true;
      handleScreenshot(); // chụp ngay lần đầu
      intervalId = setInterval(handleScreenshot, msg.interval * 1000);
      sendResponse({ success: true });
      return true;
    case "checkin-again-done":
      console.log('ℹ️ Received checkin-again-done from popup, restarting screenshots');
    // dừng interval nếu đang chạy
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      // khởi động lại với tần suất mong muốn
      const intervalSec = msg.interval || 15; 
      intervalId = setInterval(handleScreenshot, intervalSec * 1000);
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
    case "update-badge":
      updateBadge(msg.state);
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
    const logType = isActive ? { status: "ACTIVE", note: "0" }
                          : { status: "NO_ACTIVE", note: "NO WORK ON TAB" };

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


// function sendNotification(content) {
//   chrome.notifications.create({
//     type: "basic",
//     iconUrl: chrome.runtime.getURL("images/bell.png"),
//     title: "⚠️ Check In Again",
//     message: content,
//     priority: 2
//   });
// }
function updateBadge(state) {
  let color = "#000000";
  let text = "";

  switch (state) {
    case "break_end":
    case "checkin":
      color = "#00cc00"; // xanh
      text = "IN";
      break;
    case "checkout":
      color = "#000000"; // đen
      text = "OUT";
      break;
    case "break_start":
      color = "#ffcc00"; // vàng
      text = "BR";
      break;
    case "check in again":
      color = "#ff0000"; // đỏ
      text = "!";
      break;
    default:
      color = "#999999";
      text = "?";
  }

  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

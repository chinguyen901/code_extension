let intervalId = null;
let isPaused = false;
let send_Sudden = false;
let time_focus = 0;
const time_limit = 600;
let isTabActive = true; // Biến theo dõi trạng thái tab có active hay không
let wasTabActive = true;  // Biến lưu trạng thái tab trước đó
let distractionCount = 0;

const API_BASE_URL = "https://employeeschedule-production.up.railway.app"; // 🔁 Thay bằng URL thật

async function hashScreenshot(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function getLocalStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key]));
  });
}

let warnedDueToInactivity = false;
let suddenTimeoutId = null;

function handleInactivity() {
  if (warnedDueToInactivity) return;
  isPaused = true;
  warnedDueToInactivity = true;
  send_Sudden = true;

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "Time Inactivity Detected",
    message: "Check IN Again to continue working.",
    priority: 2,
  });
}

async function sendLogSudden() {
  const sessionId = await getLocalStorage("sessionId");
  const accountId = await getLocalStorage("account_id"); // Sử dụng account_id thay vì employeeId

  if (!sessionId || !accountId) return;

  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  const payload = {
    account_id: accountId,   // Sử dụng account_id từ localStorage
    status: "SUDDEN",   // Tương ứng với tình trạng sự cố
    reason: "NO ACTIVE Longtime client to Server", // Lý do sự cố
    created_at: timestamp,  // Ngày tạo sự kiện
  };

  try {
    const res = await fetch(`${API_BASE_URL}/log-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success) {
      const sessionData = {
        account_id: accountId,
        status: "checkout",  // Đăng xuất do không hoạt động
        created_at: timestamp,
      };
      await fetch(`${API_BASE_URL}/log-work`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionData),
      });
    }
  } catch (err) {
    console.error("SUDDEN log failed:", err);
  }

  send_Sudden = false;
}

async function handleScreenshot() {
  const active = await checkTabActive();
  if (wasTabActive && active) {
    distractionCount = 1;  // reset đếm và bắt đầu từ 1
    sendDistractionLog("active");
  }

  // Nếu tab không active thì gửi log "inactive"
  if (!active) {
    distractionCount++;
    sendDistractionLog("noactive");
    wasTabActive = false;
    return; // không chụp ảnh
  }

  // Tab active, reset đếm distraction
  distractionCount = 0;

  wasTabActive = true;

  chrome.tabs.captureVisibleTab({ format: "png" }, async (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) return;

    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const hash = await hashScreenshot(blob);

      const accountId = await getLocalStorage("account_id"); // Sử dụng account_id từ localStorage
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");

      const payload = {
        account_id: accountId, // Gửi đúng account_id
        hash,  // Hash của ảnh
        created_at: timestamp,
      };

      await fetch(`${API_BASE_URL}/log-screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      chrome.downloads.download({
        url: dataUrl,
        filename: `screenshots/screenshot_${Date.now()}.png`, // 📁 Thư mục phụ nếu bạn muốn
        conflictAction: "uniquify", // Tránh ghi đè
        saveAs: false, // Không hiện popup
      });
    } catch (err) {
      console.error("Error handling screenshot:", err);
    }
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

    case "login":
      fetch(`${API_BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: msg.username, // Đảm bảo là 'username'
          password: msg.password,
        }),
      })
        .then(res => res.json())
        .then(data => {
          console.log("🎯 Login response data:", data);
          sendResponse({
            success: data.success == true,
            name: data.name,       // ✅ Sửa từ username → name
            id: data.id,           // ✅ Sửa từ userId → id
            username: msg.username, // ✅ Đặt đúng username cho lưu trữ
            error: data.error,
          });
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case "logIncident":
      fetch(`${API_BASE_URL}/log-incident`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.data),
      })
        .then((res) => res.json())
        .then((data) => sendResponse({ success: data.success, error: data.error || null }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case "logBreak":
      fetch(`${API_BASE_URL}/log-break`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.data),
      })
        .then((res) => res.json())
        .then((data) => sendResponse({ success: data.success, error: data.error || null }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    
    case "logWork":
      fetch(`${API_BASE_URL}/log-work`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.data),
      })
        .then((res) => res.json())
        .then((data) => sendResponse({ success: data.success, error: data.error || null }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case "logLoginout":
      fetch(`${API_BASE_URL}/log-loginout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.data),
      })
        .then((res) => res.json())
        .then((data) => sendResponse({ success: data.success, error: data.error || null }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
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


// Kiểm tra tab hiện tại có active (focus) hay không
function checkTabActive() {
  return new Promise((resolve) => {
    chrome.windows.getCurrent({ populate: true }, (window) => {
      if (!window) return resolve(false);
      const activeTab = window.tabs.find(tab => tab.active);
      if (!activeTab) return resolve(false);
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return resolve(false);
        // Kiểm tra xem tab có focus window không (window.focused)
        chrome.windows.get(window.id, (win) => {
          resolve(win.focused);
        });
      });
    });
  });
}

async function sendDistractionLog(status) {
  distractionCount++;
  const accountId = await getLocalStorage("account_id");
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const eventStatus = {
    "active": "ACTIVE",
    "noactive": "NO ACTIVE ON TAB"
  };
  if (!accountId) return;

  const payload = {
    account_id: accountId,
    status:eventStatus[status],  // "inactive" hoặc "active"
    note: distractionCount,
    created_at: timestamp,
  };

  try {
    await fetch(`${API_BASE_URL}/log-distraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Error logging distraction:", err);
  }
}

let ws;
const pendingMessages = [];
const checkinStatus = new Map();

window.addEventListener("DOMContentLoaded", () => {
  // DOM elements
  const loginSection = document.getElementById("login-section");
  const userInfo = document.getElementById("user-info");
  const controls = document.getElementById("controls");

  // WebSocket status hiển thị
  const wsStatus = document.createElement("div");
  wsStatus.id = "ws-status";
  wsStatus.style = "margin-top: 5px; font-size: 12px; color: gray;";
  controls.appendChild(wsStatus);

  // Tạo action buttons nếu chưa có
  const actionsDiv = document.getElementById("actions") || (() => {
    const div = document.createElement("div");
    div.id = "actions";
    div.style = "display: none; margin-top: 10px;";
    const buttons = [
      { event: "check-in", label: "Check In" },
      { event: "check-out", label: "Check Out" },
      { event: "check-in-again", label: "Check In Again" },
      { event: "break", label: "Break" },
      { event: "break-done", label: "Break Done" }
    ];
    buttons.forEach(({ event, label }) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.dataset.event = event;
      btn.style.marginRight = "5px";
      btn.disabled = true;
      div.appendChild(btn);
    });
    userInfo.insertAdjacentElement("afterend", div);
    return div;
  })();

  // Load thông tin từ storage
  chrome.storage.local.get(["employeeName", "currentState", "account_id"], (res) => {
    const { employeeName, currentState = "checked-out", account_id } = res;
    if (employeeName && account_id) {
      showLoggedInUI(employeeName);
      actionsDiv.style.display = "block";
      updateButtonStates(currentState);
    }
  });

  // Lắng nghe click của các action button
  actionsDiv.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const eventType = btn.dataset.event;
      if (eventType === "check-in-again") {
        const { value: reason } = await Swal.fire({
          title: "Lý do vào làm lại",
          input: "text",
          inputPlaceholder: "Nhập lý do...",
          showCancelButton: true,
          confirmButtonText: "Gửi"
        });
        if (!reason) return Swal.fire("Vui lòng nhập lý do!");
        sendEventLog(eventType, reason);
      } else {
        sendEventLog(eventType);
      }
    });
  });

  // Đăng nhập
  document.getElementById("login-button").addEventListener("click", () => {
    const username = document.getElementById("employee-username").value.trim();
    const password = document.getElementById("employee-password").value.trim();
    if (!username || !password) return Swal.fire("Nhập đủ tên đăng nhập và mật khẩu");
    safeSend({ type: "login", username, password });
  });

  // Logout
  document.getElementById("logout-button").addEventListener("click", async () => {
    const { currentState, account_id } = await chrome.storage.local.get(["currentState", "account_id"]);
    if (currentState !== "checked-out") return Swal.fire("⚠️ Vui lòng check-out trước khi logout.");
    if (!ws || ws.readyState !== WebSocket.OPEN) return Swal.fire("🔴 Mất kết nối. Tải lại extension.");

    const confirm = await Swal.fire({ title: "Bạn có chắc muốn logout?", icon: "question", showCancelButton: true });
    if (!confirm.isConfirmed) return;

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const payload = {
      type: "log-loginout",
      account_id,
      status: "logout",
      created_at: timestamp,
      request_id: "RQ" + Date.now()
    };
    ws.isCheckout = true;
    safeSend(payload);
  });

  // Kết nối WebSocket
  connectWebSocket();

  function connectWebSocket() {
    ws = new WebSocket("wss://chromextension-production.up.railway.app?source=popup");

    ws.onopen = () => {
      wsStatus.textContent = "🟢 Kết nối server thành công";
      while (pendingMessages.length > 0) ws.send(pendingMessages.shift());
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      // Xử lý login thành công
      if (data.success && data.name && data.id) {
        const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        safeSend({ type: "log-loginout", account_id: data.id, status: "login", created_at: timestamp });
        await chrome.storage.local.set({
          account_id: data.id,
          employeeName: data.name,
          sessionId: "SS" + Date.now(),
          currentState: "checked-out"
        });
        showLoggedInUI(data.name);
        actionsDiv.style.display = "block";
        updateButtonStates("checked-out");
        checkinStatus.set(data.id, true); // đánh dấu user đã checkin
        return;
      }

      // Force check-in lại nếu server yêu cầu
      if (data.type === "force-checkin") {
        showSystemNotification("SUDDEN - Checkin lại", data.message || "Bạn cần Check In lại");
        stopAutoScreenshot();
        await chrome.storage.local.set({ currentState: "force-checkin" });
        updateButtonStates("force-checkin");
        return;
      }

      // Xử lý sự kiện khác từ server
      if (data.success && data.type) {
        const stateMap = {
          "checkin": "checked-in",
          "checkout": "checked-out",
          "break_start": "on-break",
          "break_end": "checked-in",
          "check in again": "checked-in"
        };

        const commands = {
          "checkin": "start",
          "checkout": "stop",
          "break_start": "stop",
          "break_end": "start",
          "check in again": "checkin-again-done"
        };

        if (data.type === "log-loginout" && data.status === "logout") {
          chrome.runtime.sendMessage({ command: "stop" });
          await chrome.storage.local.clear();
          return Swal.fire("Logout thành công.").then(() => location.reload());
        }

        const newState = stateMap[data.type];
        if (newState) {
          await chrome.storage.local.set({ currentState: newState });
          updateButtonStates(newState);

          const command = commands[data.type];
          if (command) {
            if (command === "start") startAutoScreenshot(15);
            else chrome.runtime.sendMessage({ command });
          }
        }
      }

      if (!data.success && data.error) Swal.fire(data.error, "", "error");
    };

    ws.onerror = () => wsStatus.textContent = "🔴 WebSocket lỗi kết nối";
    ws.onclose = () => {
      wsStatus.textContent = "🔴 Mất kết nối, đang thử lại...";
      setTimeout(connectWebSocket, 5000);
    };
  }

  function showLoggedInUI(name) {
    document.getElementById("employee-name").innerText = `Hello, ${name}`;
    loginSection.style.display = "none";
    userInfo.style.display = "block";
    controls.style.display = "block";
    actionsDiv.style.display = "block";
  }

  function updateButtonStates(state) {
    actionsDiv.querySelectorAll("button").forEach(btn => btn.disabled = true);
    const stateButtons = {
      "checked-out": ["check-in"],
      "checked-in": ["check-out", "break"],
      "on-break": ["break-done"],
      "force-checkin": ["check-in-again"]
    };
    (stateButtons[state] || []).forEach(enable);
    document.getElementById("logout-button").disabled = (state !== "checked-out");
  }

  function enable(event) {
    const btn = actionsDiv.querySelector(`button[data-event="${event}"]`);
    if (btn) btn.disabled = false;
  }

  function startAutoScreenshot(interval) {
    chrome.runtime.sendMessage({ command: "start", interval });
  }

  async function sendEventLog(eventType, reason = "") {
    const { account_id, currentState = "checked-out" } = await chrome.storage.local.get(["account_id", "currentState"]);
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");

    const disallowed = {
      "check-in": currentState === "checked-in" || currentState === "on-break",
      "check-out": currentState !== "checked-in",
      "break": currentState !== "checked-in",
      "break-done": currentState !== "on-break"
    };
    if (disallowed[eventType]) return Swal.fire("Không hợp lệ logic thao tác.");

    const payload = {
      type: {
        "check-in": "log-work",
        "check-out": "log-work",
        "break": "log-break",
        "break-done": "log-break",
        "check-in-again": "log-incident"
      }[eventType],
      account_id,
      status: {
        "check-in": "checkin",
        "check-out": "checkout",
        "break": "break_start",
        "break-done": "break_end",
        "check-in-again": "check in again"
      }[eventType],
      created_at: timestamp,
      ...(reason && { reason })
    };

    safeSend(payload);
  }
});

// Gửi WebSocket an toàn (queue nếu chưa kết nối)
function safeSend(payload) {
  try {
    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (!payload.type) return Swal.fire("❌ Không thể gửi: thiếu `type`.");
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(message);
    else {
      console.warn("🔴 WebSocket chưa sẵn sàng:", ws?.readyState);
      pendingMessages.push(message);
    }
  } catch (err) {
    console.error("❌ Gửi WebSocket lỗi:", err.message);
  }
}

// Hiển thị thông báo hệ thống
function showSystemNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "bell.png",
    title,
    message,
    priority: 2
  });
}

let ws;
const pendingMessages = [];

window.addEventListener("DOMContentLoaded", () => {
  const loginSection = document.getElementById("login-section");
  const userInfo = document.getElementById("user-info");
  const controls = document.getElementById("controls");
  const wsStatus = document.createElement("div");
  wsStatus.id = "ws-status";
  wsStatus.style.marginTop = "5px";
  wsStatus.style.fontSize = "12px";
  wsStatus.style.color = "gray";
  controls.appendChild(wsStatus);

  const actionsDiv = document.getElementById("actions") || (() => {
    const div = document.createElement("div");
    div.id = "actions";
    div.style.display = "none";
    div.style.marginTop = "10px";
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
      btn.setAttribute("data-event", event);
      btn.style.marginRight = "5px";
      btn.disabled = true;
      div.appendChild(btn);
    });
    userInfo.insertAdjacentElement("afterend", div);
    return div;
  })();

  chrome.storage.local.get(["employeeName", "currentState", "account_id"], (result) => {
    const { employeeName, currentState = "checked-out", account_id } = result;
    if (employeeName && account_id) {
      showLoggedInUI(employeeName);
      actionsDiv.style.display = "block";
      updateButtonStates(currentState);
    }
  });

  actionsDiv.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      const eventType = button.getAttribute("data-event");
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

  document.getElementById("login-button").addEventListener("click", () => {
    const username = document.getElementById("employee-username").value.trim();
    const password = document.getElementById("employee-password").value.trim();
    if (!username || !password) return Swal.fire("Nhập đủ tên đăng nhập và mật khẩu");
    safeSend({ type: "login", username, password });
  });

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
    safeSend(payload);
  });

  connectWebSocket();

  function connectWebSocket() {
    ws = new WebSocket("wss://chromextension-production.up.railway.app");

    ws.onopen = () => {
      wsStatus.textContent = "🟢 Kết nối server thành công";
      while (pendingMessages.length > 0) {
        ws.send(pendingMessages.shift());
      }
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

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
        return;
      }

      if (data.type === "force-checkin") {
    // Hiển thị thông báo hệ thống
        showSystemNotification("SUDDEN - Checkin lại", data.message || "Bạn cần Check In lại để tiếp tục làm việc");

        // ... phần xử lý như cũ:
        stopAutoScreenshot();
        await chrome.storage.local.set({ currentState: "force-checkin" });
        updateButtonStates("force-checkin");
        return;
        }

      if (data.success && data.type) {
        let nextState;
        switch (data.type) {
          case "checkin":
            nextState = "checked-in";
            startAutoScreenshot(20);
            break;
          case "checkout":
            nextState = "checked-out";
            chrome.runtime.sendMessage({ command: "stop" });
            break;
          case "break_start":
            nextState = "on-break";
            chrome.runtime.sendMessage({ command: "stop" });
            break;
          case "break_end":
            nextState = "checked-in";
            startAutoScreenshot(20);
            break;
          case "log-loginout":
            if (data.status === "logout") {
              chrome.runtime.sendMessage({ command: "stop" });
              await chrome.storage.local.clear();
              Swal.fire("Logout thành công.").then(() => location.reload());
              return;
            }
            break;
          case "check in again":
            nextState = "checked-in";
            startAutoScreenshot(20);
            chrome.runtime.sendMessage({ command: "checkin-again-done" });
            break;
        }

        if (nextState) {
          await chrome.storage.local.set({ currentState: nextState });
          updateButtonStates(nextState);
        }
      }

      if (!data.success && data.error) Swal.fire(data.error, "", "error");
    };

    ws.onerror = () => {
      wsStatus.textContent = "🔴 WebSocket lỗi kết nối";
    };

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
    switch (state) {
      case "checked-out": enable("check-in"); break;
      case "checked-in": enable("check-out"); enable("break"); break;
      case "on-break": enable("break-done"); break;
      case "force-checkin": enable("check-in-again"); break;
    }
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

    const eventStatusMap = {
      "check-in": "checkin",
      "check-out": "checkout",
      "break": "break_start",
      "break-done": "break_end",
      "check-in-again": "check in again"
    };
    const typeMap = {
      "check-in": "log-work",
      "check-out": "log-work",
      "break": "log-break",
      "break-done": "log-break",
      "check-in-again": "log-incident"
    };

    const payload = {
      type: typeMap[eventType],
      account_id,
      status: eventStatusMap[eventType],
      created_at: timestamp
    };
    if (reason) payload.reason = reason;
    safeSend(payload);
  }
});

function safeSend(payload) {
  try {
    const str = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (!payload.type) return Swal.fire("❌ Không thể gửi: thiếu `type`.");
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(str);
    } else {
      console.warn("🔴 WebSocket chưa sẵn sàng:", ws?.readyState);
      pendingMessages.push(str);
    }
  } catch (err) {
    console.error("❌ Gửi WebSocket lỗi:", err.message);
  }
}


function showSystemNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "bell.png", // Đảm bảo file này có trong thư mục extension
    title,
    message,
    priority: 2
  });
}
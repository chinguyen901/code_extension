let ws;
const pendingMessages = [];

window.addEventListener("DOMContentLoaded", async () => {
  const { currentState } = await chrome.storage.local.get("currentState");

  const loginSection = document.getElementById("login-section");
  const userInfo = document.getElementById("user-info");
  const controls = document.getElementById("controls");

  const wsStatus = document.createElement("div");
  wsStatus.id = "ws-status";
  wsStatus.style = "margin-top:5px;font-size:12px;color:gray;";
  controls.appendChild(wsStatus);

  const actionsDiv = document.getElementById("actions");
  // Nếu không tồn tại element, báo lỗi UI cần giữ nguyên
  if (!actionsDiv) {
    console.error("Không tìm thấy div#actions – vui lòng giữ nguyên giao diện HTML!");
    return;
  }

  // 👂 Lắng nghe từ background/service-worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "force-checkin") {
      chrome.storage.local.set({ currentState: "force-checkin" }, () => {
        updateButtonStates("force-checkin");
        showSystemNotification("⚠️ Check In Again", msg.message || "Bạn vừa mất kết nối, vui lòng Check‑in lại.");
      });
    }
  });

  // Khi mở popup mà đang ở trạng thái force-checkin
  if (currentState === "force-checkin") {
    updateButtonStates("force-checkin");
  }

  // Gắn event click đúng vị trí sau khi DOM load
  actionsDiv.querySelectorAll("button[data-event]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const eventType = btn.dataset.event;
      if (eventType === "check-in-again") {
        const { value: reason } = await Swal.fire({
          title: "Lý do Check‑in lại",
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

  // Khởi động UI nếu đã login
  chrome.storage.local.get(["employeeName", "currentState", "account_id"], (res) => {
    const { employeeName, account_id } = res;
    const st = res.currentState || "checked-out";
    if (employeeName && account_id) {
      showLoggedInUI(employeeName);
      updateButtonStates(st);
    }
  });

  // Đăng nhập
  document.getElementById("login-button").addEventListener("click", () => {
    const u = document.getElementById("employee-username").value.trim();
    const p = document.getElementById("employee-password").value.trim();
    if (!u || !p) return Swal.fire("Nhập đủ tên đăng nhập và mật khẩu");
    safeSend({ type: "login", username: u, password: p });
  });

  // Logout
  document.getElementById("logout-button").addEventListener("click", async () => {
    const { currentState, account_id } = await chrome.storage.local.get(["currentState", "account_id"]);
    if (currentState !== "checked-out") return Swal.fire("⚠️ Vui lòng check‑out trước khi logout.");
    if (!ws || ws.readyState !== WebSocket.OPEN) return Swal.fire("🔴 Mất kết nối đến server");

    const cf = await Swal.fire({ title: "Logout?", icon: "question", showCancelButton: true });
    if (!cf.isConfirmed) return;

    const t = new Date().toISOString().slice(0,19).replace("T"," ");
    ws.isCheckout = true;
    safeSend({
      type: "log-loginout",
      account_id,
      status: "logout",
      created_at: t,
      request_id: "RQ" + Date.now()
    });
  });

  // Kết nối WebSocket
  connectWebSocket();

  function connectWebSocket() {
    ws = new WebSocket("wss://chromextension-production.up.railway.app?source=popup");
    ws.onopen = () => {
      wsStatus.textContent = "🟢 Đã kết nối server";
      while (pendingMessages.length > 0) ws.send(pendingMessages.shift());
    };
    ws.onmessage = async (e) => {
      const data = JSON.parse(e.data);

      // Xử lý login thành công
      if (data.success && data.name && data.id) {
        const t = new Date().toISOString().slice(0,19).replace("T"," ");
        safeSend({ type: "log-loginout", account_id: data.id, status: "login", created_at: t });
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

      // Xử lý sau khi gửi log-incident thành công
      if (data.success && data.type === 'check in again') {
        await chrome.storage.local.set({ currentState: 'checked-in' });
        updateButtonStates('checked-in');
        chrome.runtime.sendMessage({ command: 'checkin-again-done', interval: 15 });
      }

      // Xử lý các trạng thái khác
      if (data.success && data.type) {
        const mapState = {
          checkin: "checked-in",
          checkout: "checked-out",
          break_start: "on-break",
          break_end: "checked-in"
        };
        const cmds = {
          checkin: "start",
          checkout: "stop",
          break_start: "stop",
          break_end: "start"
        };
        if (data.type === "log-loginout" && data.status === "logout") {
          chrome.runtime.sendMessage({ command: "stop" });
          await chrome.storage.local.clear();
          return Swal.fire("Logout thành công.").then(() => location.reload());
        }
        const ns = mapState[data.type];
        if (ns) {
          await chrome.storage.local.set({ currentState: ns });
          updateButtonStates(ns);
          const cmd = cmds[data.type];
          if (cmd) {
            if (cmd === "start") startAutoScreenshot(15);
            else chrome.runtime.sendMessage({ command: cmd });
          }
        }
      }

      if (!data.success && data.error) Swal.fire(data.error, "", "error");
    };
    ws.onerror = () => wsStatus.textContent = "🔴 WebSocket lỗi";
    ws.onclose = () => {
      wsStatus.textContent = "🔴 Mất kết nối, thử lại sau 5s...";
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
    const stMap = {
      "checked-out": ["check-in"],
      "checked-in": ["check-out", "break"],
      "on-break": ["break-done"],
      "force-checkin": ["check-in-again"]
    };
    (stMap[state] || []).forEach(ev => {
      const b = actionsDiv.querySelector(`button[data-event="${ev}"]`);
      if (b) b.disabled = false;
    });
    document.getElementById("logout-button").disabled = (state !== "checked-out");
  }

  function startAutoScreenshot(interval) {
    chrome.runtime.sendMessage({ command: "start", interval });
  }

  async function sendEventLog(eventType, reason = "") {
    if (typeof eventType !== "string") {
      console.error("❌ sendEventLog nhận eventType không hợp lệ:", eventType);
      return;
    }

    const { account_id, currentState = "checked-out" } = await chrome.storage.local.get(["account_id", "currentState"]);
    const invalid = {
      "check-in": currentState === "checked-in" || currentState === "on-break",
      "check-out": currentState !== "checked-in",
      "break": currentState !== "checked-in",
      "break-done": currentState !== "on-break",
      "check-in-again": currentState !== "force-checkin"
    };

    if (invalid[eventType]) {
      return Swal.fire("Không hợp lệ thao tác.");
    }

    const t = new Date().toISOString().slice(0, 19).replace("T", " ");

    // Xác định đúng type gửi lên server
    let msgType;
    if (eventType === "check-in-again") msgType = "log-incident";
    else if (eventType.startsWith("check")) msgType = "log-work";
    else msgType = "log-break";

    const statusMap = {
      "check-in": "checkin",
      "check-out": "checkout",
      "break": "break_start",
      "break-done": "break_end",
      "check-in-again": "check in again"
    };
    
    const payload = {
      type: msgType,
      account_id,
      status: statusMap[eventType],
      created_at: t,
    };
    if (reason) payload.reason = reason;
    chrome.runtime.sendMessage({ command: "update-badge", state: statusMap[eventType] });
    safeSend(payload);
  }


  function safeSend(payload) {
    const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (!payload.type) return Swal.fire("❌ Tin gửi thiếu kiểu.");
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
    else pendingMessages.push(msg);
  }

  function showSystemNotification(title, message) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "bell.png",
      title,
      message,
      priority: 2
    });
  }
});

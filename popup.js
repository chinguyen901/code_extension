let screenshotIntervalId = null;

window.addEventListener("DOMContentLoaded", () => {
  const loginSection = document.getElementById("login-section");
  const userInfo = document.getElementById("user-info");
  const controls = document.getElementById("controls");

  let actionsDiv = document.getElementById("actions");
  if (!actionsDiv) {
    actionsDiv = document.createElement("div");
    actionsDiv.id = "actions";
    actionsDiv.style.display = "none";
    actionsDiv.style.marginTop = "10px";

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
      actionsDiv.appendChild(btn);
    });

    userInfo.insertAdjacentElement('afterend', actionsDiv);
  }

  // Load trạng thái lưu trữ cũ nếu có
  chrome.storage.local.get(["employeeName", "currentState", "account_id"], (result) => {
    const employeeName = result.employeeName;
    const currentState = result.currentState || "checked-out";
    const accountId = result.account_id; // Sử dụng account_id để xác định người dùng

    if (employeeName && accountId) {
      showLoggedInUI(employeeName, loginSection, userInfo, controls, actionsDiv);
      updateButtonStates(currentState);
    }
  });

  // Gán sự kiện cho các nút hành động
  actionsDiv.querySelectorAll("button").forEach(button => {
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
        if (!reason) {
          Swal.fire("Reason is required!");
          return;
        }
        sendEventLog(eventType, reason);
        chrome.runtime.sendMessage({ command: "checkin-again-done" });
      } else {
        sendEventLog(eventType);
      }
    });
  });

  // Xử lý nút Login
  document.getElementById("login-button").addEventListener("click", () => {
    const username = document.getElementById("employee-username").value.trim();
    const password = document.getElementById("employee-password").value.trim();

    if (!username || !password) {
      Swal.fire("Please enter both username and password", "", "warning");
      return;
    }

    chrome.runtime.sendMessage({ command: "login", username: username, password: password }, (data) => {
      if (data.success) {
        const sessionId = "SS" + Date.now();
        chrome.storage.local.set({
          account_id: data.id, // Lưu account_id thay vì employeeId
          employeeName: data.name,
          sessionId: sessionId,
          currentState: "checked-out"
        }, () => {
          showLoggedInUI(data.name, loginSection, userInfo, controls, actionsDiv);
          updateButtonStates("checked-out");
        });
      } else {
        Swal.fire("Invalid username or password.", "", "error");
      }
    });
  });

  // Xử lý nút Logout
  document.getElementById("logout-button").addEventListener("click", () => {
    chrome.storage.local.get(["currentState"], async (result) => {
      const currentState = result.currentState || "checked-out";

      if (currentState !== "checked-out") {
        await Swal.fire("Bạn cần Check Out trước khi đăng xuất.", "", "warning");
        return;
      }

      const confirm = await Swal.fire({
        title: "Xác nhận đăng xuất?",
        icon: "question",
        showCancelButton: true,
        confirmButtonText: "Đăng xuất"
      });

      if (!confirm.isConfirmed) return;

      chrome.storage.local.clear(() => {
        stopAutoScreenshot();
        Swal.fire("Bạn đã đăng xuất thành công.", "", "success").then(() => {
          location.reload();
        });
      });
    });
  });

  // Hiển thị UI sau khi đăng nhập thành công
  function showLoggedInUI(name, loginSection, userInfo, controls, actionsDiv) {
    document.getElementById("employee-name").innerText = `Hello, ${name}`;
    loginSection.style.display = "none";
    userInfo.style.display = "block";
    controls.style.display = "block";
    actionsDiv.style.display = "block";
  }

  // Bật/tắt các nút dựa trên trạng thái hiện tại
  function updateButtonStates(state) {
    const buttons = actionsDiv.querySelectorAll("button");
    buttons.forEach(btn => btn.disabled = true);

    switch (state) {
      case "checked-out":
        enable("check-in");
        setLogoutButtonEnabled(true);
        break;
      case "checked-in":
        enable("check-out");
        enable("break");
        setLogoutButtonEnabled(false);
        break;
      case "on-break":
        enable("break-done");
        setLogoutButtonEnabled(false);
        break;
    }
    enable("check-in-again");
  }

  // Kích hoạt nút theo tên sự kiện
  function enable(event) {
    const btn = actionsDiv.querySelector(`button[data-event="${event}"]`);
    if (btn) btn.disabled = false;
  }

  // Bật/tắt nút Logout
  function setLogoutButtonEnabled(enabled) {
    const logoutBtn = document.getElementById("logout-button");
    if (logoutBtn) {
      logoutBtn.disabled = !enabled;
    }
  }

  // Bắt đầu tự chụp màn hình mỗi X giây
  function startAutoScreenshot(intervalSeconds) {
    if (screenshotIntervalId) clearInterval(screenshotIntervalId);
    chrome.runtime.sendMessage({ command: "start", interval: intervalSeconds });
  }

  // Dừng tự chụp màn hình
  function stopAutoScreenshot() {
    if (screenshotIntervalId) {
      clearInterval(screenshotIntervalId);
      screenshotIntervalId = null;
    }
    chrome.runtime.sendMessage({ command: "stop" });
  }

  // Gửi log sự kiện (check-in, check-out, break, v.v.)
  function sendEventLog(eventType, reason = "") {
    chrome.storage.local.get(["account_id", "sessionId", "currentState"], (result) => {
      const accountId = result.account_id; // Sử dụng account_id thay vì employeeId
      const sessionId = result.sessionId;
      const currentState = result.currentState || "checked-out";

      const disallowedMessages = {
        "check-in": "Bạn đã check-in rồi. Vui lòng check-out trước.",
        "check-out": "Bạn cần check-in trước khi check-out.",
        "break": "Bạn đang trong thời gian nghỉ. Vui lòng kết thúc break trước.",
        "break-done": "Bạn chưa bắt đầu break để kết thúc."
      };

      const disallowed = {
        "check-in": currentState === "checked-in" || currentState === "on-break",
        "check-out": currentState !== "checked-in",
        "break": currentState !== "checked-in",
        "break-done": currentState !== "on-break"
      };

      if (disallowed[eventType]) {
        Swal.fire(disallowedMessages[eventType]);
        return;
      }

      const now = new Date();
      const timestamp = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');

      const type = (["break", "break-done", "check-in-again"].includes(eventType)) ? reason : "";
      const source = "user";
      const eventStatusMap = {
        "check-in": "Vào ca",
        "check-out": "Tan ca",
        "break": "Bắt đầu giải lao",
        "break-done": "Kết thúc giải lao",
        "check-in-again": "Vào làm việc lại sau sự cố"
      };
      const reason = eventStatusMap[eventType] || "";
      const logData = {
        account_id: accountId, // Sử dụng account_id đúng
        status: eventType,
        reason: reason,  // Lý do cho sự kiện
        created_at: timestamp,
      };

      chrome.runtime.sendMessage({ command: "logEvent", data: logData }, (response) => {
        if (response.success) {
          console.log("Event log success:", response);
          // Start screenshot after check-in
          if (eventType === "check-in") {
            startAutoScreenshot(20); // Bắt đầu tự chụp màn hình sau khi check-in
          }
        } else {
          console.error("Event log failed:", response.error);
        }
      });
    });
  }
});

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

  chrome.storage.local.get(["employeeName", "currentState", "account_id"], (result) => {
    const { employeeName, currentState = "checked-out", account_id } = result;
    if (employeeName && account_id) {
      showLoggedInUI(employeeName, loginSection, userInfo, controls, actionsDiv);
      updateButtonStates(currentState);
    }
  });

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

  document.getElementById("login-button").addEventListener("click", () => {
    const username = document.getElementById("employee-username").value.trim();
    const password = document.getElementById("employee-password").value.trim();

    if (!username || !password) {
      Swal.fire("Please enter both username and password", "", "warning");
      return;
    }

    chrome.runtime.sendMessage({ command: "login", username, password }, (data) => {
      if (data.success) {
        const sessionId = "SS" + Date.now();
        chrome.storage.local.set({
          account_id: data.id,
          employeeName: data.name,
          sessionId,
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

  document.getElementById("logout-button").addEventListener("click", () => {
    chrome.storage.local.get(["currentState", "account_id"], async (result) => {
      const currentState = result.currentState || "checked-out";
      const accountId = result.account_id;

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

      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      chrome.runtime.sendMessage({
        command: "logLoginout",
        data: {
          account_id: accountId,
          status: "logout",
          created_at: timestamp
        }
      }, (response) => {
        if (response.success) {
          chrome.storage.local.clear(() => {
            stopAutoScreenshot();
            Swal.fire("Bạn đã đăng xuất thành công.", "", "success").then(() => {
              location.reload();
            });
          });
        } else {
          console.error("❌ Gửi log logout thất bại:", response.error);
          Swal.fire("Lỗi khi gửi log logout.", "", "error");
        }
      });
    });
  });

  function showLoggedInUI(name, loginSection, userInfo, controls, actionsDiv) {
    document.getElementById("employee-name").innerText = `Hello, ${name}`;
    loginSection.style.display = "none";
    userInfo.style.display = "block";
    controls.style.display = "block";
    actionsDiv.style.display = "block";
  }

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

  function enable(event) {
    const btn = actionsDiv.querySelector(`button[data-event="${event}"]`);
    if (btn) btn.disabled = false;
  }

  function setLogoutButtonEnabled(enabled) {
    const logoutBtn = document.getElementById("logout-button");
    if (logoutBtn) logoutBtn.disabled = !enabled;
  }

  function startAutoScreenshot(intervalSeconds) {
    if (screenshotIntervalId) clearInterval(screenshotIntervalId);
    chrome.runtime.sendMessage({ command: "start", interval: intervalSeconds });
  }

  function stopAutoScreenshot() {
    if (screenshotIntervalId) {
      clearInterval(screenshotIntervalId);
      screenshotIntervalId = null;
    }
    chrome.runtime.sendMessage({ command: "stop" });
  }

  function sendEventLog(eventType, reason = "") {
    chrome.storage.local.get(["account_id", "sessionId", "currentState"], (result) => {
      const { account_id: accountId, sessionId, currentState = "checked-out" } = result;

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
      const timestamp = now.toISOString().slice(0, 19).replace("T", " ");

      const eventStatusMap = {
        "check-in": "checkin",
        "check-out": "checkout",
        "break": "break_start",
        "break-done": "break_end",
        "check-in-again": "check in again"
      };



      let targetCommand;
      if (["break", "break-done"].includes(eventType)) {
        targetCommand = "logBreak";
      } else if (["check-in", "check-out"].includes(eventType)) {
        targetCommand = "logWork";
      } else if (eventType === "check-in-again") {
        targetCommand = "logIncident";
      } else {
        console.warn("❗ Unknown eventType:", eventType);
        return; // hoặc handle riêng
      }

      const logData = {
        account_id: accountId,
        status: eventStatusMap[eventType],
        reason: reason,
        created_at: timestamp
      };

      chrome.runtime.sendMessage({ command: targetCommand, data: logData }, (response) => {
        if (response.success) {
          console.log("Event log success:", response);

          let nextState = currentState;
          switch (eventType) {
            case "check-in":
              nextState = "checked-in";
              startAutoScreenshot(20);
              break;
            case "check-out":
              nextState = "checked-out";
              stopAutoScreenshot();
              break;
            case "break":
              nextState = "on-break";
              break;
            case "break-done":
              nextState = "checked-in";
              break;
          }

          chrome.storage.local.set({ currentState: nextState }, () => {
            updateButtonStates(nextState);
          });

        } else {
          console.error("Event log failed:", response.error);
        }
      });
    });
  }
});

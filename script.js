const tenant = document.getElementById("tenant");
const resource = document.getElementById("resource");
const lockStatus = document.getElementById("lockStatus");
const tokenStatus = document.getElementById("tokenStatus");
const log = document.getElementById("log");
const leaseDurationInput = document.getElementById("leaseDuration");
const manualLeader = document.getElementById("manualLeader");

const tenants = ["Tenant A", "Tenant B" ,"Tenant C"];
const locks = new Map();

let fencingToken = 0;
let leaderNode = 2;
let failedNode = null;
let recoveryTimer = null;

// Populate tenant choices.
function populateTenants() {
  const previous = tenant.value;
  tenant.replaceChildren();

  tenants.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    tenant.appendChild(option);
  });

  tenant.value = tenants.includes(previous) ? previous : tenants[0];
}

function addLog(message) {
  const item = document.createElement("li");
  item.textContent =
    new Date().toLocaleTimeString() + " — " + message;
  log.prepend(item);
  sendLogToAWS(message);
}

function selectedResource() {
  return resource.value.trim();
}

function getLeaseSeconds() {
  return Number(leaseDurationInput.value) || 10;
}

function updateDashboard() {
  const healthy = failedNode === null;

  document.getElementById("clusterHealth").textContent =
    healthy ? "Cluster Healthy" : "Leader Failure";

  document.getElementById("healthMetric").textContent =
    healthy ? "Healthy" : "Recovering";

  document.getElementById("activeMetric").textContent =
    locks.size === 0 ? "None" : locks.size + " resource(s)";

  document.getElementById("activeDetail").textContent =
    locks.size === 0 ? "No resources are locked" :
    "Active locks across resources";

  document.getElementById("leaderMetric").textContent =
    healthy ? "Node " + leaderNode : "Electing...";

  document.getElementById("leaderDetail").textContent =
    healthy ? "AZ-" + leaderNode + " · Current leader" :
    "Leader recovery in progress";

  document.getElementById("tokenMetric").textContent = fencingToken;

  document.querySelector(".top-status .status-dot").style.background =
    healthy ? "#35c98a" : "#f16f78";

  manualLeader.value = String(leaderNode);
  manualLeader.disabled = !healthy;

  document.getElementById("setLeaderBtn").disabled = !healthy;
  document.getElementById("crashBtn").disabled = !healthy;

  updateNodes();
}

function updateNodes() {
  for (let i = 1; i <= 3; i++) {
    const node = document.getElementById("node" + i);
    node.classList.remove("leader", "failed");

    const role = node.querySelector(".node-role");

    if (failedNode === i) {
      node.classList.add("failed");
      role.textContent = "Failed";
    } else if (failedNode === null && leaderNode === i) {
      node.classList.add("leader");
      role.textContent = "Leader";
    } else {
      role.textContent = "Follower";
    }
  }
}

function updateLockStatus() {
  const name = selectedResource();
  const lock = locks.get(name);

  if (lock) {
    lockStatus.textContent =
      "Status: " + name + " is held by " + lock.owner + ".";

    document.getElementById("activeDetailConsole").textContent =
      "Owned by " + lock.owner;
  } else {
    lockStatus.textContent = "Status: Lock is available.";

    document.getElementById("activeDetailConsole").textContent =
      "No active lock on this resource";
  }

  document.querySelector(".state-indicator").style.background =
    lock ? "#f0b44d" : "#35c98a";

  tokenStatus.textContent =
    "Last fencing token: " + (lock ? lock.token : fencingToken);

  updateLeaseCountdown();
  updateDashboard();
}

function updateLeaseCountdown() {
  const lock = locks.get(selectedResource());
  const leaseStatus = document.getElementById("leaseStatus");

  if (!lock) {
    leaseStatus.textContent = "No active lease";
    return;
  }

  const remaining = Math.max(
    0,
    Math.ceil((lock.expiresAt - Date.now()) / 1000)
  );

  leaseStatus.textContent = remaining + " seconds";
}

function clearLockTimers(lock) {
  clearTimeout(lock.timer);
  clearInterval(lock.countdown);
}

function releaseExpiredLock(name, expectedToken) {
  const lock = locks.get(name);

  // Ignore an old timer if the lock was replaced.
  if (!lock || lock.token !== expectedToken) return;

  clearLockTimers(lock);
  locks.delete(name);

  addLog("Lease expired for " + lock.owner +
    " on " + name + ". Lock released.");

  updateLockStatus();
}

function createLock(name, owner, duration) {
  fencingToken++;

  const lock = {
    owner,
    token: fencingToken,
    expiresAt: Date.now() + duration * 1000,
    timer: null,
    countdown: null
  };

  locks.set(name, lock);

  lock.timer = setTimeout(
    () => releaseExpiredLock(name, lock.token),
    duration * 1000
  );

  lock.countdown = setInterval(() => {
    if (selectedResource() === name) {
      updateLeaseCountdown();
    }
  }, 250);

  return lock;
}

// Add another tenant.
document.getElementById("addTenantBtn").addEventListener("click", () => {
  const name = prompt("Enter a new tenant name:");

  if (name === null) return;

  const cleaned = name.trim();

  if (!cleaned) {
    alert("Tenant name cannot be empty.");
    return;
  }

  if (tenants.some((t) => t.toLowerCase() === cleaned.toLowerCase())) {
    alert("That tenant already exists.");
    return;
  }

  tenants.push(cleaned);
  populateTenants();
  tenant.value = cleaned;

  addLog(cleaned + " added to the tenant list.");
  updateLockStatus();
});


document.getElementById("renameTenantBtn").addEventListener("click", () => {
  const oldName = tenant.value;
  const newName = prompt("Enter the new tenant name:", oldName);

  if (newName === null) return;

  const cleaned = newName.trim();

  if (!cleaned) {
    alert("Tenant name cannot be empty.");
    return;
  }

  if (
    tenants.some((t) =>
      t.toLowerCase() === cleaned.toLowerCase() && t !== oldName
    )
  ) {
    alert("A tenant with that name already exists.");
    return;
  }

  // Do not rename a tenant while it owns an active lock.
  const ownsLock = Array.from(locks.values()).some(
    (lock) => lock.owner === oldName
  );

  if (ownsLock) {
    alert("Release this tenant's active locks before renaming it.");
    return;
  }

  const index = tenants.indexOf(oldName);
  if (index === -1) return;

  tenants[index] = cleaned;
  populateTenants();
  tenant.value = cleaned;

  addLog("Tenant renamed from " + oldName + " to " + cleaned + ".");
  updateLockStatus();
});

document.getElementById("deleteTenantBtn").addEventListener("click", () => {
  const name = tenant.value;

  if (tenants.length <= 1) {
    alert("At least one tenant must remain.");
    return;
  }

  const ownsLock = Array.from(locks.values()).some(
    (lock) => lock.owner === name
  );

  if (ownsLock) {
    alert("Release this tenant's active locks before deleting it.");
    return;
  }

  if (!confirm("Delete " + name + "?")) return;

  const index = tenants.indexOf(name);
  if (index === -1) return;

  tenants.splice(index, 1);
  populateTenants();

  addLog(name + " was deleted from the tenant list.");
  updateLockStatus();
});
  

// Acquire a lock.
document.getElementById("acquireBtn").addEventListener("click", () => {
  const name = selectedResource();
  const owner = tenant.value;

  if (!name) {
    addLog("Request rejected: Enter a resource name.");
    return;
  }

  if (failedNode !== null) {
    addLog("Request rejected: Leader election is in progress.");
    return;
  }

  const existing = locks.get(name);

  if (existing) {
    addLog("Lock denied to " + owner + ": " + name +
      " is held by " + existing.owner + ".");
    return;
  }

  const duration = getLeaseSeconds();
  const lock = createLock(name, owner, duration);

  addLog(owner + " acquired " + name +
    " with fencing token " + lock.token +
    ". Lease: " + duration + " seconds.");

  updateLockStatus();
});

// Release a lock owned by the selected tenant.
document.getElementById("releaseBtn").addEventListener("click", () => {
  const name = selectedResource();
  const lock = locks.get(name);

  if (!lock) {
    addLog("No active lock exists for " + name + ".");
    return;
  }

  if (lock.owner !== tenant.value) {
    addLog("Release denied: " + tenant.value +
      " does not own the lock on " + name + ".");
    return;
  }

  clearLockTimers(lock);
  locks.delete(name);

  addLog(lock.owner + " released " + name + ".");
  updateLockStatus();
});

// Manually choose the leader.
document.getElementById("setLeaderBtn").addEventListener("click", () => {
  if (failedNode !== null) {
    addLog("Cannot manually select a leader during failure recovery.");
    return;
  }

  leaderNode = Number(manualLeader.value);
  updateDashboard();

  addLog("Manual simulation: Node " + leaderNode +
    " selected as leader.");
});

// Simulate the current leader failing.
document.getElementById("crashBtn").addEventListener("click", () => {
  if (failedNode !== null) {
    addLog("A node failure is already being simulated.");
    return;
  }

  failedNode = leaderNode;

  addLog("Node " + failedNode + " failed. Simulating leader election.");
  updateDashboard();

  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;

    // Choose the next node in the three-node cycle.
    leaderNode = (failedNode % 3) + 1;
    const previous = failedNode;
    failedNode = null;

    updateDashboard();

    addLog("Simulated recovery completed. Node " +
      leaderNode + " is now leader; Node " + previous +
      " is shown as recovered.");
  }, 2000);
});

// Reset all locks and return to the initial leader.
document.getElementById("recoverBtn").addEventListener("click", () => {
  clearTimeout(recoveryTimer);
  recoveryTimer = null;

  for (const lock of locks.values()) {
    clearLockTimers(lock);
  }

  locks.clear();
  failedNode = null;
  leaderNode = 2;

  // Keep fencing tokens increasing rather than reusing old tokens.
  updateLockStatus();
  addLog("Cluster reset. Node 2 is the initial leader; all locks cleared.");
});

// Clear only the visible event history.
document.getElementById("clearBtn").addEventListener("click", () => {
  log.replaceChildren();
});

// Update the lock details when the user changes resource or tenant.
resource.addEventListener("input", updateLockStatus);
tenant.addEventListener("change", updateLockStatus);


const useCases = {
  file: {
    title: "Shared File Editing",
    description:
      "Coordinate access when multiple users want to edit the same file.",
    resource: "project-report.docx"
  },
  inventory: {
    title: "E-commerce Inventory",
    description:
      "Coordinate competing updates to the stock of a product.",
    resource: "product-123-stock"
  },
  job: {
    title: "Scheduled Cloud Job",
    description:
      "Coordinate which worker may run a scheduled job.",
    resource: "nightly-report-job"
  },
  database: {
    title: "Shared Database Record",
    description:
      "Coordinate updates to a shared customer or business record.",
    resource: "customer-record-456"
  }
};

function displayUseCase() {
  const selected = document.getElementById("useCase").value;
  const scenario = useCases[selected];

  document.getElementById("useCaseTitle").textContent = scenario.title;
  document.getElementById("useCaseDescription").textContent =
    scenario.description;
  document.getElementById("useCaseResource").textContent =
    scenario.resource;
}

document.getElementById("useCase").addEventListener("change", displayUseCase);

document.getElementById("loadUseCaseBtn").addEventListener("click", () => {
  const selected = document.getElementById("useCase").value;
  const scenario = useCases[selected];

  resource.value = scenario.resource;
  updateLockStatus();

  addLog("Loaded scenario: " + scenario.title +
    " · Resource: " + scenario.resource + ".");

  document.getElementById("lockStatus").textContent =
    "Status: Ready to test " + scenario.resource + ".";
});

displayUseCase();


populateTenants();
manualLeader.value = "2";
updateLockStatus();
addLog("LockGuard initialized. Three-node cluster simulation is ready.");


// Added monitoring metrics. These are browser-generated demo values, not live server telemetry.
(function initializeMonitoring() {
  const $ = (id) => document.getElementById(id);
  const history = { incoming: [], outgoing: [] };
  const maxSamples = 24;
  const apiStats = { total: 0, success: 0, failed: 0 };
  let latest = {};

  function setBar(id, value, max = 100) {
    const el = $(id);
    if (el) el.style.width = Math.max(0, Math.min(100, (value / max) * 100)) + "%";
  }

  function randomBetween(min, max) {
    return Math.round(min + Math.random() * (max - min));
  }

  function recordApiCall(success = true) {
    apiStats.total++;
    if (success) apiStats.success++;
    else apiStats.failed++;
    renderApiStats();
  }

  function renderApiStats() {
    $("apiCalls").textContent = apiStats.total.toLocaleString();
    $("apiSuccess").textContent = apiStats.success.toLocaleString();
    $("apiFailed").textContent = apiStats.failed.toLocaleString();
    setBar("apiBar", apiStats.total ? (apiStats.success / apiStats.total) * 100 : 0);
    $("errorRate").textContent = apiStats.total
      ? ((apiStats.failed / apiStats.total) * 100).toFixed(1)
      : "0.0";
    setBar("errorBar", apiStats.total ? (apiStats.failed / apiStats.total) * 100 : 0);
  }

  function drawTrafficChart() {
    const canvas = $("trafficChart");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, rect.width);
    const height = 170;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const pad = { left: 8, right: 8, top: 12, bottom: 18 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const maxVal = Math.max(20, ...history.incoming, ...history.outgoing) * 1.2;

    ctx.font = "10px Segoe UI, Arial";
    ctx.fillStyle = "#93a4bb";
    ctx.strokeStyle = "#28374d";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.top + (chartH * i / 3);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    function drawLine(values, color) {
      if (!values.length) return;
      ctx.beginPath();
      values.forEach((value, i) => {
        const x = pad.left + (values.length === 1 ? chartW : (i / (values.length - 1)) * chartW);
        const y = pad.top + chartH - (value / maxVal) * chartH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    drawLine(history.incoming, "#4f8cff");
    drawLine(history.outgoing, "#35c98a");
  }

  function updateServices() {
    const failed = typeof failedNode !== "undefined" && failedNode !== null;
    const nodeCount = failed ? 2 : 3;
    $("nodeHealth").textContent = nodeCount + " / 3 Healthy";
    $("nodeHealthDot").className = "service-dot" + (failed ? " warning" : "");
    $("apiHealth").textContent = "Operational";
    $("apiHealthDot").className = "service-dot";
    $("dbHealth").textContent = "Operational";
    $("dbHealthDot").className = "service-dot";
    $("lockHealth").textContent = failed ? "Recovering" : "Operational";
    $("lockHealthDot").className = "service-dot" + (failed ? " warning" : "");
  }

  function updateMetrics() {
    const traffic = randomBetween(35, 145);
    const cpu = randomBetween(18, 78);
    const memory = randomBetween(35, 82);
    const queries = randomBetween(12, 95);
    const connections = randomBetween(12, 68);
    const response = randomBetween(35, 240);
    const incoming = randomBetween(8, 75);
    const outgoing = randomBetween(5, 55);

    latest = { traffic, cpu, memory, queries, connections, response, incoming, outgoing };
    $("trafficRate").textContent = traffic;
    $("cpuUsage").textContent = cpu;
    $("memoryUsage").textContent = memory;
    $("dbQueries").textContent = queries;
    $("dbConnections").textContent = connections;
    $("responseTime").textContent = response;
    $("networkIn").textContent = incoming + " Mbps";
    $("networkOut").textContent = outgoing + " Mbps";

    setBar("trafficBar", traffic, 160);
    setBar("cpuBar", cpu);
    setBar("memoryBar", memory);
    setBar("dbBar", queries, 120);
    setBar("connectionBar", connections);

    // Higher response times fill more of the indicator; values remain illustrative.
    setBar("responseBar", response, 300);

    history.incoming.push(incoming);
    history.outgoing.push(outgoing);
    if (history.incoming.length > maxSamples) history.incoming.shift();
    if (history.outgoing.length > maxSamples) history.outgoing.shift();

    updateServices();
    drawTrafficChart();
  }

  // Count interactions with the existing lock-service UI as simulated API activity.
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const monitoredIds = [
      "addTenantBtn", "renameTenantBtn", "deleteTenantBtn", "acquireBtn",
      "releaseBtn", "setLeaderBtn", "crashBtn", "recoverBtn", "clearBtn",
      "loadUseCaseBtn"
    ];
    if (monitoredIds.includes(button.id)) {
      recordApiCall(Math.random() > 0.035);
    }
  }, true);

  // Record one baseline sample and then refresh the demo metrics every 2 seconds.
  recordApiCall(true);
  updateMetrics();
  renderApiStats();
  setInterval(updateMetrics, 2000);
  window.addEventListener("resize", drawTrafficChart);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) drawTrafficChart();
  });
})();


async function sendLogToAWS(message, type = "LOCK_EVENT") {
  try {
    const response = await fetch(
      "/.netlify/functions/save-log",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: message,
          type: type
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("AWS error:", result);
      return false;
    }

    console.log("LockGuard AWS log saved:", result);
    return true;

  } catch (error) {
    console.error("AWS connection failed:", error);
    return false;
  }
}

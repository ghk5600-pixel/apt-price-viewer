const tokenInput = document.querySelector("#token");
const loginButton = document.querySelector("#loginButton");
const loginMessage = document.querySelector("#loginMessage");
const app = document.querySelector("#app");
const login = document.querySelector("#login");
const list = document.querySelector("#caseList");
const caseTemplate = document.querySelector("#caseTemplate");
const groupTemplate = document.querySelector("#groupTemplate");
const exportButton = document.querySelector("#exportButton");
let cases = [];
let token = sessionStorage.getItem("supply-admin-token") || "";

tokenInput.value = token;
loginButton.addEventListener("click", loadCases);
tokenInput.addEventListener("keydown", (event) => { if (event.key === "Enter") loadCases(); });
exportButton.addEventListener("click", exportCsv);
if (token) loadCases();

async function loadCases() {
  token = tokenInput.value.trim();
  loginMessage.textContent = "목록을 불러오는 중…";
  const response = await fetch("/api/admin/supply-cases", { headers: authHeaders() });
  const payload = await response.json();
  if (!response.ok) { loginMessage.textContent = payload.error || "인증에 실패했습니다."; return; }
  sessionStorage.setItem("supply-admin-token", token);
  cases = payload.cases || [];
  login.hidden = true; app.hidden = false; exportButton.disabled = false;
  document.querySelector("#caseCount").textContent = `${cases.length}건`;
  renderCases();
}

function renderCases() {
  list.replaceChildren();
  if (!cases.length) { list.textContent = "현재 검토가 필요한 공급면적 계산 실패 건이 없습니다."; return; }
  cases.forEach((item) => {
    const node = caseTemplate.content.cloneNode(true);
    const root = node.querySelector(".case"); root.dataset.key = item.complexKey;
    const metadata = item.request?.metadata || item.record?.metadata || {};
    root.querySelector(".badge").textContent = item.status === "manual-active" ? "수동값 적용" : "검토 필요";
    root.querySelector(".name").textContent = metadata.complexName || item.complexKey;
    root.querySelector(".address").textContent = metadata.roadAddress || metadata.lotAddress || "주소 정보 없음";
    root.querySelector(".detected").textContent = `최근 감지 ${formatDate(item.lastDetectedAt)}`;
    root.querySelector(".facts").innerHTML = factHtml(item, metadata);
    root.querySelector(".source-url").value = item.manualSourceUrl || "";
    root.querySelector(".note").value = item.manualNote || "";
    const groups = root.querySelector(".groups");
    (item.manualProfile?.profile?.groups || []).forEach((group) => addGroup(groups, group));
    if (!groups.children.length) addGroup(groups);
    root.querySelector(".add-group").addEventListener("click", () => addGroup(groups));
    root.querySelector(".save-manual").addEventListener("click", () => saveManual(root, item));
    list.append(root);
  });
}

function factHtml(item, metadata) {
  const expected = metadata.expectedHouseholds || "-";
  const reason = item.reasonCode || item.record?.errorDetails?.resultCode || "-";
  return `<dt>상태</dt><dd>${escapeHtml(item.status)}</dd><dt>실패 사유</dt><dd>${escapeHtml(reason)}</dd><dt>K-apt 세대수</dt><dd>${escapeHtml(expected)}세대</dd><dt>최초 감지</dt><dd>${formatDate(item.firstDetectedAt)}</dd>`;
}

function addGroup(container, group = {}) {
  const node = groupTemplate.content.cloneNode(true); const row = node.querySelector(".group-row");
  row.querySelector(".group-label").value = group.label || "";
  row.querySelector(".exclusive").value = group.targetExclusiveArea || "";
  row.querySelector(".supply").value = group.representativeSupplyArea || "";
  row.querySelector(".units").value = group.unitCount || "";
  row.querySelector(".remove-group").addEventListener("click", () => row.remove()); container.append(row);
}

async function saveManual(root, item) {
  const result = root.querySelector(".result");
  const groups = [...root.querySelectorAll(".group-row")].map((row) => ({ label: row.querySelector(".group-label").value, exclusiveArea: row.querySelector(".exclusive").value, supplyArea: row.querySelector(".supply").value, unitCount: row.querySelector(".units").value }));
  const response = await fetch("/api/admin/supply-cases", { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ action: "save-manual", complexKey: item.complexKey, sourceUrl: root.querySelector(".source-url").value, note: root.querySelector(".note").value, expectedHouseholds: item.request?.metadata?.expectedHouseholds, groups }) });
  const payload = await response.json(); result.textContent = response.ok ? "저장했습니다. 다음 사용자 조회부터 이 값이 적용됩니다." : (payload.error || "저장에 실패했습니다.");
  if (response.ok) await loadCases();
}

function exportCsv() { const rows = [["단지키","단지명","주소","상태","실패사유","최초감지","최근감지","수동출처","수동메모"]]; cases.forEach((item) => { const m = item.request?.metadata || item.record?.metadata || {}; rows.push([item.complexKey,m.complexName||"",m.roadAddress||m.lotAddress||"",item.status,item.reasonCode,item.firstDetectedAt,item.lastDetectedAt,item.manualSourceUrl||"",item.manualNote||""]); }); const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(csv).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }); const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `supply-review-${new Date().toISOString().slice(0,10)}.csv` }); link.click(); URL.revokeObjectURL(link.href); }
function authHeaders() { return { "x-supply-admin-token": token }; }
function csv(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function formatDate(value) { return value ? new Date(value).toLocaleString("ko-KR") : "-"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"})[ch]); }

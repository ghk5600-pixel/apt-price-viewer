import { createSupplyProfileStore } from "../../_shared/supply-store.js";
import { adminError, requireSupplyAdmin } from "../../_shared/supply-admin.js";
import { json } from "../../_shared/molit.js";
import { onRequestGet as calculateSupplyProfile } from "../supply-profile.js";

const MAX_RETRIES_PER_RUN = 10;

export async function onRequestPost({ request, env }) {
  try {
    requireSupplyAdmin(request, env);
    const store = await createSupplyProfileStore(env);
    const before = await store.listReviewCases();
    const retryResults = [];
    for (const item of before.filter((caseItem) => caseItem.status === "open").slice(0, MAX_RETRIES_PER_RUN)) {
      const retryRequest = buildRetryRequest(request.url, item);
      if (!retryRequest) continue;
      await store.noteAutoRetry(item.complexKey);
      const response = await calculateSupplyProfile({ request: retryRequest, env });
      retryResults.push({ complexKey: item.complexKey, status: response.status });
    }
    const cases = await store.listReviewCases();
    const digest = buildDigest(cases, retryResults);
    const sent = await sendTeamsDigest(env, digest);
    return json({ ok: true, sent, digest, retryResults });
  } catch (error) { return adminError(error); }
}

function buildRetryRequest(baseUrl, item) {
  const record = item.record || {};
  const source = record.requestedSource || record.source || {};
  const metadata = record.metadata || item.request?.metadata || {};
  if (!source.sigunguCd || !source.bjdongCd || !source.bun || !source.ji) return null;
  const url = new URL("/api/supply-profile", baseUrl);
  const values = { complexKey: item.complexKey, ...source, ...metadata, retry: "1" };
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value)); });
  return new Request(url, { headers: { "x-supply-maintenance": "1" } });
}

function buildDigest(cases, retryResults) {
  const open = cases.filter((item) => item.status === "open");
  const manual = cases.filter((item) => item.status === "manual-active");
  const sample = open.slice(0, 8).map((item) => {
    const metadata = item.request?.metadata || item.record?.metadata || {};
    return `${metadata.complexName || item.complexKey} · ${item.reasonCode || "UNKNOWN"}`;
  });
  return { generatedAt: new Date().toISOString(), openCount: open.length, manualCount: manual.length, retryCount: retryResults.length, sample };
}

async function sendTeamsDigest(env, digest) {
  const webhook = String(env?.TEAMS_WEBHOOK_URL || "");
  if (!webhook) return false;
  const reviewUrl = "https://apt-price-viewer.pages.dev/admin.html";
  const body = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "TextBlock", weight: "Bolder", size: "Medium", text: "공급면적 검토 요약" },
          { type: "TextBlock", wrap: true, text: `검토 필요 ${digest.openCount}건 · 수동값 적용 ${digest.manualCount}건 · 이번 자동 재시도 ${digest.retryCount}건` },
          ...(digest.sample.length ? [{ type: "TextBlock", wrap: true, spacing: "Medium", text: digest.sample.join("\n") }] : []),
        ],
        actions: [{ type: "Action.OpenUrl", title: "검토 목록 열기", url: reviewUrl }],
      },
    }],
  };
  const response = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Teams 알림 전송 실패 (HTTP ${response.status})`);
  return true;
}

import { createSupplyProfileStore } from "../../_shared/supply-store.js";
import { adminError, buildManualSupplyProfile, readJson, requireSupplyAdmin, SupplyAdminError } from "../../_shared/supply-admin.js";
import { json } from "../../_shared/molit.js";

export async function onRequestGet({ request, env }) {
  try {
    requireSupplyAdmin(request, env);
    const store = await createSupplyProfileStore(env);
    return json({ cases: await store.listReviewCases?.() || [], generatedAt: new Date().toISOString() });
  } catch (error) { return adminError(error); }
}

export async function onRequestPost({ request, env }) {
  try {
    requireSupplyAdmin(request, env);
    const body = await readJson(request);
    const complexKey = String(body.complexKey || "").trim();
    if (!complexKey) throw new SupplyAdminError("complexKey가 필요합니다.");
    const store = await createSupplyProfileStore(env);
    if (body.action === "save-manual") {
      const cases = await store.listReviewCases?.() || [];
      const existing = cases.find((item) => item.complexKey === complexKey);
      const manual = buildManualSupplyProfile(complexKey, body, existing?.record || {});
      if (!manual.sourceUrl) throw new SupplyAdminError("검증한 출처 URL을 입력하세요.");
      await store.putManualProfile(complexKey, manual, "admin");
      return json({ ok: true, profile: manual.profile });
    }
    if (body.action === "retry") {
      await store.noteAutoRetry?.(complexKey);
      return json({ ok: true, retryUrl: `/api/supply-profile?complexKey=${encodeURIComponent(complexKey)}&retry=1` });
    }
    throw new SupplyAdminError("지원하지 않는 작업입니다.");
  } catch (error) { return adminError(error); }
}

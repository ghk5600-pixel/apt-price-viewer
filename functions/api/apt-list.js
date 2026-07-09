import {
  assertRequired,
  buildAptListUrl,
  errorJson,
  fetchJsonApi,
  getSearchParam,
  json,
  normalizeItems,
  requireServiceKey,
} from "../_shared/molit.js";

export async function onRequestGet({ request, env }) {
  try {
    const serviceKey = requireServiceKey(env);
    const bjdCode = getSearchParam(request, "bjdCode");
    const pageNo = getSearchParam(request, "pageNo", "1");
    const numOfRows = getSearchParam(request, "numOfRows", "200");
    assertRequired({ bjdCode });

    const payload = await fetchJsonApi(buildAptListUrl({ serviceKey, bjdCode, pageNo, numOfRows }));
    const header = payload?.response?.header || {};
    if (header.resultCode && header.resultCode !== "00") {
      return errorJson(header.resultMsg || `AptList API error: ${header.resultCode}`, 502);
    }

    const body = payload?.response?.body || {};
    const items = normalizeItems(body.items).map((item) => ({
      kaptCode: String(item.kaptCode || ""),
      kaptName: String(item.kaptName || ""),
      bjdCode: String(item.bjdCode || ""),
      as1: String(item.as1 || ""),
      as2: String(item.as2 || ""),
      as3: String(item.as3 || ""),
      as4: String(item.as4 || ""),
    }));

    return json({
      items,
      pageNo: Number(body.pageNo || pageNo),
      numOfRows: Number(body.numOfRows || numOfRows),
      totalCount: Number(body.totalCount || items.length),
    });
  } catch (error) {
    return errorJson(error.message || "Apt list request failed.", 500);
  }
}

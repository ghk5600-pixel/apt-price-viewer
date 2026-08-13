import { fetchBuildingAreaPage } from "../_shared/molit.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sigunguCd = url.searchParams.get("sigunguCd");
  const bjdongCd = url.searchParams.get("bjdongCd");
  const platGbCd = url.searchParams.get("platGbCd") || "0";
  const bun = url.searchParams.get("bun");
  const ji = url.searchParams.get("ji");
  
  if (!sigunguCd) return new Response("Missing sigunguCd", { status: 400 });

  const serviceKey = env.MOLIT_SERVICE_KEY;
  if (!serviceKey) return new Response("No MOLIT_SERVICE_KEY", { status: 500 });

  try {
    const page = await fetchBuildingAreaPage(serviceKey, {
      sigunguCd,
      bjdongCd,
      platGbCd,
      bun,
      ji
    }, 1, 1000, context.passThroughOnException);
    
    return new Response(JSON.stringify(page, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}
